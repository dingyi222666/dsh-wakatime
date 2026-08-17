# @dingyi222666/dsh-wakatime

[![npm version](https://img.shields.io/npm/v/@dingyi222666/dsh-wakatime.svg)](https://www.npmjs.com/package/@dingyi222666/dsh-wakatime)
[![GitHub](https://img.shields.io/badge/GitHub-dingyi222666%2Fdsh--wakatime-181717?logo=github)](https://github.com/dingyi222666/dsh-wakatime)

English | [中文](README.zh.md)

为 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 开发的 WakaTime 插件 —— 统计你的 AI 编码活动、代码行数与耗时。由 [opencode-wakatime](https://github.com/angristan/opencode-wakatime) 适配到 dsh 的插件模型。

## 安装

```sh
# 从 npm 安装（需要 dsh >= 0.1.0-rc.6）
dsh plugin --profile web add @dingyi222666/dsh-wakatime
# 重启 dsh web 生效
dsh web
```

插件适用于任何运行 agent 循环的 profile —— `web`、`headless`、`tui` 等。每个要用的 profile 都需要安装一次：

```sh
dsh plugin --profile headless add @dingyi222666/dsh-wakatime
```

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
- **细粒度文件追踪** —— 追踪 agent 执行的文件操作：`edit`、`write`、`read`，以及 `str_replace_editor`（`view`/`create`/`str_replace`/`insert`）
- **AI 编码指标** —— 发送 `--ai-line-changes` 供 WakaTime AI 编码分析使用；行数根据 fs 工具的 diff hunk 精确计算（上下文行已剔除）
- **限频 heartbeat** —— 每个项目每分钟最多 1 次，状态持久化到磁盘，多个 dsh 进程共享配额
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

- `tool/call` 按 `callId` 记录工具名与解析后的参数；`tool/result` 回查并读取 fs 工具私有的 `meta` diff hunk，
  得到每个 hunk 的精确增删行数（`edit`、`write`），或从参数推导（`write` 内容、`str_replace_editor` 字符串）。
- 每个项目每分钟最多发送一次 heartbeat（状态文件位于 `~/.wakatime/dsh-wakatime/`）；
  触发时机包括聊天活动、turn 边界、会话销毁与插件卸载。
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

- 沙箱/远程文件系统中的工具调用按其模型可见的 `file_path` 参数追踪；解析路径与沙箱不一致时可能
  以项目相对路径记录。
- `bash` 命令不归因到具体文件（可能改动任意内容）。
- 当 `@deepseek-ai/dsh` 无法从插件位置解析时（例如 npm 安装缺少 dev 依赖），`--plugin` 标签中的
  dsh 版本显示为 `unknown`。

## 许可证

MIT —— 移植逻辑来自 [opencode-wakatime](https://github.com/angristan/opencode-wakatime)（MIT）。
