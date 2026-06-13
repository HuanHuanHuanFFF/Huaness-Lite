# mini-swe-agent 阶段学习总结

这份文档记录目前已经看过的 mini-swe-agent 主线模块。目标不是逐行复述源码，而是把“启动、配置、模型调用、agent loop、工具调用、环境执行”这条链路串起来。

## 1. 当前已经建立的整体认识

mini-swe-agent 的核心可以压缩成一句话：

> `mini.py` 读取配置并初始化 `Model / Environment / Agent`，`Agent` 在 loop 中调用模型，模型返回 tool call，tool call 被解析成 action，最后交给 `Environment.execute()` 执行。

主链路是：

```text
mini.py
  -> get_config_from_spec()
  -> get_model()
  -> get_environment()
  -> get_agent()
  -> agent.run(task)
  -> agent.step()
  -> model.query(messages)
  -> parse tool_calls into actions
  -> env.execute(action)
  -> format observation
  -> append messages
```

对应关键入口：

- `run/mini.py:70-92`：读取 CLI 参数和配置，并合并成最终 config。
- `run/mini.py:99-102`：初始化 `model / env / agent`，然后调用 `agent.run(run_task)`。
- `agents/default.py:88-122`：`run()` 循环执行 `step()`，直到出现 `role == "exit"`。
- `agents/default.py:124-126`：`step()` 只做两件事：`query()` 和 `execute_actions()`。
- `agents/default.py:152-155`：把模型返回的 actions 交给 `env.execute()`，再把结果格式化成 observation。

## 2. 启动中心：mini.py

`mini.py` 是配置启动中心，不负责 agent 逻辑本身。

它主要做四件事：

1. 定义 CLI 参数，例如 `--model`、`--agent-class`、`--environment-class`、`--task`、`--yolo`。
2. 读取 YAML 配置和命令行覆盖项。
3. 初始化三大对象：`Model`、`Environment`、`Agent`。
4. 启动 `agent.run(task)`。

关键位置：

- `run/mini.py:55-66`：Typer CLI 参数定义。
- `run/mini.py:72`：把每个 `config_spec` 转成 dict。
- `run/mini.py:73-91`：把 CLI 参数转换成配置覆盖项。
- `run/mini.py:92`：用 `recursive_merge()` 合并配置。
- `run/mini.py:99-101`：初始化三大对象。

这里的重点是：**mini.py 本身不是 agent loop，而是 bootstrap。**

## 3. 配置系统

mini-swe-agent 的配置主要来自 YAML，也支持命令行传入 `key=value` 形式的覆盖项。

关键位置：

- `config/__init__.py:12-28`：根据配置名查找实际 YAML 文件。
- `config/__init__.py:31-51`：把 `model.model_name=xxx` 这种 CLI 参数转换成嵌套 dict。
- `config/__init__.py:54-59`：如果是 `key=value` 就解析成 dict，否则读取 YAML。
- `config/default.yaml:1-105`：agent prompt、任务模板、step/cost limit。
- `config/default.yaml:106-112`：environment 默认环境变量。
- `config/default.yaml:113-171`：observation 和 format error 的模板。

这部分的核心是：**配置文件决定 prompt、模型参数、环境变量和部分 agent 行为；对象创建仍然在代码里完成。**

## 4. Agent Loop：default.py

`DefaultAgent` 是最小 agent loop。

它的主线非常短：

```text
run()
  -> 初始化 system/user messages
  -> while True:
       step()
       save()
       if last message is exit: break

step()
  -> query()
  -> execute_actions()
```

关键位置：

- `agents/default.py:88-95`：初始化任务上下文和初始 messages。
- `agents/default.py:96-121`：循环执行 step，并处理格式错误、中断、异常、保存轨迹。
- `agents/default.py:128-150`：调用 model，拿到 assistant message，并累计 cost。
- `agents/default.py:152-155`：执行 actions，并追加 observation messages。
- `agents/default.py:157-188`：序列化和保存 trajectory。

这里要抓住一个边界：**Agent 不直接执行 shell。Agent 只负责调模型、拿 actions、交给 environment。**

## 5. 交互控制：interactive.py

`InteractiveAgent` 是在 `DefaultAgent` 的 loop 节点上加人机交互控制。

它主要处理：

- 执行命令前是否需要用户确认。
- 用户 Ctrl+C 中断后如何处理。
- human/yolo 模式切换。
- submit 前是否确认。
- slash commands，例如继续、修改、终止等。

已经形成的理解是：

> `interactive.py` 不是新的核心 loop，而是在 `query()`、`step()`、`execute_actions()` 等节点周围加交互钩子。

所以它属于“控制层增强”，不是最小 agent runtime 的必需部分。

## 6. 模型适配：LiteLLMModel

`LitellmModel` 是模型适配层。它把 mini-swe-agent 的内部 messages 转成 LiteLLM 请求，并把 LiteLLM 返回结果转成 mini 内部 message。

关键位置：

- `models/litellm_model.py:64-71`：调用 `litellm.completion()`。
- `models/litellm_model.py:69`：把 `tools=[BASH_TOOL]` 发给模型。
- `models/litellm_model.py:81-105`：完整 query 流程，包括请求模型、解析 actions、记录 cost、返回 message。
- `models/litellm_model.py:127-131`：从 `response.choices[0].message.tool_calls` 中取出 tool calls。

这里的重点是：

> LiteLLM 把不同模型厂商的协议统一成类似 OpenAI 的响应结构；mini 只需要关心 `message.tool_calls`。

## 7. Tool Call 到 Action

工具定义在：

- `models/utils/actions_toolcall.py:11-27`

这里定义了唯一工具：

```text
function name: bash
argument: command: string
```

解析流程：

- `actions_toolcall.py:57`：解析 `tool_call.function.arguments`。
- `actions_toolcall.py:60-63`：校验工具名必须是 `bash`，并且必须有 `command` 参数。
- `actions_toolcall.py:74`：转换成内部 action：`{"command": args["command"], "tool_call_id": tool_call.id}`。

所以 mini-swe-agent 当前没有真正的工具注册系统。它是硬编码单工具：

```text
BASH_TOOL
  -> tools=[BASH_TOOL]
  -> parse only bash
  -> action["command"]
```

后面如果做 Huaness Lite，这里就会演进成：

```text
ToolRegistry
  -> filter visible tools by config/policy
  -> send schemas to LLM
  -> parse tool_calls
  -> ToolGateway dispatch
```

## 8. Environment：命令真正在哪里执行

`LocalEnvironment` 是最小执行环境。

关键位置：

- `environments/local.py:13-16`：配置项：`cwd / env / timeout`。
- `environments/local.py:24-43`：`execute()` 接收 action 并返回 output dict。
- `environments/local.py:26`：从 action 中取出 `command`。
- `environments/local.py:27`：决定工作目录。
- `environments/local.py:29`：调用 `_run()`。
- `environments/local.py:72-92`：用 `subprocess.Popen()` 真正执行命令。
- `environments/local.py:75-76`：`command` 被传给 shell，`shell=True` 是命令真正可执行的关键。

完整变化链路是：

```text
LLM 返回:
{"name": "bash", "arguments": "{\"command\": \"pytest -q\"}"}

parse_toolcall_actions() 转成:
{"command": "pytest -q", "tool_call_id": "..."}

DefaultAgent.execute_actions() 调用:
env.execute(action)

LocalEnvironment.execute() 调用:
subprocess.Popen("pytest -q", shell=True, ...)
```

这说明：**LLM 没有直接执行任何东西，它只是提出结构化请求；真正执行发生在 Environment。**

## 9. 任务完成机制

mini-swe-agent 用一个特殊输出标记表示任务完成：

- `config/default.yaml:32-33`：提示模型用 `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` 完成任务。
- `environments/local.py:45-56`：如果输出第一行是 `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` 且 returncode 为 0，就抛出 `Submitted`。

这个设计的含义是：

```text
模型请求执行 submit 命令
  -> env 执行命令
  -> env 检测特殊输出
  -> 抛出 Submitted
  -> agent loop 写入 exit message
  -> run 结束
```

这是一种很轻量的结束协议。

## 10. 轨迹保存

轨迹保存是 agent 产品很重要的基础能力。

关键位置：

- `agents/default.py:118-119`：每一步 finally 都会 save。
- `agents/default.py:157-178`：把 agent、model、environment、messages 合并成 trajectory。
- `agents/default.py:180-188`：写入 JSON 文件。

这部分对应后续 Huaness Lite 里的：

```text
Trace
EventLog
Replay
Eval
```

mini 这里还比较简单，但思路已经有了：**每轮模型输出、工具调用、工具结果都必须能被保存。**

## 11. 和成熟 Agent 产品的对照

目前已经对比过 Gemini CLI、Codex、OpenClaw 的工具系统。

可以先记住这个差别：

```text
mini-swe-agent:
  hardcoded BASH_TOOL
  no real registry
  no tool policy pipeline

Gemini CLI / Codex / OpenClaw:
  ToolRegistry
  visible tool schema filtering
  policy / approval
  executor / runtime
  observation / event stream
```

OpenClaw 的关键思路是：

```text
all tools
  -> config profile / allow / deny
  -> effective visible tools
  -> context.tools
  -> model tool call
  -> validate / before hook / execute / after hook
```

这给 Huaness Lite 的启发是：

> YAML 可以配置工具可见性和策略，但工具实现本身应该仍然由代码注册。不要一开始让 YAML 直接定义任意可执行代码。

## 12. 当前核心闭环

到目前为止，mini-swe-agent 的核心闭环已经能画出来：

```text
Config
  -> Bootstrap
  -> Agent
  -> Model
  -> Tool Call
  -> Action
  -> Environment
  -> Observation
  -> Messages
  -> Trace
```

各模块职责：

| 模块 | 当前理解 |
| --- | --- |
| `mini.py` | 启动入口，读取配置，初始化三大对象 |
| `config` | YAML 和 CLI 覆盖项解析 |
| `DefaultAgent` | 最小 agent loop |
| `InteractiveAgent` | 在 loop 周围加确认、中断、slash command |
| `LitellmModel` | 模型协议适配，发送 tools，解析 tool calls |
| `actions_toolcall.py` | 把模型 tool call 转成内部 action |
| `LocalEnvironment` | 把 action.command 变成真实 shell 命令 |
| `serialize/save` | 保存 trajectory，为 trace/replay/eval 打基础 |

## 13. 下一步阅读建议

后面建议继续看：

1. `environments/docker.py`  
   理解同一个 `execute(action)` 接口如何换成容器执行。

2. `config/mini.yaml` 和 `config/default.yaml` 对照  
   理解默认 prompt、tool call 模式和 text-based 模式之间的差异。

3. `models/litellm_textbased_model.py`  
   理解没有原生 tool call 时，如何从文本代码块里解析 action。

4. `serialize/save` 和 benchmark runner  
   理解 trajectory 如何服务于评测和批量运行。

优先级最高的是 `docker.py`，因为它能帮助理解 Environment 抽象为什么存在：**agent loop 不变，但执行后端可以从本机 shell 换成容器。**
