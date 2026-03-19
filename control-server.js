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
        processMatch: raw.control?.processMatch || null
      },
      paths: raw.paths || {},
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

async function getProjectRuntimeState(project) {
  const state = getState(project.id);

  if (!project.health) {
    return state;
  }

  const running = await probeUrl(project.health);
  const process = running ? findRunningProcess(project) : null;

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
    timeline: project.timeline,
    runtime
  };
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

    if (project.health && mode === "run") {
      return;
    }

    state.running = false;
    state.pid = null;
  });

  if (project.health && mode === "run") {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const running = await probeUrl(project.health);
    state.running = running;

    if (!running) {
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
