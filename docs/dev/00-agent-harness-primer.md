# Agent Harness 入门：Huaness Lite 先学什么

> 先记一句话：LLM 只是决策器，Harness 才是运行时和控制面。

你现在要做的不是“再包一层聊天入口”，而是一个能接多种入口、能执行任务、能记录过程、能控制风险、能复盘结果的 Agent Harness。CLI、HTTP、IM 都只是入口，真正的核心是：一次外部消息进来以后，系统如何把它变成一个受控的 Agent run。

## 1. 最小心智模型

一个 Agent 系统可以拆成两层：

- `Agent`：看起来像“会自己做事”的智能体。
- `Harness`：包住 Agent 的工程系统，负责输入、状态、工具、权限、执行、日志、恢复、评测。

LLM 本身不会真的读文件、跑 shell、连数据库、给外部平台发消息。它只会输出文本或结构化 tool call。真正执行动作的是 Harness。

所以 Huaness Lite 的核心价值不是“模型很聪明”，而是：

- 任何外部消息都能进入统一的 run。
- 任何工具调用都必须经过统一网关。
- 任何危险动作都能被策略拦截或要求确认。
- 任何结果都能被记录、回放、评测。
- 任何 channel，比如 CLI、HTTP、IM，都不污染核心 Agent loop。

## 2. 一条完整链路

以“某个外部 channel 收到一条整理服务器日志的请求”为例，核心链路应该是：

```text
ChannelAdapter
  -> Gateway / RunService
  -> SessionStore
  -> ContextBuilder
  -> ModelClient
  -> AgentLoop
  -> ToolGateway
  -> PolicyEngine / Approval
  -> ToolExecutor / Runtime
  -> Observation
  -> AgentLoop continues or finishes
  -> EventLog / Trace
  -> ChannelReplyAdapter
```

逐步解释：

1. `ChannelAdapter` 把外部平台事件转成内部消息，不直接碰模型和工具。
2. `Gateway / RunService` 创建一个 `runId`，决定这条消息属于哪个 `session`。
3. `SessionStore` 读取历史消息、会话配置、工作目录、用户权限。
4. `ContextBuilder` 组装 system prompt、用户消息、历史摘要、技能说明、可用工具。
5. `ModelClient` 调 LLM，得到普通回复或 tool call。
6. `AgentLoop` 判断模型输出：是要继续工具调用，还是可以结束。
7. `ToolGateway` 把模型给出的 tool call 转成可信的内部调用。
8. `PolicyEngine / Approval` 判断是否允许，比如读文件允许，删文件需要确认，访问系统目录拒绝。
9. `ToolExecutor / Runtime` 真正执行工具，返回 stdout、错误、结构化结果。
10. `Observation` 被写回上下文，下一轮再给模型看。
11. `EventLog / Trace` 把每一步记录成事件，方便回放和评测。
12. `ChannelReplyAdapter` 只负责把最终回复送回对应外部 channel。

## 3. Agent loop 到底是什么

最小 Agent loop 就是：

```text
while not stopped:
  context = build_context(session, run)
  model_output = model.generate(context, tools)

  if model_output has no tool calls:
    finish with assistant message

  for each tool_call:
    invocation = validate(tool_call)
    decision = policy.check(invocation, session)
    result = execute_or_reject(invocation, decision)
    append observation(result)
```

你可以把它理解成“模型负责想下一步，Harness 负责判断这一步能不能真的发生”。

## 4. 必须先掌握的词

| 概念 | 简单解释 | Huaness Lite 里为什么重要 |
| --- | --- | --- |
| `Session` | 一个长期会话，比如某个 CLI 会话、HTTP caller 或 IM 对话的上下文 | 保存历史、身份、配置、工作目录 |
| `Run` | 一次具体任务执行 | 每条用户指令都应该有 `runId` |
| `Turn / Step` | run 内部的一轮模型调用或工具调用 | 用来限制步数、追踪行为 |
| `Message` | 用户、助手、工具结果等上下文消息 | 是模型看到的主要输入 |
| `Tool` | 读文件、写文件、执行 shell、调用 HTTP 等能力 | 模型不能直接执行，只能请求 |
| `Tool Call` | 模型请求调用某个工具 | 必须验证 schema 和权限 |
| `Observation` | 工具执行结果 | 下一轮模型要基于它继续推理 |
| `Policy` | 允许、拒绝、需要确认的规则 | 个人服务器上尤其关键 |
| `Sandbox / Workspace` | 工具执行边界 | 防止工具越权读写系统 |
| `Event` | 一条结构化日志 | 用于回放、调试、面试展示 |
| `Trace / Trajectory` | 一次 run 的完整事件序列 | 证明系统可观测、可复盘 |
| `Eval` | 用固定任务测试 Agent 行为 | 证明不是“演示刚好成功” |
| `Adapter / Channel` | CLI、HTTP、IM 这种入口 | 入口要薄，核心要稳定 |
| `Harness` | 包住模型的控制系统 | 这是项目主角 |

## 5. 明天阅读顺序

不要按仓库名气读，按“学习曲线”读。

1. 先读 `mini-swe-agent`：它最小，能看懂 `run -> query -> execute_actions -> observation`。
2. 再读 `Gemini CLI`：重点看 tool registry、scheduler、policy、event stream。
3. 再读 `Codex`：重点看 submission/event、approval、sandbox、rollout/resume。
4. 再读 `OpenClaw`：它是你的替代目标，重点看 gateway、channel、harness、session transcript。
5. 再读 `OpenHands`：学平台壳、conversation/event/runtime，不要从它学最小 loop。
6. 最后读 `Claude Code`：这个公开仓库不是核心实现，主要学 commands/plugins/hooks/skills 的产品形态。

## 6. 看 reference 时只问五个问题

每个仓库都用同一组问题看：

1. 外部输入从哪里进入？
2. 会话状态保存在哪里？
3. 模型调用发生在哪里？
4. 工具调用经过谁批准、谁执行？
5. 过程如何记录、恢复、评测？

只要这五个问题答清楚，你就掌握了 Harness 思想。反过来，如果一个项目只有“模型回复”没有这些东西，它就只是 ChatBot，不是 Harness。

## 7. Huaness Lite 的一句定位

Huaness Lite 可以这样定义：

> 一个面向个人服务器和秋招展示的轻量 Agent Harness，支持 CLI/HTTP/IM 等 channel，以 run/session 管理、tool gateway、权限策略、事件追踪、回放评测为核心，用更小的工程量实现 OpenClaw-like 的关键能力。

这句话里真正重要的是 `轻量` 和 `关键能力`。不要一上来做完整插件市场、复杂多 Agent、Web UI 大屏、企业级 sandbox。先把核心链路做得可信。
