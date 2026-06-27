# DeepAgents Harness 源码分析

## 一句话结论

DeepAgents 厉害的地方，不是“又做了一个 agent loop”，而是把真正影响 agent 成败的执行层因素做成了一套可组合、可按模型切换、可被 benchmark 和外循环持续优化的 harness。

本报告基于本地仓库 `references/deepagents` 的源码阅读，不复述 README。重点回答三件事：

1. `Deep Agents` 的核心架构是什么。
2. 它相比常见 agent harness 强在哪。
3. 它为什么可能把 benchmark 明显拉高，以及 Huaness 能借鉴什么。

未运行任何 benchmark；因此“为什么提分”的部分是**源码机制归因**，不是复现实测。

## 0. 先把边界说清楚

`references/deepagents` 里其实有四层东西，不能混着看：

| 层 | 路径 | 作用 |
| --- | --- | --- |
| 通用 harness SDK | `libs/deepagents/deepagents/` | 真正的 runtime/harness 核心 |
| coding-agent 成品壳 | `libs/code/deepagents_code/` | 在通用 harness 之上再叠一层更偏 CLI/coding 的产品化运行时 |
| benchmark / eval | `libs/evals/`、`.github/workflows/evals.yml` | 评测分类、矩阵、Harbor 接入 |
| harness 自优化实验 | `examples/better-harness/` | 用一个 Deep Agent 去改另一个 harness |

如果你只想理解“作为 Agent Harness 它到底厉害在哪”，主线应该是：

```txt
libs/deepagents/deepagents
  -> libs/code/deepagents_code
  -> libs/evals
  -> examples/better-harness
```

## 1. Deep Agents 的核心架构是什么

### 1.1 入口不是 loop，而是 graph assembler

通用入口是 `libs/deepagents/deepagents/graph.py` 的 `create_deep_agent(...)`。

它不是“new 一个 agent，塞点 tools”，而是一个**组装器**：

- 先 resolve model / profile
- 再准备 built-in tools
- 再按顺序装 middleware
- 再补 general-purpose subagent
- 最后调用 `create_agent(...)` 生成 LangGraph graph

这意味着 DeepAgents 的核心抽象不是“一个固定 loop”，而是：

```txt
model + prompt assembly + tool surface + middleware stack + subagent runtime + approval policy
```

### 1.2 状态层先解决 checkpoint 膨胀

`graph.py` 里的 `DeepAgentState` 直接把 `messages` 放到 `DeltaChannel(_messages_delta_reducer, snapshot_frequency=50)` 上，并在注释里写明这是把 checkpoint 增长从 `O(N^2)` 降到 `O(N)`。

这件事很关键，因为它说明 DeepAgents 从一开始就在解决**长任务 runtime 成本**，而不是只关注 prompt。

### 1.3 真正的核心是 middleware-first harness

`create_deep_agent(...)` 里主代理的 middleware 主干大致是：

```txt
TodoListMiddleware
-> SkillsMiddleware? 
-> FilesystemMiddleware
-> SubAgentMiddleware?
-> create_summarization_middleware(...)
-> PatchToolCallsMiddleware
-> AsyncSubAgentMiddleware?
-> user middleware
-> profile extra middleware
-> ToolExclusion
-> AnthropicPromptCachingMiddleware
-> MemoryMiddleware?
-> HumanInTheLoopMiddleware?
```

对应源码在 `libs/deepagents/deepagents/graph.py` 后半段。

这条链已经说明它的思路不是：

```txt
loop 里 if/else 写一堆特殊逻辑
```

而是：

```txt
把影响 agent 执行质量的能力，拆成 runtime stack
```

### 1.4 subagent 不是附属功能，而是默认结构

`graph.py` 会自动补一个 `general-purpose` subagent，除非 profile 禁用，或者调用方自己覆盖。

这意味着在它的设计里，subagent 不是“高级用户才会打开的插件”，而是默认 harness 结构的一部分。

同步 subagent 的关键文件是 `libs/deepagents/deepagents/middleware/subagents.py`：

- `TASK_TOOL_DESCRIPTION` 明确告诉主代理：复杂、独立、上下文重的任务应交给 `task` tool。
- `_build_task_tool(...)` 会把 subagent spec 编译成 runnable。
- 子代理启动时，会剥离父状态里的 `messages`、`todos`、`structured_response` 等字段，只保留必要状态。
- 父代理最终只拿到一个 `ToolMessage` 结果，而不是整个子代理轨迹。

这本质上是在做：

```txt
主线程负责 orchestration
子线程负责 context isolation
```

### 1.5 summarization 不是截断，而是 recoverable compaction

`libs/deepagents/deepagents/middleware/summarization.py` 是它最强的 runtime 组件之一。

这里做的不是简单“超过窗口就砍历史”，而是：

- 到阈值后自动 compact
- 把被逐出的历史写到 `/conversation_history/{thread_id}.md`
- 把媒体单独外置保存，再在 summary 里保留引用
- 给 agent 暴露 `compact_conversation` tool，允许主动压缩
- 根据 model profile 自动计算默认 `trigger/keep`
- `ContextOverflowError` 时自动 summarize + retry

这说明它把上下文管理做成了：

```txt
可回放 + 可恢复 + 模型感知 + 工具可触发
```

而不是一次性的 prompt 截断。

### 1.6 filesystem 不是 file util，而是 coding harness 地基

`libs/deepagents/deepagents/middleware/filesystem.py` 不只是提供 `ls/read_file/write_file/edit_file/glob/grep/execute`。

它还负责：

- 权限规则 `FilesystemPermission`
- `allow / deny / interrupt` 三种模式
- 路径匹配和结果过滤
- `execute` 能力探测
- 大结果外置
- 工具描述里的 coding habit 约束

这意味着在 DeepAgents 里，filesystem 层本身就是 harness 的一部分，而不是普通工具包。

### 1.7 patch invalid/dangling tool calls

`libs/deepagents/deepagents/middleware/patch_tool_calls.py` 的 `PatchToolCallsMiddleware` 会在 agent 运行前扫描历史，把没有结果的 tool call 补成 synthetic `ToolMessage`。

它处理两类典型问题：

- arguments malformed / truncated
- tool call 被后续消息打断而未完成

这是典型的 harness 级“修 runtime 状态一致性”的工作。很多 agent 在多轮/中断/流式场景里会因为这一层没补齐而越来越乱。

### 1.8 profile 把“按模型调 harness”做成正式接口

`libs/deepagents/deepagents/profiles/harness/harness_profiles.py` 提供 `HarnessProfile` / `HarnessProfileConfig`。

可以按 provider 或按 `provider:model` 做这些覆盖：

- `base_system_prompt`
- `system_prompt_suffix`
- `tool_description_overrides`
- `excluded_tools`
- `excluded_middleware`
- `extra_middleware`
- `general_purpose_subagent`

这很重要，因为它把“模型差异”落在 runtime 层，而不是只靠一段大 system prompt 硬顶。

## 2. 它相比其他 agent harness 强在哪

### 2.1 它不是单 loop，而是可组合 runtime 栈

很多 agent 项目本质上还是：

```txt
system prompt + tool list + loop
```

DeepAgents 则明显更像：

```txt
graph assembler
  + model-aware profiles
  + state optimization
  + context compaction
  + file/shell surface
  + sync/async subagents
  + memory/skills injection
  + approval/interrupt policy
```

这使它天然更适合做 agent benchmark 和后续演进。

### 2.2 它把“模型差异”抬到了 harness 层

`libs/deepagents/deepagents/profiles/harness/_openai_codex.py` 直接给：

- `openai:gpt-5.1-codex`
- `openai:gpt-5.2-codex`
- `openai:gpt-5.3-codex`

注册了专门的 harness profile。

这份 profile 的核心 suffix 明确要求：

- autonomous senior engineer
- bias to action
- 不要先发冗长 preamble
- 并行读文件 / 并行 tool use
- 收尾前 reconcile todos

同时，`profiles/provider/_openai.py` 还给所有 `openai:*` 模型默认打开 `use_responses_api=True`。

也就是说，DeepAgents 的态度不是“一个通用 harness 跑所有模型”，而是“模型不同，harness 行为就应该不同”。

### 2.3 它把 coding-agent 的工具面做得很厚

generic SDK 已经有较强的 file/shell/subagent/summarization。

但 `libs/code/deepagents_code/agent.py` 又在上面叠了一层更偏 CLI agent 的 runtime：

- `get_system_prompt(...)` 会根据 interactive/headless、cwd、sandbox、skills path、model identity 动态拼 system prompt。
- `_add_interrupt_on()` 会给 `execute/write_file/edit_file/web_search/fetch_url/task/async task/compact_conversation` 等能力挂 approval 策略。
- `create_cli_agent(...)` 会额外装上：
  - `ResumeStateMiddleware`
  - `AskUserMiddleware`
  - `ManagedMemoryGuardMiddleware`
  - `SkillsMiddleware`
  - `LocalContextMiddleware`
  - `ShellAllowListMiddleware`
  - `create_summarization_tool_middleware(...)`
- 本地模式下，它还会把 `/large_tool_results/` 和 `/conversation_history/` 路由到独立 backend。

这说明它不是只提供 SDK，而是已经把“coding harness 常见痛点”逐层产品化了。

### 2.4 它把 async subagent 做成完整生命周期

`middleware/async_subagents.py` 不只是“后台起个 task”。

它是一整套生命周期接口：

- start
- check
- update
- cancel
- list

这比常见“task tool 只能同步等结果”的 harness 更完整，尤其适合长任务、多并发工作流和远程 graph deployment。

### 2.5 它把 harness 本身当成可优化对象

`examples/better-harness/` 是很有代表性的部分。

这里的思路不是“换个更强模型”，而是：

```txt
outer Deep Agent
  -> 编辑 inner harness 的 surface files
  -> 跑 train + holdout
  -> 只有 combined pass count 提升才接受
```

关键证据：

- `better_harness/agent.py` 的 `DEFAULT_SYSTEM_PROMPT` 直接写明：这是一个改善另一个 agent harness 的 outer-loop Deep Agent。
- `better_harness/core.py` 的 `run_experiment(...)` 里，接受条件是 `candidate_combined > current_combined`。
- `patching.py` 支持 `module_attr` 覆盖和 `workspace_file` 临时替换。

这说明 DeepAgents 团队已经把“harness engineering”本身做成正式研究对象，而不是零散经验。

## 3. 为什么它可能让 benchmark 提升明显

### 3.1 最强的一手证据：仓库自己承认 harness profile 带来大 lift

`libs/deepagents/CHANGELOG.md` 的 `0.5.4` 写得很直接：

- 之前只有一套通用 prompts/tools/middleware
- 这一版引入了 **harness profiles**
- OpenAI / Anthropic built-ins 直接吸收各家官方 prompting guide
- 在一个 curated tau2-bench subset 上，相比 default harness 有 **10-20 point lift**
  - GPT-5.3 Codex: `33% -> 53%`
  - Claude Opus 4.7: `43% -> 53%`

所以它自己给出的结论就是：

```txt
不是模型换了
而是 harness 配准了
```

### 3.2 但“gpt-5.2-codex 从 20 名外到 top5”这个具体说法，当前仓库内未直接确认

本地仓库能确认的是：

- `openai:gpt-5.2-codex` 已在 `_openai_codex.py` 和 `.github/workflows/evals.yml` 里作为正式模型规格出现。
- 官方 changelog 已明确声称 Codex family 因 harness profile 获得明显 lift。

但我**没有在当前仓库源码里看到**直接写着“gpt-5.2-codex 从 20 名外进 top5”的一手 benchmark 结论。

因此更稳妥的写法应该是：

```txt
该说法未在当前仓库中直接找到一手证据；
已确认的是：DeepAgents 官方明确声称 model-aware harness profile
对 Codex 类模型带来显著增益。
```

### 3.3 提分很可能来自这五类工程杠杆

#### 1. 上下文管理更稳

- `DeltaChannel` 降 checkpoint 膨胀
- summarization 可回放、可恢复、可主动触发
- overflow 时可 summarize + retry

这会直接减少长任务中“上下文炸了、状态乱了、直接 fail”的 case。

#### 2. 工具选择更准

- profile 可改 tool description
- filesystem middleware 自带 coding-aware tool descriptions
- local context middleware 把 cwd / git / local context 注入给模型
- task tool 明确鼓励并行和 context isolation

这会提高“选对工具、少走弯路”的概率。

#### 3. coding 任务的执行面更贴 benchmark

内置的：

- file ops
- grep/glob
- execute
- approval/interrupt
- local/sandbox cwd 约束
- headless prompt 约束

这些都属于 benchmark 很敏感的 runtime scaffolding，不是 base model 自己天然具备的能力。

#### 4. 失败恢复能力更强

`PatchToolCallsMiddleware`、summarization retry、大结果外置、权限/interrupt 等，都是在把“原本直接崩掉”的轨迹拉回正轨。

这类提升在 benchmark 里非常值钱，因为它不是让少数 case 更亮眼，而是让更多 case 不死。

#### 5. 复杂任务被切碎后，主线程更干净

sync/async subagent 都在做一件事：

```txt
把局部复杂度、局部 token 消耗、局部搜索噪音隔离出去
```

这对多步骤、多文件、多工具链任务很重要。

### 3.4 eval 分类本身就对 harness 很敏感

`libs/evals/deepagents_evals/categories.json` 和 `libs/evals/EVAL_CATALOG.md` 可以看到，评测分类包括：

- `file_operations`
- `retrieval`
- `tool_use`
- `memory`
- `conversation`
- `summarization`
- `unit_test`
- `langchain/middleware`

这些类别天然就不是只看“纯语言理解”，而是看：

```txt
runtime + context + tools + recovery + state management
```

所以 DeepAgents 这种 harness-heavy 设计，本来就容易在这类 benchmark 里体现优势。

### 3.5 仓库里甚至保留了“full harness vs bare graph”的对照入口

`libs/evals/deepagents_harbor/langgraph_project/langgraph_agent.py` 同时提供：

- `make_graph(...)`
  - 走 `create_cli_agent(...)`
  - 也就是完整的 Deep Agents Code harness
- `make_bare_graph(...)`
  - 只走 `create_deep_agent(...) + LocalShellBackend`

这个对照很有价值，因为它几乎在明示：

```txt
我们知道 harness 本身是变量
可以单独比较 full harness 和 bare SDK 的差异
```

## 4. Huaness 可以借鉴什么

### 4.1 P0 应采用

#### 1. 先把 core 写成可插拔 runtime，不要写死成单 loop 大类

Huaness Lite 的核心链路更适合长成：

```txt
AgentLoop
  + ModelAdapter
  + ToolGateway
  + Policy/Approval
  + ContextAssembler
  + Compaction
  + EventLog
  + Profile
```

而不是把这些东西都硬塞进一个 `agent-loop.ts`。

#### 2. 一开始就留出 model-aware profile slot

不一定 P0 就做很多 profile，但接口要留：

- `systemPromptSuffix`
- `toolDescriptionOverrides`
- `enabledTools`
- `enabledMiddleware`
- `approvalPolicy`

否则后面你会被迫把模型差异写进 if/else。

#### 3. 把 context compaction 当成一等能力

DeepAgents 给 Huaness 最强的启发之一就是：

```txt
压缩不是“省 token 的优化”
而是 runtime 的保命机制
```

所以 Huaness P0 至少应该有：

- 可插拔 compactor
- summary event 落 EventLog
- overflow 后的 graceful fallback

#### 4. coding / agent tool ergonomics 不是细节，是性能来源

像：

- `read_file` 分页
- `edit_file` 的约束
- shell 的 timeout / output truncate
- 工作目录与 sandbox 语义
- tool result 过大时的外置

这些都不该被当成“后面再抛光”的东西。

#### 5. 评估时要区分 bare loop 和 full harness

DeepAgents 的 Harbor 接入很值得学。Huaness 以后做 eval 时，也应该能对比：

```txt
bare runtime
vs
full runtime with profiles / compaction / policy / context helpers
```

否则你很难知道到底是模型变强了，还是 harness 变强了。

### 4.2 P1 / P2 再做

- async subagent 生命周期
- 大而全的 CLI 成品壳
- 多 provider 的完整 profile 库
- full better-harness 外循环
- 丰富的 project/user memory/skills 分层

这些都很有价值，但不适合一开始就全抄。

### 4.3 当前阶段应避免

#### 1. 不要先做“统一 prompt 神教”

DeepAgents 这次给出的重要教训恰恰是：

```txt
一个通用 prompt 跑所有模型，未必是最优
```

#### 2. 不要把 QQ / channel adapter 写进 harness 内核

你的项目目标是 agent runtime，不是 QQ bot 框架。channel 应该是 adapter，harness 应该是 core。

#### 3. 不要太早做 giant configurable platform

DeepAgents 今天这个厚度，是在 LangChain / LangGraph 能力和大量 benchmark 基础上堆出来的。Huaness Lite P0 更需要的是：

- 几个关键接口留对
- 几个关键 runtime 杠杆先做对

而不是一开始就复制它的全部表面积。

## 5. 推荐你明天怎么学

按这个顺序读最顺：

1. `libs/deepagents/deepagents/graph.py`
   - 看 `create_deep_agent(...)` 到底在装什么。
2. `middleware/subagents.py`
   - 理解 `task` 为什么是 runtime 能力，不是普通工具。
3. `middleware/summarization.py`
   - 理解 recoverable compaction。
4. `middleware/filesystem.py`
   - 看 coding harness 的工具面为什么会影响结果。
5. `profiles/harness/_openai_codex.py`
   - 理解 model-aware harness 的最小例子。
6. `libs/code/deepagents_code/agent.py`
   - 看他们如何把 generic runtime 包装成 coding-agent 产品壳。
7. `libs/evals/deepagents_harbor/langgraph_project/langgraph_agent.py`
   - 看 full harness 与 bare SDK 的对照。
8. `examples/better-harness/`
   - 看他们如何把“改 harness”本身做成外循环。

## 6. 最终判断

如果把它压成一句工程判断：

```txt
DeepAgents 的优势，不在某个神奇 loop，
而在它把 prompt、tools、context、state、approval、subagent、memory、benchmark
这些原本散落的 agent 工程点，收敛成了一套可配置、可对比、可持续优化的 harness。
```

对 Huaness Lite 来说，最值得学的不是“复制它有多少 feature”，而是这三个原则：

1. **runtime 要模块化，而不是单 loop 神类**
2. **模型差异要落在 harness profile，不要靠人工临时补 prompt**
3. **context / tool / policy / replay / eval 都是 agent 能力的一部分，不是外围杂项**
