# @dingyi222666/dsh-wakatime

[![npm version](https://img.shields.io/npm/v/@dingyi222666/dsh-wakatime.svg)](https://www.npmjs.com/package/@dingyi222666/dsh-wakatime)
[![GitHub](https://img.shields.io/badge/GitHub-dingyi222666%2Fdsh--wakatime-181717?logo=github)](https://github.com/dingyi222666/dsh-wakatime)

English | [中文](README.zh.md)

为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 开发的 WakaTime 插件 —— 统计你的 AI 编码活动、代码行数与耗时。由 [opencode-wakatime](https://github.com/angristan/opencode-wakatime) 适配到 dsh 的插件模型。

## 安装

```sh
# 从 npm 安装（需要 dsh >= 0.1.3-alpha.2）
dsh plugin --profile web add @dingyi222666/dsh-wakatime
# 重启 dsh web 生效
dsh web
```

插件适用于任何运行 agent 循环的 profile —— `web`、`headless`、`acp`、`sdk`，以及桌面端的 `desktop` profile。每个要用的 profile 都需要安装一次：

```sh
dsh plugin --profile headless add @dingyi222666/dsh-wakatime
```

### 桌面端（Desktop 应用）

DeepSeek Harness 桌面端是基于同一套 Web host 的 Electron 外壳，但它独占一个独立的 profile（`$DSH_HOME/profiles/desktop`）与独立的包状态。需要用**应用内置的 CLI** 安装——npm 安装的 `dsh` 无法修改 Desktop profile：

```sh
# 1. 先启动一次 Desktop 让它初始化 profiles/desktop，然后完全退出应用。
# 2. 运行内置 CLI（下例为 macOS 路径；Windows 为 resources\runtime\cli\bin\dsh.cmd）：
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add @dingyi222666/dsh-wakatime
# 3. 重新打开 Desktop，bundle 补丁会在下次启动时生效。
```

同一命令也支持更新（`add @dingyi222666/dsh-wakatime@latest`）、`list` 与 `remove <package>`，并保留共享的 profile 写锁与兼容性检查。由于 Desktop host 与插件运行在同一个 Electron Node 进程中，插件采集的事件与 heartbeat 行为与 Web profile 完全一致。

### 从源码安装（GitHub）

```sh
git clone https://github.com/dingyi222666/dsh-wakatime
cd dsh-wakatime
pnpm install && pnpm run build
dsh plugin --profile web add .
dsh web
```

说明：

- `dsh plugin` 等同于向 profile 添加依赖。bundle 插件的完整包名出现在 profile 的 `dsh.profile.bundles` 列表后即被加载（自动添加）；bundle 补丁（`cordis.patch.yml`）在下一次启动时生效。
- 更新时重新执行相同命令即可。
- 使用仓库源码启动的 CLI 时，直接通过 bin 传入参数（`node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add @dingyi222666/dsh-wakatime`）。

### 配置

插件开箱即用。如需覆盖行为，在 profile 的用户补丁层
（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）或通过 `--patch` 声明同 id（`wakatime`）的配置行：

```yaml
- id: wakatime
  config:
    heartbeatIntervalMs: 120000  # 每项目限频间隔（默认 60000 毫秒）
    debug: true                  # 强制 DEBUG 日志（默认跟随 ~/.wakatime.cfg 的 debug=true）
    client: web                  # --plugin 字符串中的客户端限定名（默认 "dsh"）
    timeoutMs: 45000             # heartbeat CLI 超时（默认 30000 毫秒）
```

所有字段均可选，加载时由 schemastery schema 校验。

## 功能

- **自动管理 CLI** —— 自动下载并更新 `wakatime-cli`；检测到全局安装（`brew install wakatime-cli`）时直接使用
- **细粒度文件追踪** —— 追踪 agent 执行的文件操作：`edit`、`write`、`read`、`read_image`，以及 `str_replace_editor`（`view`/`create`/`str_replace`/`insert`）
- **解析路径准确性（dsh 0.1.3-alpha.1）** —— 优先读取 fs 工具持久化在 `tool/result` `meta` 中的信息：沙箱解析后的实际路径与精确 diff hunk；没有 meta 时回退到调用参数
- **精确的 write 结果语义（dsh 0.1.7-alpha.1）** —— `write` 结果新增 `operation`（`create`/`update`）标记：新建文件按内容行数计费，内容未变的覆写记 0 行变化（只发心跳）
- **跟随工作目录（dsh 0.2.1-alpha.2）** —— 跟随会话已提交的 `working-directory/change` 记录：切换工作目录后，heartbeat 的实体、`--project-folder`、相对路径解析与每项目限频配额都会随之切换
- **AI 编码指标** —— 发送 `--ai-line-changes` 供 WakaTime AI 编码分析使用；行数根据 fs 工具的 diff hunk 精确计算（上下文行已剔除）
- **实时活动 heartbeat（dsh 0.1.3-alpha.1）** —— 长时间回合流式输出期间，`agent/status` 状态切换与 `agent/assistant-stream` 事件流会以接近实时的节奏对当前文件发送 heartbeat，无需等待持久化结算事件
- **限频 heartbeat** —— 每个项目每分钟最多 1 次，状态持久化到磁盘，多个 dsh 进程共享配额（持久化变更与实时活动共用同一配额）
- **会话生命周期** —— 会话销毁与插件树卸载时强制冲刷待发送 heartbeat，单次 `dsh --profile headless` 运行也能上报
- **批量工具支持** —— 一次编辑涉及多个文件时，通过 `--extra-heartbeats` 在单次 `wakatime-cli` 调用中发送
- **零运行时依赖** —— 构建产物只依赖 Node 内置模块与宿主已提供的 `@deepseek-ai/*` peer 包

## 前置条件

### WakaTime API Key

在 `~/.wakatime.cfg`（或设置 `WAKATIME_HOME` 时的 `$WAKATIME_HOME/.wakatime.cfg`）中配置：

```ini
[settings]
api_key = waka_your_api_key_here
```

在 [WakaTime 设置](https://wakatime.com/api-key) 页面获取 API Key。

### WakaTime CLI（可选）

插件在缺失时会自动下载 `wakatime-cli`。也可以自行安装：

```bash
brew install wakatime-cli
```

或从 [WakaTime releases](https://github.com/wakatime/wakatime-cli/releases/latest) 下载。

## 工作原理

插件订阅 dsh 的会话事件流（`session/event`）：

- `tool/call` 按 `callId` 记录工具名与解析后的参数；`tool/result` 回查并读取 fs 工具持久化的 `meta` 载荷 —— 解析后的实体路径（`read`、`read_image`）、diff hunk（`edit`、`write`），
  以及 `write` 的结果标记（dsh 0.1.7-alpha.1 的 `operation`），得到每个 hunk 的精确增删行数；宿主未附加 meta 时回退到参数推导（`write` 内容、`str_replace_editor` 字符串）。
  `operation: update` 且 hunk 为空表示内容未变（记 0 行），`create` 则按写入内容行数计费。
  失败的结果一律不计费——包括 dsh 0.2.0 中 agent-loop 为未执行调用补写的合成恢复结果（recovery closers）。
- 每个项目每分钟最多发送一次 heartbeat（状态文件位于 `~/.wakatime/dsh-wakatime/`）；
  触发时机包括聊天活动、工具结果、已提交的模型结算（含 dsh 0.1.3-alpha.1 中无消息的 `assistant/attempt` 记录）、
  实时 agent 活动（`agent/status`、`agent/assistant-stream`）、turn 边界、会话销毁与插件卸载。
- 项目目录从会话 header 的 cwd 开始，并跟随已提交的 `working-directory/change` 记录（dsh 0.2.1-alpha.2），
  与 fs 工具实际解析所用的目录保持一致；每个目录各有独立的限频配额。
- `--plugin` 标签形如 `Deepseek Harness[-<client>]/<dsh 版本> dsh-wakatime/<版本>`。

## 开发

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run build       # 声明文件到 lib/types + tsdown 打包 lib/index.js
pnpm test            # vitest：changes、state、heartbeat、插件接线
```

目录结构：

- `src/index.ts` —— 插件入口（`name` / `Config` / `apply`）与事件接线
- `src/config.ts` —— schemastery `Config` schema、默认值、`--plugin` 标签
- `src/changes.ts` —— 工具事件 → 文件变更、diff 行数统计
- `src/state.ts` —— 每项目限频
- `src/heartbeat.ts` —— `wakatime-cli` 调用、批量发送、冲刷
- `src/cli.ts` —— `wakatime-cli` 发现/下载/更新
- `src/paths.ts`、`src/logger.ts` —— WakaTime 路径与文件日志
- `tests/` —— 单元测试 + 基于真实 cordis `Context` 的集成测试

## 已知限制

- 沙箱/远程文件系统中的工具调用按其模型可见的 `file_path` 参数追踪，除非 `tool/result` 的 `meta` 携带解析后的绝对路径（dsh 0.1.3-alpha.1 的 fs 工具会携带）；解析路径与沙箱不一致时可能
  以项目相对路径记录。
- `bash` 命令不归因到具体文件（可能改动任意内容）。
- 当 `@deepseek-ai/dsh` 无法从插件位置解析时（例如 npm 安装缺少 dev 依赖），`--plugin` 标签中的
  dsh 版本显示为 `unknown`。
- `@deepseek-ai/dsh-session`/`@deepseek-ai/dsh-agent` 的 peer 范围从 `0.1.3-alpha.1` 起；更老的宿主仍能运行
  追踪路径，但没有实时 agent 活动 heartbeat。

## 许可证

MIT —— 移植逻辑来自 [opencode-wakatime](https://github.com/angristan/opencode-wakatime)（MIT）。
