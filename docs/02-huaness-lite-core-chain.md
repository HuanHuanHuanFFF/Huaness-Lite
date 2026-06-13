# Huaness Lite 核心链路设计草案

这不是最终架构冻结，而是为了让你开发和学习时不跑偏：先把 Agent Harness 的核心链路做出来，再逐步替代服务器上的 OpenClaw。

## 1. 项目定位

Huaness Lite 是一个轻量 Agent Harness。

它的目标不是复制 OpenClaw 的全部生态，而是在个人服务器上提供更小、更可控、更容易讲清楚的核心：

- 能接 CLI/HTTP，也能把 IM 平台作为 channel plugin 接入。
- 能创建 session/run。
- 能调模型并进入 Agent loop。
- 能暴露工具，但工具必须经过 registry、policy、approval、executor。
- 能记录完整 trace。
- 能回放和评测。
- 能逐步加入 skills、hooks、plugins。

面试时可以这样讲：

> 我不是只做了一个聊天入口，而是做了一个轻量 Agent Harness。CLI、HTTP、IM 都只是 channel adapter，核心是 run/session 管理、工具网关、权限策略、事件追踪和可回放评测。

## 2. 最小架构

```text
channels/
  cli
  http
  onebot

gateway/
  method registry
  auth / scope
  run creation

core/
  session store
  run manager
  context builder
  model client
  agent loop

tools/
  tool registry
  tool gateway
  policy engine
  approval manager
  executors

runtime/
  workspace
  sandbox
  process runner

storage/
  messages
  events
  transcripts
  eval results

extensions/
  skills
  hooks
  commands
```

一开始可以全在一个进程里，不需要微服务。重要的是内部边界要清楚。

## 3. 核心链路

```text
External Event
  -> ChannelAdapter.normalize()
  -> Gateway.dispatch(method)
  -> RunService.createRun()
  -> SessionQueue.enqueue()
  -> AgentRuntime.run()
  -> ContextBuilder.build()
  -> ModelClient.stream()
  -> AgentLoop.handleModelOutput()
  -> ToolGateway.invoke()
  -> PolicyEngine.check()
  -> ApprovalManager.resolve()
  -> ToolExecutor.execute()
  -> EventLog.append()
  -> ChannelReplyAdapter.deliver()
```

每一层只做自己的事：

- ChannelAdapter 不做 Agent 决策。
- Gateway 不执行工具。
- AgentLoop 不直接跑 shell。
- ToolExecutor 不决定业务会话。
- EventLog 不参与逻辑，只记录事实。

## 4. 组件职责

### 4.1 ChannelAdapter

负责把外部平台事件转成内部消息。

P0 只需要：

- `CliChannel`
- `HttpChannel`
- `ChannelAdapter` 接口

真实 IM 接入作为插件放在 core 跑通之后：

- `OneBotChannel`

内部消息可以先长这样：

```ts
type InboundMessage = {
  channel: "cli" | "http" | "onebot";
  externalUserId?: string;
  externalConversationId: string;
  text: string;
  attachments?: Attachment[];
  receivedAt: string;
};
```

关键原则：任何 channel 相关逻辑都不能泄漏到 Agent core。以后换 Telegram、Web、命令行或其他 IM 平台时，核心不应该改。

### 4.2 Gateway / RunService

负责统一入口和 run 创建。

P0 方法可以只有：

- `chat.send`
- `agent.run`
- `agent.wait`
- `runs.get`
- `sessions.get`

`agent.run` 返回 `runId`，不一定等 Agent 完成。`agent.wait` 才等待结果。这一点来自 OpenClaw 的 `agent` / `agent.wait` 思路。

### 4.3 SessionQueue

同一个 session 内应该串行执行，避免两个任务同时改同一份上下文。

最小规则：

- 同一个 `sessionId` 只有一个 active run。
- 后续消息可以排队、打断、或合并，P0 先选择排队。
- 每个 run 有 `created/running/waiting_approval/completed/failed/cancelled` 状态。

### 4.4 SessionStore

保存长期会话状态。

最小数据：

```ts
type Session = {
  id: string;
  channel: "cli" | "http" | "onebot";
  externalConversationId: string;
  title?: string;
  workspaceId?: string;
  modelProfile: string;
  permissionProfile: "read_only" | "workspace_write" | "full_access";
  createdAt: string;
  updatedAt: string;
};
```

`session` 是长期的，`run` 是一次任务。不要混用。

### 4.5 ContextBuilder

负责把 session、messages、skills、tools 转成模型输入。

P0 输入：

- system prompt
- 当前用户消息
- 最近 N 条消息
- 可用工具 schema
- workspace 信息
- permission profile

P1 再加：

- session summary
- skill snapshot
- retrieved memory
- token budget compaction

关键原则：context 是可解释的。明天调试时你应该能打印“这次模型到底看到了什么”。

### 4.6 ModelClient

只负责调模型，不负责业务逻辑。

接口可以是：

```ts
interface ModelClient {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

模型输出分两类：

- assistant text
- tool call

不要让 `ModelClient` 自己执行工具。

### 4.7 AgentLoop

AgentLoop 是核心。

伪代码：

```ts
async function runAgentLoop(run) {
  while (!run.stopped) {
    const context = await contextBuilder.build(run);
    const output = await modelClient.stream(context);

    await eventLog.append("model_response", output);

    if (output.toolCalls.length === 0) {
      return finish(output.text);
    }

    for (const call of output.toolCalls) {
      const result = await toolGateway.invoke(call, run);
      await sessionStore.appendObservation(run.sessionId, result);
    }

    guardLimits(run);
  }
}
```

P0 guard：

- max steps
- max tool calls
- max wall time
- max cost/token
- cancellation token

### 4.8 ToolRegistry

保存工具定义。

P0 工具只需要：

- `read_file`
- `list_files`
- `search_text`
- `write_file`
- `shell`
- `http_fetch`
- `finish`

每个工具必须有：

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  risk: "safe" | "write" | "exec" | "network" | "destructive";
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
};
```

模型只能看到 schema，不应该看到 executor 内部。

### 4.9 ToolGateway

这是安全核心。

执行顺序必须固定：

```text
raw model tool call
  -> parse JSON
  -> schema validate
  -> normalize paths/args
  -> policy check
  -> approval if needed
  -> execute in runtime
  -> truncate/mask output
  -> append event
  -> return observation
```

不要让任何工具绕过这个网关。

### 4.10 PolicyEngine / ApprovalManager

P0 策略可以很朴素：

| Tool 风险 | read_only | workspace_write | full_access |
| --- | --- | --- | --- |
| `safe` | allow | allow | allow |
| `write` | deny | ask/allow scoped | ask/allow |
| `exec` | deny | ask | ask/allow |
| `network` | ask/deny | ask | ask/allow |
| `destructive` | deny | deny/ask | ask |

外部 IM/网络入口尤其要保守：

- 群聊默认 `read_only` 或低权限。
- 私聊也不应默认 shell full access。
- 来自网络入口的 model override 默认禁止。
- approval 要带上 `runId`、工具名、参数摘要、风险说明。

### 4.11 Runtime / Workspace

P0 先做 local workspace，不急着 Docker。

最低要求：

- 每个 session 或 profile 有默认 `workspaceRoot`。
- 文件读写必须 resolve 后检查是否在 workspace 内。
- shell 默认 cwd 在 workspace。
- shell 有 timeout。
- stdout/stderr 要截断。
- secrets 不写入 event。

P1 再考虑：

- Docker sandbox。
- per-run temp workspace。
- network allowlist。
- background process。

### 4.12 EventLog / Trace

这是秋招展示价值很高的部分。

P0 事件类型：

```text
run_created
run_started
context_built
model_request
model_response
tool_call_requested
tool_call_approved
tool_call_denied
tool_call_started
tool_call_finished
observation_appended
approval_requested
approval_resolved
run_completed
run_failed
run_cancelled
```

事件字段：

```ts
type Event = {
  id: string;
  runId: string;
  sessionId: string;
  type: string;
  ts: string;
  data: unknown;
};
```

先用 JSONL 就够。后面再上 SQLite/Postgres。

### 4.13 Replay / Eval

P0 要有最小 eval，不要等项目末期。

最小 eval：

- 给定输入和 fake model outputs，验证 loop 顺序。
- 给定危险 shell tool call，验证 policy deny。
- 给定 write_file，验证 workspace path guard。
- 给定多轮 tool result，验证 observation 回到模型上下文。
- 给定 step limit，验证能停止。

这会让项目从“演示型 agent demo”变成“可验证 Harness”。

## 5. 数据模型草案

```ts
type Run = {
  id: string;
  sessionId: string;
  status: "created" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  input: InboundMessage;
  startedAt?: string;
  finishedAt?: string;
  stopReason?: string;
};

type Message = {
  id: string;
  sessionId: string;
  runId?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  createdAt: string;
};

type ToolCall = {
  id: string;
  runId: string;
  name: string;
  input: unknown;
  status: "requested" | "approved" | "denied" | "running" | "completed" | "failed";
  result?: unknown;
};
```

## 6. P0 / P1 / P2

边界不用现在画死，但开发顺序要清楚。

### P0：能跑、可控、可追踪

- CLI channel。
- 简单 HTTP channel。
- 通用 ChannelAdapter 接口。
- session/run。
- Agent loop。
- model client。
- 5 到 7 个内置工具。
- tool policy。
- JSONL event log。
- per-session queue。
- basic replay。
- fake model tests。

### P1：能替代 OpenClaw 日常使用

- 更稳定的 IM/channel plugins。
- approval 交互。
- skill snapshot。
- hook checkpoint。
- SQLite storage。
- web/CLI 查看 run trace。
- 基础 eval runner。
- workspace profiles。

### P2：能作为秋招亮点扩展

- 插件式 tools。
- MCP。
- Docker sandbox。
- multi-model fallback。
- run dashboard。
- 自动总结和 context compaction。
- 多 Agent 或 subtask，但必须建立在稳定 trace/eval 上。

## 7. 和 OpenClaw 的替代映射

| OpenClaw 能力 | Huaness Lite 对应 |
| --- | --- |
| Channel extensions | `channels/onebot`, `channels/http`, `channels/cli` |
| Gateway methods | `gateway/methodRegistry` |
| `agent` / `agent.wait` | `RunService.createRun()` / `RunService.waitRun()` |
| Agent harness selection | P0 固定 built-in harness，P1 再扩展 |
| Session store | `SessionStore` |
| Transcript | `MessageStore` + `EventLog` |
| Tool policy | `PolicyEngine` |
| Skills | `SkillLoader` + session snapshot |
| Lifecycle/tool events | `EventLog` |
| Channel-specific reply | `ChannelReplyAdapter` |

## 8. 最容易踩的坑

1. 先做某个聊天平台 bot 逻辑，最后发现 core 很乱。正确顺序是先 core，再 channel plugin。
2. 工具太早做多。先把 5 个工具的安全链路做对。
3. 没有事件日志。没有 trace 就没法 debug，也没法面试讲“可观测”。
4. shell 权限太大。个人服务器上这是真风险。
5. session/run 混淆。长期会话和一次任务要分开。
6. 只做 happy path。Agent 项目最常见问题是失控、循环、错误恢复差，所以 stop/limit/error 比成功 demo 更重要。
7. 盲目搬 OpenClaw 插件系统。Huaness Lite 的优势应该是轻。

## 9. 下一步学习任务

明天可以按这个顺序继续深挖：

1. 深读 `references/mini-swe-agent/src/minisweagent/agents/default.py`，手画一次 loop。
2. 深读 `references/openclaw/packages/agent-core/src/agent-loop.ts`，对比 mini loop 多了什么。
3. 深读 `references/gemini-cli/packages/core/src/scheduler/tool-executor.ts` 和 `policy-engine.ts`，学习工具执行前后的安全链。
4. 深读 `references/codex/codex-rs/core/src/tools/orchestrator.rs`，学习 approval/sandbox 统一编排。
5. 回到这份设计，把 P0 数据模型和目录结构定下来。
