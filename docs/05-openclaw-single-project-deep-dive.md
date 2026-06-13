# OpenClaw 单项目机制讲解

这份文档只讲 OpenClaw，一个目标：帮你理解它为什么是 `gateway + channel + agent harness runtime`，而不是一个普通聊天入口。

阅读 OpenClaw 时不要从插件数量开始看。它太大，直接读目录会迷路。正确方式是抓住一条主链：

```text
External channel / UI / CLI
  -> Gateway method
  -> session/run resolution
  -> agentCommandFromIngress / agentCommand
  -> runEmbeddedAgent
  -> select AgentHarness
  -> agent-core loop
  -> tool policy / execution / hooks
  -> transcript / event stream
  -> channel reply delivery
```

## 1. 一句话理解 OpenClaw

OpenClaw 是一个多入口、多 runtime、多插件的 Agent Gateway。

它解决的不是“怎么调一次模型”，而是：

1. 外部消息从不同 channel 进来，如何归一成一次 session/run。
2. 同一个 session 内如何串行执行，避免上下文和 transcript 打架。
3. 模型如何在 loop 中调用工具，工具如何被 policy 和 hooks 拦住。
4. 过程如何变成 stream event、transcript、diagnostics。
5. 不同 agent runtime，比如内置 OpenClaw、Codex、Copilot、CLI backend，如何接到统一 gateway 上。

Huaness Lite 应该学 OpenClaw 的边界，不要学它的体量。

## 2. 大结构地图

OpenClaw 的关键目录可以按职责理解：

| 目录 | 职责 | Huaness Lite 对应 |
| --- | --- | --- |
| `src/gateway` | RPC 方法表、鉴权、scope、client 连接、UI/控制面入口 | `gateway/` |
| `src/gateway/server-methods` | `agent`、`agent.wait`、`chat.send`、`sessions`、`tools` 等 handler | `gateway/methods` |
| `src/channels` | channel 框架、inbound/outbound、message runtime、thread/session 绑定 | `channels/` |
| `extensions/*/src/channel.ts` | 具体 channel 插件，比如 Telegram/Slack | `channels/onebot` 这类插件 |
| `src/auto-reply` | 外部消息进入自动回复/Agent 调度和回复 delivery | `channel -> gateway -> reply` |
| `src/agents` | agent command、model/tool/runtime、sandbox、subagent、compaction 等 | `core/` + `tools/` + `runtime/` |
| `src/agents/harness` | AgentHarness contract、runtime 选择、内置/插件 harness | `core/harness` |
| `src/agents/embedded-agent-runner` | 真正跑 embedded agent 的大编排层 | `core/run-manager` |
| `packages/agent-core` | 更纯的 agent loop、message、tool call、JSONL session storage | `core/agent-loop` |
| `src/config/sessions` / `src/transcripts` | session store、transcript append、JSONL、write lock | `storage/` |
| `src/skills` | skill snapshot、prompt 注入、runtime session state | `extensions/skills` |
| `src/plugins` / `src/plugin-sdk` | 插件注册、hooks、channel SDK、runtime SDK | P1/P2 插件系统 |

最重要的是：OpenClaw 把“入口”和“执行”拆开。channel 不应该直接跑 agent，gateway 不应该直接跑 shell，agent loop 不应该知道具体聊天平台。

## 3. Gateway：统一入口和控制面

关键文件：

- `references/openclaw/src/gateway/server-methods.ts`
- `references/openclaw/src/gateway/methods/registry.ts`
- `references/openclaw/src/gateway/server-methods/agent.ts`
- `references/openclaw/src/gateway/server-methods/chat.ts`

`server-methods.ts` 做的是 method registry 聚合。它把很多 handler family lazy-load 进来，比如：

- `agent`
- `agents`
- `channels`
- `chat`
- `exec-approvals`
- `sessions`
- `skills`
- `tools-catalog`
- `tools-effective`
- `tools-invoke`

同时它还负责 role/scope 鉴权。也就是说，OpenClaw 不是随便暴露一堆 HTTP 路由，而是有一层统一的 Gateway method table：

```text
method name
  -> descriptor
  -> role/scope check
  -> lazy handler family
  -> handler(opts)
```

对 Huaness Lite 的启发：

1. P0 也应该有 `Gateway.dispatch(method, input, ctx)`。
2. 方法名要比 HTTP 路由更稳定，比如 `agent.run`、`agent.wait`、`runs.get`。
3. 权限检查放 Gateway，不要散落到每个 channel。
4. handler 可以懒加载，但 P0 不必做 OpenClaw 这么复杂。

## 4. `agent` / `agent.wait`：run 和等待语义

OpenClaw 的 agent 概念不是“发消息等回复”这么简单。

官方概念文档 `docs/concepts/agent-loop.md` 里描述的语义是：

```text
agent RPC
  -> validate params
  -> resolve sessionKey/sessionId
  -> persist session metadata
  -> return { runId, acceptedAt } immediately
  -> background agent command starts

agent.wait
  -> wait for lifecycle end/error of runId
  -> return ok/error/timeout
```

这非常关键：`agent` 创建一次 run，`agent.wait` 只是等待。这能让外部入口、UI、后台任务都用同一个 run 模型。

Huaness Lite P0 应该直接采用这个思想：

```ts
agent.run(input) -> { runId, acceptedAt }
agent.wait(runId, timeoutMs) -> { status, result? }
```

不要把 P0 写成一个只能同步返回文本的 `chat()`。

## 5. `chat.send` 和 channel 入口

关键文件：

- `references/openclaw/src/gateway/server-methods/chat.ts`
- `references/openclaw/src/auto-reply/dispatch.ts`
- `references/openclaw/src/plugin-sdk/channel-inbound.ts`
- `references/openclaw/src/plugin-sdk/channel-outbound.ts`
- `references/openclaw/extensions/telegram/src/channel.ts`
- `references/openclaw/extensions/slack/src/channel.ts`

`chat.ts` 是 UI/chat RPC 的入口。它处理很多现实问题：

- chat history
- attachment/media
- abort
- session metadata
- transcript projection
- streaming state
- inbound dispatch

`auto-reply/dispatch.ts` 是外部消息进入自动回复/Agent 调度的编排层。它会处理 hook、reply dispatcher、foreground reply fence、visible delivery 等。

具体 channel 插件，比如 Telegram/Slack，不直接碰 AgentLoop。它们围绕 `createChatChannelPlugin`、inbound/outbound adapter、account、group policy、approval capability、status/probe、send runtime 组织。

Huaness Lite 只需要学这个边界：

```text
Channel plugin
  -> normalize inbound event
  -> Gateway.dispatch(...)
  -> receive OutboundMessage
  -> deliver to platform
```

不要学 OpenClaw 的完整 channel SDK。P0 的 `ChannelAdapter` 可以很小：

```ts
interface ChannelAdapter {
  name: string;
  start(ctx: ChannelRuntimeContext): Promise<void>;
  deliver(message: OutboundMessage): Promise<void>;
}
```

## 6. `agentCommand`：本地可信入口 vs 网络入口

关键文件：

- `references/openclaw/src/agents/agent-command.ts`

这里有一个值得你特别学的安全边界：

```ts
agentCommand(...)
agentCommandFromIngress(...)
```

`agentCommand` 是本地 CLI/可信 operator 入口，所以默认 `senderIsOwner: true`，并允许 per-run model override。

`agentCommandFromIngress` 是网络/channel/gateway 入口，它强制要求调用方显式传 `allowModelOverride`，并且不会默认把 sender 当 owner。

这背后的设计思想是：

```text
本地 CLI 输入 != 网络 channel 输入
owner 权限不能从入口类型里隐式继承
model override 不能被外部消息默认使用
```

Huaness Lite 应该照抄这个原则，不一定照抄代码：

1. `CliChannel` 可以默认 owner。
2. `HttpChannel` 和 IM channel 默认非 owner。
3. model/profile override 只能由可信 client 或显式 admin scope 发起。
4. 外部 channel 只能提供身份线索，不能直接决定权限。

## 7. AgentHarness：runtime 插拔机制

关键文件：

- `references/openclaw/src/agents/harness/types.ts`
- `references/openclaw/src/agents/harness/selection.ts`
- `references/openclaw/src/agents/harness/builtin-openclaw.ts`

OpenClaw 的 `AgentHarness` 是正式 contract，不只是概念。

核心形态：

```ts
type AgentHarness = {
  id: string;
  label: string;
  supports(ctx): AgentHarnessSupport;
  runAttempt(params): Promise<AgentHarnessAttemptResult>;
  compact?(params): Promise<...>;
  reset?(params): Promise<void>;
  dispose?(): Promise<void>;
};
```

`selection.ts` 根据 provider/model/runtime policy 选择 harness：

1. 如果 runtime 是 `openclaw`，用内置 harness。
2. 如果 runtime 是明确插件，插件必须支持当前 provider/model，否则 fail closed。
3. 如果 runtime 是 `auto`，从注册的 plugin harness 里选支持者，否则回退内置 OpenClaw。
4. CLI backend alias 和 embedded harness id 是两回事。

Huaness Lite P0 不需要多 runtime，但可以保留这个心智模型：

```ts
interface AgentHarness {
  id: string;
  supports(profile: ModelProfile): boolean;
  runAttempt(input: RunAttemptInput): Promise<RunAttemptResult>;
}
```

先只实现 `BuiltinHuanessHarness`。等 P1 再考虑 Codex/Claude CLI/ACP 这种外部 runtime。

## 8. Embedded Agent Runner：大编排层

关键文件：

- `references/openclaw/src/agents/embedded-agent-runner.ts`
- `references/openclaw/src/agents/embedded-agent-runner/run.ts`
- `references/openclaw/src/agents/embedded-agent-runner/runs.ts`
- `references/openclaw/src/agents/embedded-agent-subscribe.ts`

`embedded-agent-runner.ts` 是 barrel，真正的编排在 `embedded-agent-runner/run.ts`。

它做的事情很多：

- resolve model/provider/auth profile
- ensure runtime plugins loaded
- ensure context engines initialized
- resolve session lane and global lane
- resolve sandbox/workspace
- select agent harness
- build runtime plan
- run attempt
- handle failover/retry/idle timeout/context overflow
- compaction
- usage accumulation
- register active run
- cleanup

`runs.ts` 管 active run、abort、waiter、queue message、abandoned run。也就是 OpenClaw 的 run lifecycle registry。

`embedded-agent-subscribe.ts` 把 agent runtime event 翻译成对外可用的 assistant/tool/lifecycle stream，同时处理：

- assistant delta buffering
- reasoning stream
- tool metadata
- block reply
- final payload
- messaging tool duplicate suppression
- liveness state
- replay state

Huaness Lite P0 不应该复制这层复杂度。你应该拆出最小版本：

```text
RunManager
  -> create run
  -> register active run
  -> per-session queue
  -> call AgentLoop
  -> write EventLog
  -> finish/fail/cancel
```

OpenClaw 的这层提醒你：Agent run 不只是函数调用，它是有生命周期的系统资源。

## 9. agent-core loop：最值得学习的核心

关键文件：

- `references/openclaw/packages/agent-core/src/agent-loop.ts`
- `references/openclaw/packages/agent-core/src/types.ts`
- `references/openclaw/packages/agent-core/src/validation.ts`

这是 OpenClaw 里最接近“纯 Agent loop”的部分。

主循环的核心结构：

```text
runAgentLoop
  -> emit agent_start / turn_start
  -> append prompt messages
  -> runLoop

runLoop
  -> inject steering/followup messages
  -> streamAssistantResponse
  -> collect assistant message
  -> find tool calls
  -> executeToolCalls
  -> append tool result messages
  -> emit turn_end
  -> prepareNextTurn
  -> shouldStopAfterTurn?
  -> repeat
```

Tool call 执行链路：

```text
assistant toolCall
  -> find tool definition
  -> prepare arguments
  -> validateToolArguments
  -> beforeToolCall hook
  -> tool.execute(...)
  -> tool_execution_update events
  -> afterToolCall hook
  -> ToolResultMessage
```

这里有几个很关键的设计点：

1. 模型只产生 tool call，不直接执行。
2. tool args 先 schema validate。
3. 执行前后有 hook。
4. tool result 作为 message 回到 context。
5. tool 可以返回 `terminate`，影响 loop 是否继续。
6. loop 支持 steering/followup，不只是一次性任务。

Huaness Lite P0 可以直接按这个结构写简化版。

## 10. Tool policy：工具候选和权限过滤

关键文件：

- `references/openclaw/src/agents/agent-tools.policy.ts`
- `references/openclaw/src/agents/agent-tools.before-tool-call.ts`
- `references/openclaw/src/agents/bash-tools.exec-approval-request.ts`
- `references/openclaw/src/agents/tool-policy.ts`
- `references/openclaw/src/agents/tool-policy-match.ts`

OpenClaw 的工具策略很复杂。它会综合：

- provider/model 的工具策略
- agent config
- group/channel policy
- sender policy
- subagent depth/capability
- inherited allow/deny
- sandbox tool policy
- hooks

你不需要照搬这些维度，但要学它的控制方向：

```text
tools candidate list
  -> policy filtering
  -> model sees allowed schema only
  -> before_tool_call can block/modify
  -> exec/write/network need approval or sandbox policy
  -> result is sanitized/truncated/persisted
```

Huaness Lite P0 最小可做：

```ts
type PermissionProfile = "read_only" | "workspace_write" | "full_access";

PolicyEngine.evaluate({
  toolName,
  args,
  channel,
  session,
  workspace,
  permissionProfile,
}) -> allow | deny | ask
```

重点不是策略多复杂，而是所有工具必须经过同一条硬路径。

## 11. Transcript / Session：JSONL 和写锁

关键文件：

- `references/openclaw/packages/agent-core/src/harness/session/jsonl-storage.ts`
- `references/openclaw/src/config/sessions/transcript-append.ts`
- `references/openclaw/src/agents/session-write-lock.ts`

OpenClaw 的 transcript 不是普通数组。它是可追加、可迁移、可锁定的 JSONL。

`jsonl-storage.ts` 做了几件事：

- 第一行必须是 `session` header。
- 每行都是 JSON entry。
- 读取时逐行 parse 和 validate。
- append entry 时只追加一行。

`transcript-append.ts` 更现实：

- 确保 transcript header。
- 兼容旧的 linear transcript。
- 迁移成 parent-linked entries。
- per-file append queue 保证进程内顺序。
- external session write lock 保证跨进程顺序。
- redaction 后再写 transcript。

`session-write-lock.ts` 用 lock file、owner metadata、stale detection、signal cleanup、watchdog 来序列化写入。

Huaness Lite P0 建议：

1. 不做 parent-linked transcript，先做 per-run JSONL。
2. 每个 run 文件 append-only。
3. 每个 session 一个串行队列。
4. 事件必须有 `runId/sessionId/seq/type/ts`。
5. P1 再做 SQLite 索引和跨进程 lock。

## 12. Hooks / Skills / Plugins

OpenClaw 的 hooks 很强，但也很重。

概念文档里列了很多 hook：

- `before_model_resolve`
- `before_prompt_build`
- `before_agent_reply`
- `agent_end`
- `before_compaction` / `after_compaction`
- `before_tool_call` / `after_tool_call`
- `message_received` / `message_sending` / `message_sent`
- `session_start` / `session_end`
- `gateway_start` / `gateway_stop`

对 Huaness Lite 来说，不要 P0 做完整 hook 系统。可以只保留三个稳定扩展点：

```text
beforeContextBuild
beforeToolCall
afterToolCall
```

Skills 也一样。OpenClaw 的 skill snapshot 和 prompt 注入值得学，但 P0 可以只做：

```text
skills/<name>/SKILL.md
  -> load text
  -> inject into system/context
  -> record skill snapshot in EventLog
```

## 13. OpenClaw 的完整执行链

把上面的机制串起来，可以这样理解：

```text
1. Channel/UI/CLI 收到输入
2. Gateway handler 验证 method + role + scope
3. chat.send 或 agent RPC 解析 sessionKey/sessionId
4. agent RPC 创建 runId，立即返回 accepted
5. agentCommandFromIngress 区分网络入口权限
6. prepareAgentCommandExecution 解析 model/workspace/skills/runtime
7. runEmbeddedAgent 进入 session lane/global lane
8. selectAgentHarness 选择 openclaw/codex/copilot 等 runtime
9. AgentHarness.runAttempt 调 agent-core loop 或外部 runtime
10. loop 组装 context，调用模型，解析 tool call
11. tool policy + hooks + approval/sandbox 处理工具
12. tool result 写回 context，loop 继续
13. subscribeEmbeddedAgentSession 翻译 assistant/tool/lifecycle stream
14. transcript/EventLog 写入事实
15. channel reply delivery 把最终结果送回外部入口
16. agent.wait 观察 lifecycle end/error
```

这条链就是你要学的 Harness 思想。

## 14. Huaness Lite 应该学什么

### Adopt

1. `agent.run` / `agent.wait` 分离。
2. session/run 分离。
3. 每个 session 串行 run。
4. Gateway method registry。
5. ChannelAdapter 只做 normalize/deliver。
6. AgentLoop 只处理 model/tool/observation。
7. ToolGateway + PolicyEngine 是硬路径。
8. JSONL append-only EventLog。
9. Fake model + replay/eval。
10. 本地 CLI 与网络入口权限不同。

### Defer

1. 完整 plugin marketplace。
2. 多 runtime selection。
3. Codex/Copilot/ACP runtime。
4. parent-linked transcript。
5. cross-process write lock。
6. compaction/retry/failover 大系统。
7. channel SDK 的完整 durable delivery。
8. subagent registry。
9. model catalog/fallback/auth profile rotation。

### Avoid

1. 先做 channel 插件，后补 core。
2. 把 channel raw event 放进 AgentLoop。
3. 让模型直接执行 shell。
4. 没有 runId 就写 transcript。
5. 只用 console log，不做结构化 EventLog。
6. 照搬 OpenClaw 的插件生态导致 P0 失控。

## 15. 建议阅读顺序

第一轮只读这些：

1. `references/openclaw/docs/concepts/agent-loop.md`
2. `references/openclaw/docs/concepts/agent-runtimes.md`
3. `references/openclaw/src/gateway/server-methods.ts`
4. `references/openclaw/src/gateway/server-methods/agent.ts`
5. `references/openclaw/src/agents/agent-command.ts`
6. `references/openclaw/src/agents/harness/types.ts`
7. `references/openclaw/src/agents/harness/selection.ts`
8. `references/openclaw/packages/agent-core/src/agent-loop.ts`
9. `references/openclaw/src/agents/agent-tools.policy.ts`
10. `references/openclaw/packages/agent-core/src/harness/session/jsonl-storage.ts`

第二轮再看：

1. `references/openclaw/src/agents/embedded-agent-runner/run.ts`
2. `references/openclaw/src/agents/embedded-agent-runner/runs.ts`
3. `references/openclaw/src/agents/embedded-agent-subscribe.ts`
4. `references/openclaw/src/config/sessions/transcript-append.ts`
5. `references/openclaw/src/agents/session-write-lock.ts`
6. `references/openclaw/src/plugin-sdk/channel-inbound.ts`
7. `references/openclaw/src/plugin-sdk/channel-outbound.ts`
8. `references/openclaw/extensions/telegram/src/channel.ts`
9. `references/openclaw/extensions/slack/src/channel.ts`

## 16. 给初学者的最短总结

OpenClaw 的核心机制可以压成四个词：

```text
Gateway: 外部世界怎么进来
Harness: Agent run 怎么被控制
Policy: 工具怎么被限制
Trace: 过程怎么被记录和复盘
```

Huaness Lite 要做的不是“复刻 OpenClaw”，而是把这四件事做小、做清楚、做可测。
