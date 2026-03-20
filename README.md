# Dashboard-AIs

这是整套 AI 系统的“总控制台”。

它做的事情很简单：

1. 扫描 `E:\Project\codex` 下面的真实项目。
2. 读取每个项目自己的 `project.config.json`。
3. 在网页里展示这些项目。
4. 通过控制服务，把“测试运行 / 真实运行 / 停止”这些按钮，变成真按钮。

这份 README 主要写给：

- 以后接手这套系统的 AI
- 以后维护这套系统的人
- 以后要往里面继续加项目的人

如果你只是想自己点按钮使用系统，请看：

- [04-使用指南-给本人看.md](/E:/Project/codex/dashboard/docs/04-使用指南-给本人看.md)

## 1. 这套系统到底是什么

它不是一个“单体大项目”。

它更像一个“项目总控台”：

- `dashboard` 负责统一入口、统一展示、统一控制。
- `E:\Project\codex` 下面的每个子文件夹，都是一个独立项目。
- 每个独立项目保留自己的业务代码。
- `dashboard` 不接管业务细节，只接管“发现、展示、启动、停止、状态”。

所以这套系统的核心原则是：

- 一个项目只做一件事。
- 一个项目一个文件夹。
- 一个项目一个 `project.config.json`。
- 总台不直接改业务逻辑，总台只调项目自己的脚本。

## 2. 现在的真实目录结构

```text
E:/Project/codex/
├─ dashboard/                  总台本体
├─ AdVideoSystem/              AI 视频翻拍系统
├─ MusicNews/                  每日音乐选题
├─ TransPaper/                 论文翻译服务
└─ RedbookAuto/                小红书自动发布
```

`dashboard` 里面当前最重要的文件：

```text
dashboard/
├─ README.md
├─ control-server.js
├─ index.html
├─ project.html
├─ projects.js
├─ project.config.template.json
├─ start-dashboard.cmd
├─ start-dashboard.ps1
├─ start-control-server.ps1
├─ stop-control-server.ps1
└─ docs/
```

## 3. dashboard 是怎么运转的

### 3.1 前端页面

- [index.html](/E:/Project/codex/dashboard/index.html)
  负责项目总列表。
- [project.html](/E:/Project/codex/dashboard/project.html)
  负责单个项目详情页和控制按钮。
- [projects.js](/E:/Project/codex/dashboard/projects.js)
  只放全局配置，比如工作区根目录和 API 地址。

前端本身不保存项目列表。

前端启动后，会去请求：

- `GET /api/projects`
- `GET /api/project?id=...`
- `GET /api/status?id=...`
- `POST /api/test?id=...`
- `POST /api/run?id=...`
- `POST /api/stop?id=...`

### 3.2 控制服务

- [control-server.js](/E:/Project/codex/dashboard/control-server.js)

它是整个系统的“中控脑子”。

它负责：

1. 扫描 `E:\Project\codex`
2. 找到每个项目里的 `project.config.json`
3. 生成项目列表
4. 执行项目的 `test/run/stop` 命令
5. 对服务类项目做健康检查
6. 在内存里保存最近一次运行状态

### 3.3 启动方式

真正推荐的启动入口是：

- [start-dashboard.cmd](/E:/Project/codex/dashboard/start-dashboard.cmd)

它会先启动控制服务，再打开 dashboard 页面。

不要只双击 `index.html`。

如果只打开静态页面，按钮会因为找不到控制服务而失效。

## 4. 项目是怎么被发现的

### 4.1 自动发现规则

控制服务会扫描：

- `E:\Project\codex\*`

它会跳过：

- 隐藏目录
- `dashboard`

只有满足这条规则的目录才会被识别成项目：

- 目录里存在 `project.config.json`

### 4.2 项目门牌

最小模板在：

- [project.config.template.json](/E:/Project/codex/dashboard/project.config.template.json)

真实项目最关键的字段有：

```json
{
  "id": "project-id",
  "name": "项目名字",
  "category": "工具类",
  "type": "service",
  "status": "draft",
  "summary": "一句话说明",
  "description": "更完整说明",
  "path": "E:/Project/codex/project-id",
  "entry": "",
  "health": "",
  "integration": "project-config",
  "control": {
    "enabled": true,
    "type": "service",
    "actions": ["test", "run", "stop"],
    "testCommand": {
      "command": "powershell",
      "args": ["-File", "scripts/test.ps1"]
    },
    "runCommand": {
      "command": "powershell",
      "args": ["-File", "scripts/run.ps1"]
    },
    "stopCommand": {
      "command": "powershell",
      "args": ["-File", "scripts/stop.ps1"]
    }
  }
}
```

## 5. 现在已经接好的项目

### 5.1 AI 视频翻拍系统

- 仓库路径：`E:\Project\codex\AdVideoSystem`
- 类型：`service`
- 当前状态：已接好，已跑通真实处理

### 5.2 每日音乐选题

- 仓库路径：`E:\Project\codex\MusicNews`
- 类型：`batch`
- 当前状态：已接好，已跑通真实业务链

### 5.3 论文翻译服务

- 仓库路径：`E:\Project\codex\TransPaper`
- 类型：`service`
- 当前状态：已接好，默认走 Google 翻译，开箱可用

### 5.4 小红书自动发布

- 仓库路径：`E:\Project\codex\RedbookAuto`
- 类型：`queue-worker`
- 当前状态：已接好按钮和 Windows 控制链
- 特殊说明：第一次真实运行时，小红书平台要求真人扫码登录一次

## 6. 新项目要怎么接进来

如果以后要加新项目，按这个顺序做。

### 第一步：建独立项目目录

比如：

```text
E:/Project/codex/MyNewProject
```

### 第二步：给项目补 3 个脚本

最好有：

- `scripts/test.ps1`
- `scripts/run.ps1`
- `scripts/stop.ps1`

规则：

- `test.ps1` 只做检查，不做破坏性操作。
- `run.ps1` 负责真正启动。
- `stop.ps1` 负责停掉相关进程。

### 第三步：写 `project.config.json`

把项目的名字、分类、按钮、入口地址、健康检查地址写进去。

### 第四步：重开 dashboard

只要文件放对了，总台就会自己发现它。

不用再去手写项目列表。

## 7. 如果以后要改系统，优先改哪里

### 改“总台展示”

优先看：

- [index.html](/E:/Project/codex/dashboard/index.html)
- [project.html](/E:/Project/codex/dashboard/project.html)
- [projects.js](/E:/Project/codex/dashboard/projects.js)

### 改“按钮控制”

优先看：

- [control-server.js](/E:/Project/codex/dashboard/control-server.js)

### 改“单个项目接入”

优先看对应项目里的：

- `project.config.json`
- `scripts/test.ps1`
- `scripts/run.ps1`
- `scripts/stop.ps1`

不要先去动总台核心。

先把项目自己的脚本跑通，再接总台。

## 8. AI 修改这套系统时必须遵守的规则

这是给以后任何 AI 的硬规则。

### 8.1 先画边界，再改代码

先回答这 5 件事：

1. 目标是什么
2. 会改哪些文件
3. 风险是什么
4. 怎么验证
5. 怎么回滚

### 8.2 先最小改动

不要一上来就大重构。

优先策略：

- 先让按钮变真
- 先让服务能起
- 先让状态能看
- 最后再统一外观

### 8.3 总台不要接管业务代码

正确方式：

- 总台调用项目脚本

错误方式：

- 把项目业务代码搬进 `dashboard`
- 让 `dashboard` 直接依赖项目内部函数

### 8.4 不要碰这些目录

默认不要改这些目录，除非任务明确要求：

- `E:\Project\codex\dashboard\.git`
- `E:\Project\codex\dashboard\.runtime`
- `E:\Project\codex\dashboard\output`
- 所有项目里的 `.venv`
- 所有项目里的 `node_modules`
- 所有项目里的 `__pycache__`
- 所有项目里的 `logs`
- 所有项目里的真实 `queue` 内容
- 所有项目里的用户配置文件和密钥文件

### 8.5 不要把密钥写进代码

所有密钥都应该留在：

- 项目自己的配置文件
- 环境变量

不要写进：

- `control-server.js`
- 前端页面
- Git 仓库里的公开文件

## 9. 常见排错方法

### 9.1 页面能打开，但按钮点了没反应

先检查是不是用了正确入口：

- [start-dashboard.cmd](/E:/Project/codex/dashboard/start-dashboard.cmd)

### 9.2 项目出现在列表里，但按钮是灰的

说明这个项目虽然被发现了，但 `project.config.json` 里还没开控制。

先检查：

- `control.enabled`
- `control.actions`

### 9.3 服务项目显示启动成功，但网页打不开

优先看：

- `health`
- `startupProbe`
- `stop.ps1`
- `processMatch`

### 9.4 批处理项目点了运行，马上失败

优先看：

- `scripts/run.ps1`
- 项目自己的日志
- `dashboard` 状态里的 `lastOutput`

## 10. 推荐的维护顺序

如果以后还要继续整合，推荐顺序是：

1. 先保证每个项目都有标准脚本和 `project.config.json`
2. 再补状态和停止逻辑
3. 再补统一日志入口
4. 最后统一视觉和交互

## 11. 一句话总结

这套系统的关键不是“把所有业务揉成一个大项目”。

真正的关键是：

- 保持每个项目独立
- 用 `dashboard` 做统一入口
- 用标准脚本和标准门牌把它们接起来

只要以后继续坚持这条规则，这套系统就能一直长下去，不会再乱。
