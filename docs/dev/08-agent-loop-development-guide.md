# Agent Loop 开发指导

本文只分析核心 AgentLoop，不展开 JSONL、真实 LLM、真实 shell、QQ/channel adapter。目标是回答一个问题：

> Huaness Lite 的 P0 AgentLoop 到底应该负责什么，不应该负责什么，以及当前 `packages/core/src/loop/agent-loop.ts` 应该怎么改。

核心结论先放前面：

```text
AgentLoop 的职责不是“执行工具”，而是“调度一轮又一轮 model <-> tool observation 的闭环”。

run/session input
  -> build context/messages
  -> call model
  -> append assistant message
  -> extract tool calls
  -> validate/policy/execute through ToolGateway
  -> append tool observation
  -> continue or stop
```

真正值得学习的 harness 思想是边界：

- `AgentLoop` 只管 turn orchestration。
- `ModelClient` 只管把 messages 送进模型并拿回 assistant/tool calls。
- `ToolGateway` 只管工具查找、参数校验、policy、执行、结果归一。
- `PolicyEngine` 只管是否允许工具调用。
- channel、HTTP、CLI、QQ 都只能在 loop 外侧。

## 1. 统一心智模型

所有参考项目的核心 loop 都可以压成同一个形状：

```text
messages = initial context + user input

while not stopped:
  response = model(messages)
  messages.append(response.assistantMessage)

  if response has no tool calls:
    return final answer

  for call in response.toolCalls:
    result = tool gateway validates + applies policy + executes
    messages.append(tool observation result)

  continue
```

差别只在工程切分：

- OpenClaw 把 streaming、tool batch、hooks 都放在一个纯 agent-core loop 里。
- mini-swe-agent 极简，`step()` 就是 `query()` 加 `execute_actions()`。
- Codex 把 session task、turn、sampling request、tool router/runtime 拆得很细。
- Gemini 把 `Turn` 做成只识别 function call 的流式 turn，工具执行交给 scheduler/executor。
- OpenHands 当前本地 repo 不是 core loop，而是 app/server 代理到外部 SDK/agent-server。
- Claude Code 当前公开 repo 不是 core loop，而是 plugins、commands、hooks 示例。

## 2. OpenClaw agent-core

关键文件：

- `references/openclaw/packages/agent-core/src/agent-loop.ts:87`：`agentLoop`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:126`：`agentLoopContinue`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:258`：`runLoop`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:395`：`streamAssistantResponse`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:497`：`executeToolCalls`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:715`：`prepareToolCall`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:781`：`executePreparedToolCall`
- `references/openclaw/packages/agent-core/src/agent-loop.ts:883`：`createToolResultMessage`

OpenClaw 是这批参考里最接近 Huaness Lite “harness core” 的。它的 agent-core loop 不关心具体 channel，也不应该关心 QQ、HTTP 或 CLI。

### 核心伪代码

```ts
agentLoop(context, prompt):
  stream = create EventStream
  runAgentLoop(context, prompt, stream)
  return stream

runAgentLoop(context, prompt):
  currentContext.messages = context.messages + promptMessages
  emit agent_start
  emit turn_start
  emit prompt message_start/message_end
  runLoop(currentContext)

runLoop(context):
  pendingMessages = steering messages

  while true:
    hasMoreToolCalls = true

    while hasMoreToolCalls or pendingMessages not empty:
      append pendingMessages into context
      assistant = streamAssistantResponse(context)
      append assistant into context

      if assistant.stopReason is error or aborted:
        emit turn_end
        emit agent_end
        return

      toolCalls = assistant.content.filter(type == "toolCall")

      if toolCalls not empty:
        toolResultMessages = executeToolCalls(toolCalls, context)
        append toolResultMessages into context
        if all tool results say terminate:
          emit turn_end
          emit agent_end
          return
        continue

      emit turn_end
      maybe prepareNextTurn()
      if shouldStopAfterTurn():
        emit agent_end
        return
      pendingMessages = follow-up steering messages
      if pendingMessages empty:
        emit agent_end
        return
```

### context/messages 在哪里组装

OpenClaw 有两层 message 组装：

1. `runAgentLoop` 把初始 prompt message 加进 `context.messages`。
2. `streamAssistantResponse` 在每次模型调用前执行 `transformContext` 和 `convertToLlm(messages)`，把内部 context 转成 LLM 请求形态。

这点很重要：**内部消息结构和模型请求结构不是一回事**。Huaness Lite P0 可以先共用一个简单 `ModelMessage`，但应该保留以后引入 `PromptBuilder` / `ContextBuilder` 的空间。

### tool call 在哪里解析、校验、执行、回写

OpenClaw 的工具链路很清楚：

```text
assistant message content
  -> filter toolCall blocks
  -> executeToolCalls()
  -> prepareToolCall()
  -> validateToolArguments()
  -> beforeToolCall hook
  -> executePreparedToolCall()
  -> afterToolCall hook
  -> createToolResultMessage()
  -> append role=toolResult message
```

关键点：

- 未知工具、参数错误、hook block、工具异常，都会尽量变成 tool result message。
- 只有真正的 abort / fatal 才结束 loop。
- tool result message 带 `toolCallId`、`toolName`、`isError`、`details`。

这比 Huaness 当前的 `{ role: "tool", content: result.output }` 更完整。

### stop / max step / cancellation / error

OpenClaw 的停止条件主要是：

- assistant stop reason 是 `error` 或 `aborted`。
- 当前 assistant 没有 tool call，并且没有 follow-up steering message。
- `shouldStopAfterTurn()` hook 返回停止。
- tool batch 全部返回 `terminate`。

它没有在这个 pure loop 中体现一个简单固定 max step。Huaness P0 仍然应该保留 `maxSteps`，因为个人服务器上跑 agent 需要防 runaway；但这个值必须是配置，不要写死成 mock-only 的 `4`。

## 3. mini-swe-agent DefaultAgent

关键文件：

- `references/mini-swe-agent/src/minisweagent/agents/default.py:19`：`AgentConfig`
- `references/mini-swe-agent/src/minisweagent/agents/default.py:38`：`DefaultAgent`
- `references/mini-swe-agent/src/minisweagent/agents/default.py:88`：`run`
- `references/mini-swe-agent/src/minisweagent/agents/default.py:124`：`step`
- `references/mini-swe-agent/src/minisweagent/agents/default.py:128`：`query`
- `references/mini-swe-agent/src/minisweagent/agents/default.py:152`：`execute_actions`
- `references/mini-swe-agent/src/minisweagent/models/utils/actions_toolcall.py:30`：`parse_toolcall_actions`
- `references/mini-swe-agent/src/minisweagent/models/utils/actions_toolcall.py:78`：`format_toolcall_observation_messages`

mini-swe-agent 是最适合初学者理解的版本。它牺牲了复杂边界，但主链路非常清楚。

### 核心伪代码

```python
run(task):
  messages = []
  messages.append(system prompt)
  messages.append(user/instance prompt)

  while True:
    try:
      step()
    except FormatError:
      append format-error feedback messages
    except InterruptAgentFlow as e:
      append e.messages
    except Exception:
      append uncaught exception exit message
      raise
    finally:
      save()

    if messages[-1]["role"] == "exit":
      return messages[-1]["extra"]

step():
  message = query()
  execute_actions(message)

query():
  check step_limit / cost_limit / wall_time_limit
  message = model.query(messages)
  messages.append(message)
  return message

execute_actions(message):
  outputs = [env.execute(action) for action in message.extra.actions]
  observationMessages = model.format_observation_messages(message, outputs)
  messages.extend(observationMessages)
```

### context/messages 在哪里组装

`run()` 初始化 system/user messages。之后每次：

- `query()` 把完整 `self.messages` 传给 model。
- model adapter 负责把 raw model response 解析成带 `extra.actions` 的 message。
- `execute_actions()` 把 observation message append 回 `self.messages`。

这里的核心是：**messages 是 loop 的状态本体**。只要 observation 回写错了，下一轮模型就看不到正确工具结果。

### tool call 在哪里解析、校验、执行、回写

mini-swe-agent 的解析不在 agent loop 内，而在 model utils：

```text
litellm model raw response
  -> parse_toolcall_actions()
  -> message.extra.actions
  -> DefaultAgent.execute_actions()
  -> env.execute(action)
  -> format_toolcall_observation_messages()
  -> append role=tool observation
```

它的一个重要设计是 `FormatError`：模型格式错了，不是直接崩，而是把错误反馈进 messages，让模型下一步修正。

Huaness P0 可以借鉴这个思想：工具调用格式错误、未知工具、参数错误，应优先变成 model-visible observation，而不是直接 `throw` 终止 run。

### stop / max step / cancellation / error

mini-swe-agent 的停止条件更简单：

- 最后一条 message 的 role 是 `exit`。
- `step_limit`、`cost_limit`、`wall_time_limit_seconds` 超限会抛出控制流异常。
- 连续格式错误超过限制后进入 exit。
- 用户中断和任务提交也是控制流异常。

Huaness 不应该照搬它的 bash-only action 和 exit sentinel，但应该学习：

- P0 就要有 `maxSteps`。
- 格式错误要能反馈给模型。
- 控制流异常和系统错误要分开。

## 4. Codex core turn

关键文件：

- `references/codex/codex-rs/core/src/session/turn.rs:137`：`run_turn`
- `references/codex/codex-rs/core/src/session/turn.rs:1000`：`build_prompt`
- `references/codex/codex-rs/core/src/session/turn.rs:1029`：`run_sampling_request`
- `references/codex/codex-rs/core/src/session/turn.rs:1768`：`drain_in_flight`
- `references/codex/codex-rs/core/src/session/turn.rs:1802`：`try_run_sampling_request`
- `references/codex/codex-rs/core/src/stream_events_utils.rs:405`：`handle_output_item_done`
- `references/codex/codex-rs/core/src/stream_events_utils.rs:413`：`ToolRouter::build_tool_call`
- `references/codex/codex-rs/core/src/stream_events_utils.rs:487`：`FunctionCallError::RespondToModel`

Codex 的实现很重，但边界非常值得学。它把“任务生命周期”和“model/tool follow-up loop”分开。

### 核心伪代码

```ts
submission_loop(op):
  if op is interrupt:
    abort active task
  if op is user input:
    user_input_or_turn_inner(op)

user_input_or_turn_inner(input):
  turnContext = session.newTurn()
  if steering handles input:
    return
  spawn RegularTask(turnContext, input)

RegularTask.run():
  emit TurnStarted
  do:
    last = run_turn(turnContext, input)
    input = []
  while session has pending input

run_turn(context, input):
  record context updates
  record user input

  loop:
    promptInput = session.history.for_prompt()
    result = run_sampling_request(promptInput)

    if result is TurnAborted:
      break
    if result is error:
      emit error
      break
    if result.needs_follow_up:
      continue
    run stop hooks
    break

run_sampling_request(input):
  prompt = build_prompt(input, tool specs, instructions)
  return try_run_sampling_request(prompt)

try_run_sampling_request(prompt):
  inFlightTools = []
  needsFollowUp = false

  for stream event from model:
    if OutputItemDone(item):
      out = handle_output_item_done(item)
      if out.tool_future:
        inFlightTools.push(out.tool_future)
      needsFollowUp |= out.needs_follow_up

  toolOutputs = await drain_in_flight(inFlightTools)
  append toolOutputs to history
  return { needsFollowUp, lastAgentMessage }

handle_output_item_done(item):
  call = ToolRouter.build_tool_call(item)
  if call:
    record model tool call
    return { tool_future: ToolRuntime.handle_tool_call(call), needs_follow_up: true }

  if parse error can respond to model:
    append failed tool output
    return { needs_follow_up: true }

  record assistant message
  return { needs_follow_up: false }
```

### context/messages 在哪里组装

Codex 的 `run_turn` 先把输入、上下文更新、注入项写进 session history。真正发给模型前：

- `session.history.for_prompt()` 取适合模型窗口的历史。
- `build_prompt()` 加工具 specs、base instructions、输出 schema 等。

这说明 Huaness 以后应该把 `messages` 看成“内部历史”，把 `PromptBuilder` 看成“模型请求构造器”。P0 可以不拆文件，但概念上要分清。

### tool call 在哪里解析、校验、执行、回写

Codex 的链路是：

```text
model stream OutputItemDone
  -> handle_output_item_done()
  -> ToolRouter.build_tool_call()
  -> ToolCallRuntime.handle_tool_call()
  -> ToolRegistry dispatch
  -> tool output converted to model-visible response item
  -> drain_in_flight()
  -> append back into history
```

一个特别重要的点：工具解析错误有一种 `RespondToModel` 分支，会生成 function-call output 让模型看到，而不是所有错误都当 fatal。

### stop / max step / cancellation / error

Codex 这条路径没有一个简单固定 max-step counter。它的继续条件是：

- 当前 sampling result 需要 follow-up。
- 有 pending input。
- token/context 处理需要继续。
- model stream 说 `end_turn == false`。

停止或退出来自：

- `needs_follow_up == false`。
- turn stop hooks。
- cancellation token 导致 `TurnAborted`。
- fatal error 变成 error event。

Huaness P0 不需要复制 Codex 的 session/task 体系，但应该学习两个边界：

- `AgentLoop` 和 `RunManager/SessionTask` 分开。
- `ToolRouter/ToolRuntime` 把工具私有结果归一成模型可见 observation。

## 5. Gemini CLI

关键文件：

- `references/gemini-cli/packages/core/src/agent/legacy-agent-session.ts:174`：`_runLoop`
- `references/gemini-cli/packages/core/src/agent/legacy-agent-session.ts:195`：`sendMessageStream`
- `references/gemini-cli/packages/core/src/agent/legacy-agent-session.ts:248`：`scheduler.schedule`
- `references/gemini-cli/packages/core/src/core/turn.ts:271`：`Turn.run` 调用 chat stream
- `references/gemini-cli/packages/core/src/core/turn.ts:368`：读取 `functionCalls`
- `references/gemini-cli/packages/core/src/core/turn.ts:448`：`handlePendingFunctionCall`
- `references/gemini-cli/packages/core/src/scheduler/scheduler.ts:192`：`Scheduler.schedule`
- `references/gemini-cli/packages/core/src/scheduler/scheduler.ts:715`：`Scheduler._execute`
- `references/gemini-cli/packages/core/src/scheduler/tool-executor.ts:61`：`ToolExecutor.execute`

Gemini 的启发是：`Turn` 不直接执行工具。它只把模型流里的 function call 变成 `ToolCallRequest`，然后交给 Scheduler。

### 核心伪代码

```ts
currentParts = userParts

while true:
  toolRequests = []

  for event of client.sendMessageStream(currentParts, signal):
    emit event

    if event is ToolCallRequest:
      toolRequests.push(event.value)

    if event is terminal error/cancel/max/context:
      return

    if event is Finished and toolRequests is empty:
      return

  if toolRequests is empty:
    return

  completedToolCalls = scheduler.schedule(toolRequests, signal)
  emit tool response events

  if tool result says stop execution:
    return completed

  if tool result has fatal error:
    return failed

  currentParts = completedToolCalls.flatMap(call => call.response.responseParts)
```

### context/messages 在哪里组装

Gemini 的 context 组装分几层：

- `startChat()` 组装初始 history、system instruction、tool declarations。
- `processTurn()` 管 context management、压缩、模型选择、工具声明。
- 更底层的 chat stream 把当前 input parts 加上 curated history、system instruction、tools 送进 Gemini API。

Huaness P0 不需要 context compression，但需要保留 `messages + tools` 是模型请求输入这一点。

### tool call 在哪里解析、校验、执行、回写

Gemini 的工具路径是：

```text
stream chunk functionCalls
  -> Turn.handlePendingFunctionCall()
  -> ToolCallRequestInfo
  -> Scheduler.schedule()
  -> validate/create invocation through tool.build(args)
  -> ToolExecutor.execute()
  -> ToolCallResponseInfo
  -> functionResponse parts
  -> next sendMessageStream input
```

普通工具错误、取消也会转成 function response parts 给模型。只有 fatal tool error 或明确 stop execution 才终止 session loop。

### stop / max step / cancellation / error

Gemini 的停止/错误来自：

- 模型流 `Finished` 且没有 pending tool calls。
- session/turn max 或上下文限制事件。
- `AbortSignal` 从 session 贯穿 turn、scheduler、executor。
- tool result 标记 `STOP_EXECUTION`。
- fatal tool error。

Huaness 最该学习的是：**Turn 只做模型响应解释，Scheduler/Executor 做工具状态机**。P0 不必完整拆出 Scheduler，但 `ToolGateway.execute()` 的返回值应该已经像 `ToolCallResponseInfo` 那样能表达 success/error/denied/cancelled。

## 6. OpenHands 和 Claude Code 当前本地仓库

这两个项目要谨慎使用，不能硬说它们提供了可读的 core loop。

### OpenHands

关键证据：

- `references/openhands/pyproject.toml:60` 依赖 `openhands-agent-server==1.28.0`
- `references/openhands/pyproject.toml:61` 依赖 `openhands-sdk==1.28.0`
- `references/openhands/openhands/app_server/app_conversation/app_conversation_router.py:361`：`start_app_conversation`
- `references/openhands/openhands/app_server/app_conversation/live_status_app_conversation_service.py:1312`：`_build_start_conversation_request_for_user`
- `references/openhands/openhands/app_server/event_callback/webhook_router.py:409`：`on_event`

当前本地 `references/openhands` 主要是 app-server、frontend、webhook 边界，核心 agent runtime 在外部 SDK / agent-server 依赖里。

可以学习的伪代码是 app shell：

```text
POST /app-conversations:
  build StartConversationRequest:
    initial message
    model config
    tools
    MCP config
    workspace/runtime context
    hooks/plugins
  POST agent-server /api/conversations
  save app conversation metadata

POST /send-message:
  validate conversation/runtime
  forward user message to agent-server /events

POST /webhooks/events:
  receive runtime events
  save events
  update conversation status
```

对 Huaness 的意义不是“抄 loop”，而是确认：`apps/server` 应该是薄外壳，只负责 session/API/channel 和 core 的连接，不拥有 agent loop 决策。

### Claude Code

关键证据：

- `references/claude-code/README.md:7` 说明这是 Claude Code 产品说明。
- `references/claude-code/examples/hooks/bash_command_validator_example.py:5` 是 `PreToolUse` hook 示例。
- `references/claude-code/examples/hooks/bash_command_validator_example.py:64` 读取 `tool_name`。
- `references/claude-code/plugins/hookify/hooks/hooks.json:4` 注册 `PreToolUse`。

当前公开 repo 没有 CLI/core agent loop 源码，主要是 plugins、slash commands、hooks 示例。

可以学习的伪代码是 hook/policy 边界：

```text
runtime calls PreToolUse hook with JSON on stdin
  read tool_name/tool_input
  load rules
  if blocked:
    return deny / non-zero / decision block
  else:
    allow
```

Huaness P0 不应该把 markdown command frontmatter 当核心 policy engine。可以学习的是 hook 点命名：

- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`

这些适合 P1 做轻量 hook API。

## 7. 横向对比

| 项目 | context/messages 组装 | tool call 解析 | 校验/执行 | observation 回写 | stop/error |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | `runAgentLoop` 加 prompt，`streamAssistantResponse` 转 LLM context | assistant content 里筛 `toolCall` block | `prepareToolCall`、validate、before/after hook、execute | `createToolResultMessage` append 到 context | no tool/followup、hook stop、abort/error、tool terminate |
| mini-swe-agent | `run()` 初始化 messages，`query()` 每次传全量 messages | model utils parse tool calls into actions | `env.execute(action)` | `format_observation_messages` append | `exit` role、step/cost/time limit、format error limit |
| Codex | session history 记录 input，`build_prompt` 构造模型请求 | `handle_output_item_done` 调 `ToolRouter.build_tool_call` | `ToolCallRuntime` + registry dispatch | tool output 转 `ResponseInputItem` 后写回 history | `needs_follow_up`、pending input、cancel token、fatal error |
| Gemini | session loop 持有 current parts，client/chat 拼 history/tools | `Turn.handlePendingFunctionCall` | Scheduler validate/build invocation，ToolExecutor execute | functionResponse parts 作为下一轮 input | Finished no tools、AbortSignal、STOP_EXECUTION、fatal error |
| OpenHands | app-server 组装 StartConversationRequest | 本地 repo 无 core parser | 代理到 agent-server | webhook 接收 runtime event | runtime state event |
| Claude Code | 当前 repo 无 core messages | hook 示例读取 tool JSON | hook/rule 决策 | runtime 外部处理 | Stop hook 示例 |

## 8. Huaness Lite P0 应采用

P0 目标是让核心链路可测试、可解释、可继续扩展。

### 8.1 采用

1. 保留当前依赖注入结构：`AgentLoop` 注入 `ModelClient`、`ToolGateway`、`EventWriter`。
2. 给 `AgentLoop.run()` 增加可配置 `maxSteps`，默认值比如 `8` 或 `10`，不要写死 mock-only 的 `4`。
3. 给 `AgentRunInput` 增加 `signal?: AbortSignal`，并在 model call 前、tool call 前后检查取消。
4. `ToolGateway.execute()` 不要把 policy deny、unknown tool、tool exception 全部直接 throw。它应该返回 model-visible tool observation。
5. `ToolResult` 或 tool message 必须带 `callId`、`toolName`、`isError/status`，否则多工具调用时无法对应。
6. 先顺序执行 tool calls。P0 不要并行，先保证可读、可测、可取消。
7. 区分普通工具错误和系统 fatal error：
   - 普通错误：作为 observation 回给模型。
   - fatal：`run.failed` 并抛出。
8. 增加 focused tests，覆盖 happy path 之外的 loop 行为。

### 8.2 延后

1. streaming delta。
2. parallel tool calls。
3. context compression。
4. model router / fallback。
5. before/after hooks 完整插件体系。
6. approval UI。
7. 真实 shell sandbox。
8. OpenHands 式远程 runtime。
9. Codex/Gemini 级 scheduler 状态机。

这些都重要，但不是 P0 AgentLoop 的第一刀。

### 8.3 避免

1. 避免让 `apps/server` 直接决定 tool 执行、policy 或 message history。
2. 避免把 QQ/channel event shape 塞进 core messages。
3. 避免让 `AgentLoop` 认识具体工具，比如 shell、file、browser。
4. 避免 tool error 直接炸掉整个 run。
5. 避免 hardcode bash-only action、exit sentinel、Claude command frontmatter。
6. 避免照搬 Codex/Gemini 的复杂任务系统。Huaness Lite 先做小而清楚的 core。

## 9. 当前 Huaness AgentLoop 诊断

当前文件：

- `packages/core/src/loop/agent-loop.ts:14`：`AgentLoop`
- `packages/core/src/loop/agent-loop.ts:31`：`run`
- `packages/core/src/loop/agent-loop.ts:42`：`for (let step = 0; step < 4; step += 1)`
- `packages/core/src/loop/agent-loop.ts:45`：`modelClient.complete`
- `packages/core/src/loop/agent-loop.ts:60`：`toolGateway.execute`
- `packages/core/src/loop/agent-loop.ts:66`：append `{ role: "tool", content: result.output }`
- `packages/core/src/loop/agent-loop.ts:81`：超过 mock steps throw

当前类型：

- `packages/core/src/types.ts:26`：`ModelMessage`
- `packages/core/src/types.ts:32`：`ToolCall`
- `packages/core/src/types.ts:39`：`ToolResult`
- `packages/core/src/types.ts:52`：`ModelClient`
- `packages/core/src/types.ts:100`：`AgentRunInput`
- `packages/core/src/types.ts:107`：`AgentRunResult`

当前工具网关：

- `packages/core/src/tools/tool-gateway.ts:31`：`execute`
- `packages/core/src/tools/tool-gateway.ts:40`：`policyEngine.decide`
- `packages/core/src/tools/tool-gateway.ts:47`：policy 非 allow 直接 throw
- `packages/core/src/tools/tool-gateway.ts:54`：unknown tool 直接 throw
- `packages/core/src/tools/tool-gateway.ts:57`：`tool.execute`

当前优点：

- 已经有正确的三件套：`AgentLoop`、`ModelClient`、`ToolGateway`。
- loop 不直接执行工具。
- fake model happy path 已经能证明 model -> tool -> observation -> final 的闭环。
- event 顺序测试已经覆盖最小链路，见 `packages/core/tests/mock-agent-run.test.ts:16`。

当前主要问题：

1. `maxSteps` 写死成 `4`，而且错误信息还是 mock steps。
2. `AgentRunInput` 没有 `maxSteps` 和 `AbortSignal`。
3. tool observation 没有 `toolCallId` 和 `toolName`，多 tool call 会丢对应关系。
4. `ToolGateway` 对 policy deny、unknown tool、tool exception 都 throw，导致模型无法收到错误 observation 并修正。
5. `ToolResult` 没有 `isError/status`，无法表达 denied/cancelled/validation_error。
6. catch 里所有错误都发 `run.failed`，没有 `run.cancelled` 或 max-step 这类可区分状态。
7. 测试只覆盖 happy path，没有验证 loop 的核心边界。

## 10. 具体改造建议

这里是下一步实现时建议的最小改造顺序。

### Step 1：扩展输入和消息类型

建议先改类型，不急着接真实模型。

```ts
export type AgentRunInput = {
  runId: RunId;
  sessionId: SessionId;
  userMessage: string;
  maxSteps?: number;
  signal?: AbortSignal;
};
```

把 tool message 从普通 string message 扩成能关联 tool call 的形态：

```ts
export type ModelMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
      toolName: string;
      isError?: boolean;
    };
```

如果暂时不想改 union，也至少把 `toolCallId/toolName/isError` 放进 `metadata`，但 discriminated union 会更清楚。

### Step 2：让 ToolGateway 返回 outcome，不把普通工具错误变 fatal

建议新增一个执行结果类型：

```ts
export type ToolExecutionOutcome =
  | {
      status: "success";
      result: ToolResult;
    }
  | {
      status: "error" | "denied" | "unknown_tool" | "cancelled";
      result: ToolResult;
    };
```

`ToolResult` 也应该扩展：

```ts
export type ToolResult = {
  callId: string;
  toolName: string;
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
};
```

`ToolGateway.execute()` 的目标行为：

```text
emit tool.requested
decision = policy.decide()
emit policy.decided

if denied:
  emit tool.blocked
  return denied ToolResult as model-visible observation

if unknown tool:
  emit tool.failed
  return unknown_tool ToolResult as model-visible observation

try:
  result = tool.execute()
  emit tool.completed
  return success result
catch error:
  emit tool.failed
  return error ToolResult as model-visible observation
```

只有以下情况应当抛出 fatal：

- event writer 自身坏掉。
- core 内部状态不一致。
- AbortSignal 已取消，并且你决定取消要中断 run。

### Step 3：重写 AgentLoop 的最小伪代码

目标不是重构很多文件，而是把当前 `run()` 改成更标准的 loop。

```ts
async run(input):
  maxSteps = input.maxSteps ?? defaultMaxSteps
  messages = [{ role: "user", content: input.userMessage }]
  toolResults = []

  emit run.created

  try:
    for step in 0..<maxSteps:
      throwIfAborted(input.signal)

      emit turn.started or model.requested
      response = await modelClient.complete({ runId, sessionId, messages, signal })
      emit model.responded

      messages.push(response.message)

      if no response.toolCalls:
        emit run.completed
        return finalAnswer + toolResults

      for toolCall of response.toolCalls:
        throwIfAborted(input.signal)

        outcome = await toolGateway.execute({ runId, sessionId, toolCall, signal })
        toolResults.push(outcome.result)

        messages.push({
          role: "tool",
          content: outcome.result.output,
          toolCallId: outcome.result.callId,
          toolName: outcome.result.toolName,
          isError: outcome.result.isError
        })

      emit turn.completed

    emit run.max_steps_exceeded
    throw new MaxStepsExceededError(maxSteps)

  catch Cancelled:
    emit run.cancelled
    throw

  catch error:
    emit run.failed
    throw
```

注意：`turn.started/turn.completed` 可以 P0 后半段再加。如果不加，也至少保持现在的 `model.requested/model.responded/tool.*` 顺序可测。

### Step 4：把验证从执行里拆出来，但先不做复杂 schema

P0 的 `validateToolCall` 不需要 Zod 或 JSON Schema。先做最小保护：

```text
toolCall.id must be non-empty string
toolCall.name must be non-empty string
toolCall.args must be object
tool name must exist in registry
```

以后再升级：

- tool 参数 schema。
- requires approval。
- workspace/path guard。
- timeout。
- output truncation。

### Step 5：增加测试

建议在 `packages/core/tests` 里新增或扩展测试，先覆盖这些行为：

1. happy path 仍然通过。
2. 模型没有 tool call 时直接 final。
3. unknown tool 会生成 tool error observation，并进入下一轮 model。
4. policy deny 会生成 tool error observation，并进入下一轮 model。
5. tool execute throw 会生成 tool error observation，并进入下一轮 model。
6. `maxSteps` 超限会发可区分事件。
7. `AbortSignal` 在 model 前取消会发 `run.cancelled`。
8. `AbortSignal` 在 tool 前取消会发 `run.cancelled`。

测试目标不是模拟真实 shell，而是保护 loop contract。

## 11. P0 最小目标定义

完成下一轮 AgentLoop 改造后，Huaness Lite P0 core 应该能做到：

```text
FakeModel returns assistant + tool call
  -> AgentLoop appends assistant message
  -> ToolGateway applies policy
  -> ToolGateway returns success/error/denied observation
  -> AgentLoop appends tool message with callId/toolName/isError
  -> FakeModel sees tool observation
  -> AgentLoop returns final answer
```

同时必须能证明：

- tool call 不绕过 policy。
- tool error 不会默认炸掉 run。
- max step 可配置。
- cancellation 有确定事件。
- `apps/server` 不参与核心决策。

这就是 Huaness Lite 的第一版 harness core。它不华丽，但足够像一个真正的 agent runtime，而不是一个聊天机器人里直接调工具的 if-else。
