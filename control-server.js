const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");

const PORT = 4321;
const WORKSPACE_ROOT = "E:/Project/codex";
const PROJECT_CONFIG_NAME = "project.config.json";
const EXCLUDED_DIRS = new Set(["dashboard"]);
const states = new Map();

function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  withCors(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp"
  };

  withCors(res);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function trimOutput(text) {
  return String(text || "").slice(-6000);
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
}

function getState(projectId) {
  if (!states.has(projectId)) {
    states.set(projectId, {
      running: false,
      pid: null,
      mode: null,
      startedAt: null,
      lastExitCode: null,
      lastError: null,
      lastOutput: "",
      finishedAt: null
    });
  }

  return states.get(projectId);
}

function resolveProjectPath(projectDir, relativePath) {
  if (!relativePath) {
    return "";
  }

  if (/^[A-Za-z]:[\\/]/.test(relativePath)) {
    return relativePath.replace(/\\/g, "/");
  }

  return path.join(projectDir, relativePath).replace(/\\/g, "/");
}

function resolveReports(projectDir, reports) {
  if (!reports || typeof reports !== "object") {
    return {};
  }

  const resolved = {};
  for (const [name, report] of Object.entries(reports)) {
    if (!report || typeof report !== "object") {
      continue;
    }

    resolved[name] = {
      ...report,
      path: resolveProjectPath(projectDir, report.path || "")
    };
  }

  return resolved;
}

function discoverProjects() {
  const entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const projectDir = path.join(WORKSPACE_ROOT, entry.name);
    const configPath = path.join(projectDir, PROJECT_CONFIG_NAME);
    if (!fs.existsSync(configPath)) {
      continue;
    }

    const raw = safeReadJson(configPath);
    if (!raw || !raw.id) {
      continue;
    }

    const project = {
      id: raw.id,
      name: raw.name || raw.id,
      category: raw.category || "工具类",
      type: raw.type || "tool",
      status: raw.status || "draft",
      summary: raw.summary || "",
      description: raw.description || raw.summary || "",
      path: resolveProjectPath(projectDir, raw.path || projectDir),
      entry: raw.entry || "",
      health: raw.health || "",
      integration: raw.integration || "project-config",
      control: {
        enabled: Boolean(raw.control?.enabled),
        type: raw.control?.type || raw.type || "tool",
        actions: Array.isArray(raw.control?.actions) ? raw.control.actions : [],
        testCommand: raw.control?.testCommand || null,
        runCommand: raw.control?.runCommand || null,
        stopCommand: raw.control?.stopCommand || null,
        processMatch: raw.control?.processMatch || null,
        startupProbe: raw.control?.startupProbe || null
      },
      paths: raw.paths || {},
      reports: resolveReports(projectDir, raw.reports),
      timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
      cwd: projectDir.replace(/\\/g, "/")
    };

    projects.push(project);
  }

  projects.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return projects;
}

function getProjectMap() {
  const projects = discoverProjects();
  const map = new Map();
  for (const project of projects) {
    map.set(project.id, project);
  }
  return map;
}

function findRunningProcess(project) {
  const match = project?.control?.processMatch;
  if (!match) {
    return null;
  }

  const script = [
    "$process = Get-CimInstance Win32_Process | Where-Object {",
    `  $_.Name -eq '${match.name}' -and`,
    `  $_.CommandLine -like '${match.commandLinePattern}'`,
    "} | Select-Object -First 1 ProcessId, Name, CommandLine",
    "if ($process) {",
    "  $process | ConvertTo-Json -Compress",
    "}"
  ].join("\n");

  const result = spawnSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    cwd: project.cwd,
    windowsHide: true,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  const output = String(result.stdout || "").trim();
  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output);
    return {
      pid: parsed.ProcessId || null,
      name: parsed.Name || null,
      commandLine: parsed.CommandLine || null
    };
  } catch (error) {
    return null;
  }
}

function probeUrl(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(false);
      return;
    }

    const client = url.startsWith("https://") ? https : http;
    const request = client.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("error", () => resolve(false));
    request.setTimeout(4000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, startupProbe) {
  const probe = startupProbe || {};
  const initialDelayMs = Number(probe.initialDelayMs) > 0 ? Number(probe.initialDelayMs) : 3000;
  const attempts = Number(probe.attempts) > 0 ? Number(probe.attempts) : 1;
  const intervalMs = Number(probe.intervalMs) > 0 ? Number(probe.intervalMs) : 3000;

  await wait(initialDelayMs);

  for (let index = 0; index < attempts; index += 1) {
    const running = await probeUrl(url);
    if (running) {
      return true;
    }

    if (index < attempts - 1) {
      await wait(intervalMs);
    }
  }

  return false;
}

async function waitForHealthOrExit(url, startupProbe, exitPromise) {
  const probe = startupProbe || {};
  const initialDelayMs = Number(probe.initialDelayMs) > 0 ? Number(probe.initialDelayMs) : 3000;
  const attempts = Number(probe.attempts) > 0 ? Number(probe.attempts) : 1;
  const intervalMs = Number(probe.intervalMs) > 0 ? Number(probe.intervalMs) : 3000;

  const waitOrExit = async (delayMs) => {
    return Promise.race([
      wait(delayMs).then(() => ({ exited: false, code: null })),
      exitPromise.then((code) => ({ exited: true, code }))
    ]);
  };

  const firstWait = await waitOrExit(initialDelayMs);
  if (firstWait.exited) {
    return { running: false, exitCode: firstWait.code };
  }

  for (let index = 0; index < attempts; index += 1) {
    const running = await probeUrl(url);
    if (running) {
      return { running: true, exitCode: null };
    }

    if (index < attempts - 1) {
      const nextWait = await waitOrExit(intervalMs);
      if (nextWait.exited) {
        return { running: false, exitCode: nextWait.code };
      }
    }
  }

  return { running: false, exitCode: null };
}

async function getProjectRuntimeState(project) {
  const state = getState(project.id);
  const process = findRunningProcess(project);

  if (!project.health) {
    return {
      ...state,
      running: Boolean(process?.pid || state.running),
      pid: process?.pid || (state.running ? state.pid : null)
    };
  }

  const healthRunning = await probeUrl(project.health);
  const running = project.control?.processMatch
    ? (healthRunning && Boolean(process?.pid))
    : healthRunning;

  if (running && process?.pid) {
    state.pid = process.pid;
  }

  return {
    ...state,
    running,
    pid: running ? (process?.pid || state.pid) : null
  };
}

async function getProjectView(project) {
  const runtime = project.control.enabled
    ? await getProjectRuntimeState(project)
    : getState(project.id);

  let status = project.status;
  if (runtime.running) {
    status = "running";
  } else if (runtime.lastExitCode && runtime.lastExitCode !== 0) {
    status = "warning";
  }

  return {
    id: project.id,
    name: project.name,
    category: project.category,
    type: project.type,
    status,
    summary: project.summary,
    description: project.description,
    path: project.path,
    entry: project.entry,
    health: project.health,
    integration: project.integration,
    control: {
      enabled: project.control.enabled,
      type: project.control.type,
      actions: project.control.actions
    },
    paths: project.paths,
    reports: project.reports,
    timeline: project.timeline,
    runtime
  };
}

function resolveReportArtifact(baseDir, relativePath) {
  if (!relativePath) {
    return "";
  }

  return path.join(baseDir, relativePath).replace(/\\/g, "/");
}

function stringifyBlock(payload) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return String(payload || "");
  }
}

function normalizeMailHistoryEntry(reportPath, entry) {
  const reportBaseDir = path.dirname(path.dirname(reportPath));
  const artifacts = entry?.artifacts || {};
  const deliveryResultPath = resolveReportArtifact(reportBaseDir, artifacts.deliveryResultJson || "");
  const emailHtmlPath = resolveReportArtifact(reportBaseDir, artifacts.emailHtml || "");
  const deliveryResult = deliveryResultPath ? safeReadJson(deliveryResultPath) : null;
  const emailHtml = emailHtmlPath ? safeReadText(emailHtmlPath) : "";
  const content = entry?.content || {};
  const topStories = Array.isArray(content.topStories) ? content.topStories : [];
  const recommended = Array.isArray(content.recommended) ? content.recommended : [];
  const failures = Array.isArray(entry?.failures) ? entry.failures : [];
  const recipients = entry?.recipients || {};

  const links = [...topStories, ...recommended]
    .filter((item) => item?.url)
    .map((item) => ({
      label: item.title || item.url,
      url: item.url
    }));

  const summaryLines = topStories.length
    ? topStories.map((item, index) => `${index + 1}. ${item.title || "Untitled"}`).join("\n")
    : "No generated stories.";
  const failureLines = failures.length
    ? failures.map((item) => `- ${item.recipient || "unknown"}: ${item.error || "unknown error"}`).join("\n")
    : "No failures.";

  return {
    id: entry?.runId || "",
    title: entry?.subject || "Daily AI Brief",
    finishedAt: entry?.finishedAt || entry?.startedAt || "",
    status: entry?.status || "unknown",
    mode: entry?.runMode || "",
    meta: [
      { label: "Recipients", value: `${recipients.success || 0}/${recipients.total || 0}` },
      { label: "Delivery Rate", value: recipients.deliveryRate === null || recipients.deliveryRate === undefined ? "N/A" : `${recipients.deliveryRate}%` },
      { label: "Source News", value: String(entry?.newsCount || 0) },
      { label: "Admin", value: String(recipients.adminCount || 0) },
      { label: "Feishu", value: String(recipients.feishuCount || 0) }
    ],
    emailHtml,
    links,
    logBlocks: [
      { label: "Run Result", text: entry?.message || "No message." },
      { label: "Top Stories", text: summaryLines },
      { label: "Commentary", text: content.commentary || "No commentary." },
      { label: "Failures", text: failureLines },
      { label: "Raw Log", text: deliveryResult ? stringifyBlock(deliveryResult) : "No structured delivery log." }
    ]
  };
}

function buildMusicTopicLines(topics) {
  if (!Array.isArray(topics) || !topics.length) {
    return "No generated topics.";
  }

  return topics.map((topic, index) => {
    const points = Array.isArray(topic.content_points)
      ? topic.content_points.map((item) => `- ${item}`).join("\n")
      : "No content points.";

    return [
      `${index + 1}. ${topic.title || "Untitled topic"}`,
      `Angle: ${topic.angle || "-"}`,
      `Category: ${topic.category || "-"}`,
      `Reason: ${topic.reason || "-"}`,
      "Content Points:",
      points
    ].join("\n");
  }).join("\n\n");
}

function buildMusicTopicHistory(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return [];
  }

  const dayDirs = fs.readdirSync(reportPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const items = [];

  for (const dayDir of dayDirs) {
    const dayPath = path.join(reportPath, dayDir);
    const runDirs = fs.readdirSync(dayPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const runDir of runDirs) {
      const runPath = path.join(dayPath, runDir);
      const summary = safeReadJson(path.join(runPath, "run_summary.json")) || {};
      const topics = safeReadJson(path.join(runPath, "topics.json")) || [];
      const hotspots = safeReadJson(path.join(runPath, "hotspots.json")) || [];
      const validation = safeReadJson(path.join(runPath, "validation.json")) || {};
      const emailHtml = safeReadText(path.join(runPath, "email_preview.html"));

      const links = Array.isArray(hotspots)
        ? hotspots
          .filter((item) => item?.url)
          .slice(0, 20)
          .map((item) => ({
            label: `[${item.source || "Source"}] ${item.title || item.url}`,
            url: item.url
          }))
        : [];

      items.push({
        id: `${dayDir}-${runDir}`,
        title: `Music Topics ${dayDir} ${runDir}`,
        finishedAt: summary.finished_at || `${dayDir}T${runDir.slice(0, 2)}:${runDir.slice(2, 4)}:${runDir.slice(4, 6)}`,
        status: summary.sent ? "success" : "preview",
        mode: summary.mode || "preview",
        meta: [
          { label: "Hotspots", value: String(summary.hotspots_count || hotspots.length || 0) },
          { label: "Topics", value: String(summary.topics_count || topics.length || 0) },
          { label: "Mode", value: summary.mode || "preview" },
          { label: "Sent", value: summary.sent ? "Yes" : "No" }
        ],
        emailHtml,
        links,
        logBlocks: [
          { label: "Topic Summary", text: buildMusicTopicLines(topics) },
          { label: "Run Summary", text: stringifyBlock(summary) },
          { label: "Validation", text: stringifyBlock(validation) }
        ]
      });
    }
  }

  return items;
}

function getReportData(project, reportName) {
  const report = project.reports?.[reportName];
  if (!report) {
    return { ok: false, statusCode: 404, error: "No report found" };
  }

  if (!report.path) {
    return { ok: false, statusCode: 409, error: "Report path is not configured" };
  }

  if (!fs.existsSync(report.path)) {
    return {
      ok: true,
      statusCode: 200,
      report,
      data: null
    };
  }

  let data = null;
  if (report.type === "mail-history") {
    const raw = safeReadJson(report.path);
    data = Array.isArray(raw) ? raw.map((entry) => normalizeMailHistoryEntry(report.path, entry)) : [];
  } else if (report.type === "music-topic-history") {
    data = buildMusicTopicHistory(report.path);
  } else {
    data = safeReadJson(report.path);
  }

  if (data === null) {
    return {
      ok: false,
      statusCode: 500,
      error: "Report file is not valid JSON"
    };
  }

  return {
    ok: true,
    statusCode: 200,
    report,
    data
  };
}

const REDBOOK_AUTO_ID = "redbook-auto";
const REDBOOK_IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isRedbookAutoProject(project) {
  return project?.id === REDBOOK_AUTO_ID;
}

function isPathInside(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getRedbookAutoQueueRoot(project) {
  return resolveProjectPath(project.cwd, project.paths?.queue || "queue");
}

function getRedbookAutoLoginCommand(project) {
  return {
    command: "powershell",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "scripts/login.ps1"
    ],
    cwd: project.cwd
  };
}

function listFilesDeep(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesDeep(fullPath));
      continue;
    }

    results.push(fullPath);
  }

  return results;
}

function collectRedbookAutoImages(itemDir, meta) {
  const requestedImages = Array.isArray(meta?.images) ? meta.images : [];
  if (requestedImages.length) {
    return requestedImages.map((imagePath) => {
      if (/^[A-Za-z]:[\\/]/.test(imagePath)) {
        return imagePath.replace(/\\/g, "/");
      }

      return path.join(itemDir, imagePath).replace(/\\/g, "/");
    });
  }

  return listFilesDeep(itemDir)
    .filter((filePath) => REDBOOK_IMAGE_SUFFIXES.has(path.extname(filePath).toLowerCase()))
    .map((filePath) => filePath.replace(/\\/g, "/"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function summarizeRedbookAutoError(errorData) {
  if (!errorData) {
    return "";
  }

  if (typeof errorData === "string") {
    return errorData;
  }

  const candidates = [
    errorData.message,
    errorData.error,
    errorData.reason,
    errorData.details,
    errorData.stderr
  ].filter(Boolean);

  return candidates.length ? String(candidates[0]) : stringifyBlock(errorData);
}

function buildRedbookAutoQueueItem(itemDir, bucket) {
  const meta = safeReadJson(path.join(itemDir, "meta.json")) || {};
  const published = safeReadJson(path.join(itemDir, "published.json")) || null;
  const error = safeReadJson(path.join(itemDir, "error.json")) || null;
  const images = collectRedbookAutoImages(itemDir, meta);
  const stat = fs.statSync(itemDir);

  return {
    id: path.basename(itemDir),
    bucket,
    title: String(meta.title || path.basename(itemDir)),
    content: String(meta.content || ""),
    tags: Array.isArray(meta.tags) ? meta.tags.map((tag) => String(tag)) : [],
    images,
    imageCount: images.length,
    path: itemDir.replace(/\\/g, "/"),
    updatedAt: stat.mtime.toISOString(),
    publishedAt: published?.publishedAt || published?.time || published?.createdAt || "",
    error: summarizeRedbookAutoError(error)
  };
}

function readRedbookAutoBucket(project, bucket, options = {}) {
  const queueRoot = getRedbookAutoQueueRoot(project);
  const bucketDir = path.join(queueRoot, bucket);
  const sort = options.sort || (bucket === "pending" ? "asc" : "desc");
  const limit = Number.isFinite(options.limit) ? options.limit : 20;

  if (!fs.existsSync(bucketDir)) {
    return [];
  }

  const items = fs.readdirSync(bucketDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));

  if (sort === "desc") {
    items.reverse();
  }

  return items
    .slice(0, limit)
    .map((dirName) => buildRedbookAutoQueueItem(path.join(bucketDir, dirName), bucket));
}

function countRedbookAutoBucket(project, bucket) {
  const queueRoot = getRedbookAutoQueueRoot(project);
  const bucketDir = path.join(queueRoot, bucket);

  if (!fs.existsSync(bucketDir)) {
    return 0;
  }

  return fs.readdirSync(bucketDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .length;
}

function getRedbookAutoStatus(project) {
  const cliPath = path.join(project.cwd, "xhs-mcp-fix", "dist", "xhs-mcp.js");
  if (!fs.existsSync(cliPath)) {
    return {
      ok: false,
      loggedIn: false,
      message: `xhs-mcp CLI 不存在：${cliPath.replace(/\\/g, "/")}`
    };
  }

  const result = spawnSync("node", [cliPath, "status", "--compact"], {
    cwd: project.cwd,
    windowsHide: true,
    encoding: "utf8"
  });

  const output = trimOutput(`${result.stdout || ""}${result.stderr || ""}`.trim());
  if (result.status !== 0) {
    return {
      ok: false,
      loggedIn: false,
      message: output || "读取登录状态失败"
    };
  }

  try {
    const parsed = JSON.parse(String(result.stdout || "{}"));
    return {
      ok: true,
      loggedIn: Boolean(parsed.loggedIn),
      message: parsed.loggedIn ? "已登录" : "需要登录"
    };
  } catch (error) {
    return {
      ok: false,
      loggedIn: false,
      message: output || "登录状态返回内容无法识别"
    };
  }
}

async function getRedbookAutoOverview(project) {
  const runtime = await getProjectRuntimeState(project);
  const pendingItems = readRedbookAutoBucket(project, "pending", { sort: "asc", limit: 50 });
  const publishedItems = readRedbookAutoBucket(project, "published", { sort: "desc", limit: 10 });
  const failedItems = readRedbookAutoBucket(project, "failed", { sort: "desc", limit: 10 });

  return {
    ok: true,
    projectId: project.id,
    login: getRedbookAutoStatus(project),
    runtime,
    counts: {
      pending: countRedbookAutoBucket(project, "pending"),
      published: countRedbookAutoBucket(project, "published"),
      failed: countRedbookAutoBucket(project, "failed")
    },
    pendingItems,
    recentPublished: publishedItems.slice(0, 5),
    recentFailed: failedItems.slice(0, 5)
  };
}

function runDetachedCommand(commandConfig) {
  return new Promise((resolve) => {
    const child = spawn(commandConfig.command, commandConfig.args || [], {
      cwd: commandConfig.cwd,
      windowsHide: false
    });

    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        error: error.message,
        output: trimOutput(output)
      });
    });

    child.on("exit", (code) => {
      resolve({
        ok: code === 0,
        message: code === 0 ? "登录流程已完成" : "登录没有完成",
        output: trimOutput(output),
        exitCode: code
      });
    });
  });
}

async function loginRedbookAuto(project) {
  const runtime = await getProjectRuntimeState(project);
  if (runtime.running) {
    return {
      ok: false,
      error: "发布任务正在运行，请先停止，再登录。"
    };
  }

  return runDetachedCommand(getRedbookAutoLoginCommand(project));
}

function resolveRedbookAutoImagePath(project, rawPath) {
  if (!rawPath) {
    return null;
  }

  const basePath = path.resolve(project.cwd);
  const candidatePath = /^[A-Za-z]:[\\/]/.test(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(project.cwd, rawPath);

  if (!isPathInside(basePath, candidatePath)) {
    return null;
  }

  if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
    return null;
  }

  if (!REDBOOK_IMAGE_SUFFIXES.has(path.extname(candidatePath).toLowerCase())) {
    return null;
  }

  return candidatePath;
}

function getCommandForMode(project, mode) {
  if (mode === "test") {
    return project.control.testCommand;
  }
  if (mode === "run") {
    return project.control.runCommand;
  }
  if (mode === "stop") {
    return project.control.stopCommand;
  }
  return null;
}

async function runProject(project, mode) {
  const state = getState(project.id);
  const runtimeState = await getProjectRuntimeState(project);

  if (runtimeState.running) {
    if (mode === "run") {
      return {
        ok: true,
        pid: runtimeState.pid,
        mode,
        message: "系统已经在运行了，不需要重复启动。"
      };
    }
    return { ok: false, error: "项目正在运行中" };
  }

  const commandConfig = getCommandForMode(project, mode);
  if (!commandConfig) {
    return { ok: false, error: `项目没有配置 ${mode} 命令` };
  }

  const child = spawn(commandConfig.command, commandConfig.args || [], {
    cwd: project.cwd,
    windowsHide: true
  });
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  state.running = true;
  state.pid = child.pid;
  state.mode = mode;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastExitCode = null;
  state.lastError = null;
  state.lastOutput = "";

  child.stdout.on("data", (chunk) => {
    state.lastOutput = trimOutput(`${state.lastOutput}${chunk.toString()}`);
  });

  child.stderr.on("data", (chunk) => {
    state.lastOutput = trimOutput(`${state.lastOutput}${chunk.toString()}`);
  });

  child.on("error", (error) => {
    state.lastError = error.message;
  });

  child.on("exit", (code) => {
    state.lastExitCode = code;
    state.finishedAt = new Date().toISOString();
    state.running = false;
    state.pid = null;
  });

  if (project.health && mode === "run") {
    const startup = await waitForHealthOrExit(
      project.health,
      project.control.startupProbe,
      exitPromise
    );
    state.running = startup.running;

    if (!startup.running) {
      state.pid = null;
      return {
        ok: false,
        error: "服务启动后健康检查失败",
        output: state.lastOutput
      };
    }

    const process = findRunningProcess(project);
    if (process?.pid) {
      state.pid = process.pid;
    }
  }

  return {
    ok: true,
    pid: state.pid,
    mode
  };
}

function stopProject(project) {
  const state = getState(project.id);
  const commandConfig = getCommandForMode(project, "stop");

  if (commandConfig) {
    const stopper = spawn(commandConfig.command, commandConfig.args || [], {
      cwd: project.cwd,
      windowsHide: true
    });

    return new Promise((resolve) => {
      let output = "";

      stopper.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });

      stopper.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });

      stopper.on("exit", (code) => {
        state.running = false;
        state.pid = null;
        state.finishedAt = new Date().toISOString();
        resolve({
          ok: code === 0,
          message: trimOutput(output || "已经发送停止命令")
        });
      });
    });
  }

  if (!state.running || !state.pid) {
    return { ok: false, error: "当前没有运行中的任务" };
  }

  const killer = spawn("taskkill", ["/PID", String(state.pid), "/T", "/F"], {
    windowsHide: true
  });

  return new Promise((resolve) => {
    let output = "";

    killer.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    killer.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    killer.on("exit", (code) => {
      state.running = false;
      state.pid = null;
      state.finishedAt = new Date().toISOString();
      resolve({
        ok: code === 0,
        message: trimOutput(output || "已经发送停止命令")
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  withCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, port: PORT });
    return;
  }

  const projectMap = getProjectMap();

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const projects = [];
    for (const project of projectMap.values()) {
      projects.push(await getProjectView(project));
    }
    sendJson(res, 200, {
      ok: true,
      workspaceRoot: WORKSPACE_ROOT.replace(/\\/g, "/"),
      projects
    });
    return;
  }

  const projectId = url.searchParams.get("id");
  if (!projectId) {
    sendJson(res, 400, { ok: false, error: "缺少项目 id" });
    return;
  }

  const project = projectMap.get(projectId);
  if (!project) {
    sendJson(res, 404, { ok: false, error: "没有找到这个项目" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/project") {
    sendJson(res, 200, {
      ok: true,
      project: await getProjectView(project)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/report") {
    const reportName = url.searchParams.get("name");
    if (!reportName) {
      sendJson(res, 400, { ok: false, error: "缂哄皯鎶ュ憡鍚嶅瓧" });
      return;
    }

    const result = getReportData(project, reportName);
    sendJson(res, result.statusCode, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/redbookauto/overview") {
    if (!isRedbookAutoProject(project)) {
      sendJson(res, 409, { ok: false, error: "这个项目不是小红书发布项目" });
      return;
    }

    sendJson(res, 200, await getRedbookAutoOverview(project));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/redbookauto/login") {
    if (!isRedbookAutoProject(project)) {
      sendJson(res, 409, { ok: false, error: "这个项目不是小红书发布项目" });
      return;
    }

    const result = await loginRedbookAuto(project);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/redbookauto/image") {
    if (!isRedbookAutoProject(project)) {
      sendJson(res, 409, { ok: false, error: "这个项目不是小红书发布项目" });
      return;
    }

    const rawPath = url.searchParams.get("path");
    const filePath = resolveRedbookAutoImagePath(project, rawPath || "");
    if (!filePath) {
      sendJson(res, 404, { ok: false, error: "图片不存在，或者路径不合法" });
      return;
    }

    sendFile(res, filePath);
    return;
  }

  if (!project.control.enabled) {
    sendJson(res, 409, { ok: false, error: "这个项目还没有开放控制按钮" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      ok: true,
      projectId,
      state: await getProjectRuntimeState(project)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test") {
    const result = await runProject(project, "test");
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    const result = await runProject(project, "run");
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const result = await stopProject(project);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "接口不存在" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Control server running at http://127.0.0.1:${PORT}`);
});
