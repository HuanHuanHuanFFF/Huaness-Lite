# Reference 项目分析总览

这份文档不是逐仓库复读 README，而是回答一个问题：Huaness Lite 应该从这些项目里学什么，哪些不能照搬。

## 1. 总表

| 项目 | 阅读优先级 | 最值得学 | 不要误读 |
| --- | --- | --- | --- |
| `mini-swe-agent` | 最高，第一天读 | 最小 Agent loop，`Agent / Model / Environment` 边界 | 它的本地 shell 执行很轻，不能直接用于公网入口或外部 channel 服务 |
| `OpenClaw` | 最高，替代目标 | Gateway、channel、harness、session transcript、skills、tool policy | 不要搬完整插件生态和配置复杂度 |
| `Codex` | 高 | session/turn、typed events、approval、sandbox、rollout/resume | 生产复杂度很高，学控制面形状即可 |
| `Gemini CLI` | 高 | tool registry、scheduler、policy engine、evented agent stream | 不要被 Google auth、IDE、MCP、telemetry 细节带偏 |
| `OpenHands` | 中 | conversation/event/runtime/platform shell | 当前 checkout 的核心 loop 在外部 SDK 包里，不适合作为最小 loop 源码 |
| `Claude Code` | 中低 | commands、plugins、hooks、skills、permission examples | 公开仓库不包含核心 runtime/planner/loop 实现 |

## 2. mini-swe-agent：最小 loop 样本

核心结论：它是最适合入门的参考，因为主循环足够短，能直观看到模型、工具、观察值如何循环。

关键路径：

- `references/mini-swe-agent/src/minisweagent/agents/default.py`
  - `DefaultAgent`
  - `run()`
  - `step()`
  - `query()`
  - `execute_actions()`
- `references/mini-swe-agent/src/minisweagent/run/mini.py`
  - CLI 入口和运行对象组装
- `references/mini-swe-agent/src/minisweagent/models/litellm_model.py`
  - LLM 调用和 tool call 解析
- `references/mini-swe-agent/src/minisweagent/models/utils/actions_toolcall.py`
  - `bash` tool schema 和解析错误
- `references/mini-swe-agent/src/minisweagent/environments/local.py`
  - 本地命令执行环境
- `references/mini-swe-agent/tests/agents/test_default.py`
  - 完成、限制、超时、观察值、格式错误等测试

执行链路：

```text
mini CLI
  -> load config
  -> create model / environment / agent
  -> agent.run(task)
  -> append system + user messages
  -> query model
  -> parse bash action
  -> env.execute(action)
  -> append observation
  -> continue until exit / limits / error
```

Huaness Lite 应该采用：

- `Agent / Model / Environment` 的最小边界。
- append-only `messages` 作为最早期 session state。
- 明确的 `query()` 和 `execute_actions()` 两阶段。
- deterministic test model，用来测 loop 而不是每次真调 LLM。
- `step_limit / cost_limit / wall_time_limit` 这种停止保护。

Huaness Lite 暂缓：

- 多模型、多环境、多 benchmark。
- TUI 轨迹查看器。
- SWE-bench 批处理。

Huaness Lite 必须避免：

- 直接把模型输出的 shell 命令拿去执行。
- 用一个 magic stdout 标记作为长期 finish 协议。
- 以为“一个 bash tool”就等于完整工具系统。

## 3. OpenClaw：替代目标和系统形态

核心结论：OpenClaw 不是简单 UI，它是 gateway + channel + agent harness runtime。你的 Huaness Lite 要替代它，应该学它的边界，不是搬它的生态。

关键路径：

- `references/openclaw/docs/concepts/agent-loop.md`
  - OpenClaw 自己对 agent loop、event stream、session queue、hooks 的解释
- `references/openclaw/docs/concepts/agent-runtimes.md`
  - runtime、model provider、channel delivery 的职责划分
- `references/openclaw/src/gateway/server-methods.ts`
  - gateway request 授权和分发
- `references/openclaw/src/gateway/server-methods/agent.ts`
  - `agent` / `agent.wait` 风格入口
- `references/openclaw/src/gateway/server-methods/chat.ts`
  - UI chat 入口
- `references/openclaw/src/auto-reply/dispatch.ts`
  - 外部消息进入自动回复/Agent 调度
- `references/openclaw/src/agents/agent-command.ts`
  - session、workspace、model、skills、runtime 等运行前准备
- `references/openclaw/src/agents/harness/selection.ts`
  - harness 选择
- `references/openclaw/packages/agent-core/src/agent-loop.ts`
  - 核心模型/工具循环
- `references/openclaw/src/agents/agent-tools.policy.ts`
  - 工具策略
- `references/openclaw/src/config/sessions/transcript-append.ts`
  - transcript 写入
- `references/openclaw/src/skills/runtime/session-snapshot.ts`
  - skill snapshot
- `references/openclaw/extensions/telegram/src/channel.ts`
  - channel adapter 样本
- `references/openclaw/extensions/slack/src/channel.ts`
  - channel adapter 样本

执行链路：

```text
Gateway / channel adapter
  -> method registry and authorization
  -> chat.send or agent RPC
  -> ingress normalization
  -> agentCommandFromIngress
  -> prepareAgentCommandExecution
  -> selectAgentHarness
  -> runEmbeddedAgent or CLI provider
  -> runAgentLoop
  -> stream assistant response
  -> extract tool calls
  -> apply tool policy
  -> execute tools
  -> append tool results
  -> transcript / lifecycle events
```

Huaness Lite 应该采用：

- 一个很小的 `AgentHarness` contract，比如 `supports()` 和 `runAttempt()`。
- gateway method registry：方法名、scope、handler 明确分离。
- ingress adapter 和 agent execution 分离。
- `sessionKey / sessionId / transcript` 分离。
- 工具候选构造、策略过滤、schema 规范化、hook/logging 包装。
- `SKILL.md` 风格的技能发现，但只做 workspace/session snapshot 的轻量版。
- run/tool/lifecycle events 作为第一等 trace 数据。

Huaness Lite 暂缓：

- 完整 plugin marketplace。
- 多平台 channel 矩阵。
- 复杂 provider/model catalog/fallback。
- Slack/Telegram 原生审批 UX。
- ACP/CLI 兼容层。

Huaness Lite 必须避免：

- 网络入口继承本地 owner 权限。
- silent model override。
- shell/process tool 在 policy、approval、workspace 边界前暴露。
- channel/chat 状态直接混进 agent core。

## 4. Codex：控制面、权限和回放

核心结论：Codex 的核心价值是“模型不能直接行动”。所有输入是 typed submission，所有输出是 typed event，shell/patch 都经过 approval、permission profile、sandbox。

关键路径：

- `references/codex/codex-rs/protocol/src/protocol.rs`
  - `Submission`、`Op`、`EventMsg`
- `references/codex/codex-rs/protocol/src/models.rs`
  - `PermissionProfile`
- `references/codex/codex-rs/core/src/session/mod.rs`
  - session handle、submission loop、event delivery
- `references/codex/codex-rs/core/src/session/session.rs`
  - session 初始化、approval policy、persistence
- `references/codex/codex-rs/core/src/tasks/regular.rs`
  - turn task 执行
- `references/codex/codex-rs/core/src/session/turn.rs`
  - 模型循环
- `references/codex/codex-rs/core/src/tools/router.rs`
  - tool router
- `references/codex/codex-rs/core/src/tools/registry.rs`
  - tool registry dispatch
- `references/codex/codex-rs/core/src/tools/orchestrator.rs`
  - approval/sandbox/tool execution orchestration
- `references/codex/codex-rs/core/src/tools/handlers/shell.rs`
  - shell handler
- `references/codex/codex-rs/core/src/tools/handlers/apply_patch.rs`
  - patch handler
- `references/codex/codex-rs/core/src/session/rollout_reconstruction.rs`
  - resume/replay reconstruction

Huaness Lite 应该采用：

- typed `Submission / Op` 和 `Event` 边界。
- 每个 session 同一时间只有一个 active turn，支持 cancel。
- tool call 只能进统一 `ToolGateway`。
- approval + sandbox + execution 由一个 orchestrator 集中处理。
- patch/write 类工具要比普通 shell 更严格。
- append-only event history。
- 每个 run/tool/event 都要有 correlation id。

Huaness Lite 暂缓：

- MCP、guardian、复杂 app-server compatibility。
- full rollout reducer。
- 实时音频、多 Agent、插件系统。

Huaness Lite 必须避免：

- UI 状态和 core turn 状态混在一起。
- patch 当作普通 shell 命令。
- 只靠 console log，没有结构化事件。

## 5. Gemini CLI：事件流和工具调度

核心结论：Gemini CLI 适合学习“CLI Harness”结构。UI 很薄，core 拥有 model、tools、policy、events、memory、telemetry。

关键路径：

- `references/gemini-cli/packages/core/src/agent/types.ts`
  - agent event 类型
- `references/gemini-cli/packages/core/src/agent/agent-session.ts`
  - agent session stream
- `references/gemini-cli/packages/core/src/agent/legacy-agent-session.ts`
  - 主要 agent loop
- `references/gemini-cli/packages/core/src/core/client.ts`
  - model client、tools、history、memory
- `references/gemini-cli/packages/core/src/core/turn.ts`
  - streaming model output、function call 处理
- `references/gemini-cli/packages/core/src/tools/tool-registry.ts`
  - tool registry
- `references/gemini-cli/packages/core/src/scheduler/scheduler.ts`
  - tool scheduling
- `references/gemini-cli/packages/core/src/scheduler/tool-executor.ts`
  - tool execution
- `references/gemini-cli/packages/core/src/policy/policy-engine.ts`
  - policy engine
- `references/gemini-cli/packages/core/src/tools/shell.ts`
  - shell tool safety
- `references/gemini-cli/packages/core/src/services/chatRecordingService.ts`
  - durable chat JSONL
- `references/gemini-cli/evals/test-helper.ts`
  - eval runner pattern

Huaness Lite 应该采用：

- `send()` 返回 `streamId`，消费者读取 structured events。
- core/UI/channel 分离：核心只产事件，CLI/HTTP/IM/Web 只渲染事件和提交 approval。
- tool registry 给模型看 schema，scheduler 负责真实执行。
- fail-closed policy：非交互场景不能问用户时，`ASK_USER` 应变成 deny/error。
- append-only session recording。
- 最小 telemetry：session start、model turn、tool call、stop reason、token/error。

Huaness Lite 暂缓：

- MCP/discovered tools。
- subagents。
- 背景 shell process 管理。
- 大型 eval matrix。
- 复杂 memory distillation。

Huaness Lite 必须避免：

- 默认 `yolo`。
- approval 永久记忆但没有 scope、命令模式和可见性。
- 把 memory 理解成“把所有文件塞进 prompt”。

## 6. OpenHands：平台壳和事件存储

核心结论：当前 checkout 的完整 Agent loop 不在本仓库内，而是委托给 `openhands-agent-server` / `openhands-sdk` 等外部包。它仍然适合学 conversation、runtime、event persistence、export。

关键路径：

- `references/openhands/README.md`
  - 说明 SDK/CLI 源码在外部仓库
- `references/openhands/pyproject.toml`
  - pinned `openhands-agent-server` / `openhands-sdk`
- `references/openhands/openhands/app_server/app_conversation/app_conversation_models.py`
  - conversation models
- `references/openhands/openhands/app_server/app_conversation/app_conversation_router.py`
  - conversation API
- `references/openhands/openhands/app_server/app_conversation/live_status_app_conversation_service.py`
  - app-server controller facade
- `references/openhands/openhands/app_server/sandbox/sandbox_service.py`
  - sandbox interface
- `references/openhands/openhands/app_server/sandbox/process_sandbox_service.py`
  - local process sandbox reference
- `references/openhands/openhands/app_server/event/event_service_base.py`
  - event persistence
- `references/openhands/openhands/app_server/event/filesystem_event_service.py`
  - simplest event backend
- `references/openhands/openhands/app_server/event_callback/webhook_router.py`
  - event webhook callback

Huaness Lite 应该采用：

- conversation metadata 和 event trajectory 分离。
- slow startup 状态模型，比如 `WORKING -> STARTING_RUNTIME -> READY/ERROR`。
- runtime interface first：先本地 process runtime，后 Docker/remote。
- action/observation event model。
- exportable JSONL trajectory。

Huaness Lite 暂缓：

- Docker/remote/cloud 多 runtime。
- 多用户 sandbox ownership。
- SaaS analytics。
- 深度 DI 和 provider integrations。

Huaness Lite 必须避免：

- 一个进程能解决时，不要硬拆 webhook 微服务。
- frontend status 当 source of truth。
- secrets 写进 events/export。

## 7. Claude Code：公开仓库只能学扩展表面

核心结论：这个公开 checkout 不包含核心 runtime、planner、model loop、TUI、执行引擎。它适合学产品扩展形态：commands、plugins、agents、skills、hooks、MCP、settings、permission examples。

关键路径：

- `references/claude-code/README.md`
  - 产品定位和公开内容说明
- `references/claude-code/plugins/README.md`
  - plugin 结构
- `references/claude-code/plugins/plugin-dev/skills/command-development/SKILL.md`
  - slash command 设计
- `references/claude-code/plugins/plugin-dev/skills/plugin-structure/SKILL.md`
  - plugin manifest/目录
- `references/claude-code/plugins/plugin-dev/skills/hook-development/SKILL.md`
  - hooks
- `references/claude-code/plugins/plugin-dev/skills/mcp-integration/SKILL.md`
  - MCP integration
- `references/claude-code/examples/settings/settings-strict.json`
  - permission settings example
- `references/claude-code/scripts/gh.sh`
  - 外部 CLI wrapper
- `references/claude-code/plugins/feature-dev/commands/feature-dev.md`
  - phased workflow command
- `references/claude-code/plugins/code-review/commands/code-review.md`
  - multi-agent review workflow example

Huaness Lite 应该采用：

- 文件型扩展表面：`commands/`、`agents/`、`skills/`、`hooks/`。
- command frontmatter 明确 allowed tools、arguments、动态上下文。
- Hook checkpoint：before tool、after tool、stop、session start。
- 对危险外部工具做 wrapper，而不是裸调用。

Huaness Lite 暂缓：

- 多 Agent review flow。
- 大型插件市场。
- 深度安全审查插件。

Huaness Lite 必须避免：

- 以为这个仓库能证明 Claude Code 内部权限如何实现。
- 把插件示例当核心架构。
- 默认加入复杂自循环 stop hook。

## 8. Leader 审核后的总判断

六个 reference 可以分成三类：

第一类是核心 loop 参考：`mini-swe-agent`、`OpenClaw packages/agent-core`、`Gemini CLI legacy-agent-session`、`Codex turn`。这些回答“模型如何一轮轮决定和调用工具”。

第二类是控制面参考：`Codex`、`Gemini CLI`、`OpenClaw`。这些回答“工具如何被限制、记录、审批、恢复”。

第三类是产品/平台参考：`OpenHands`、`Claude Code`。这些回答“如何把 Agent 系统包装成可用平台和可扩展产品”，但不适合初学时当最小实现蓝本。

Huaness Lite 的合理路线是：用 `mini-swe-agent` 学会 loop，用 `Codex/Gemini` 设计工具和权限，用 `OpenClaw` 对齐替代目标，用 `OpenHands/Claude Code` 规划后续扩展。
