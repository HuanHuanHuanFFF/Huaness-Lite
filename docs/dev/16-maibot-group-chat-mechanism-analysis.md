# MaiBot 群聊场景机制源码调查

## 一句话结论

MaiBot 群聊能力强，不是因为“每条消息都让 Agent 回答”，而是因为它在 Agent 前面做了一层群聊运行时：平台消息先被按会话分流、缓存、批量收集、防抖和节流，再由规则门控 + LLM Timing Gate + Planner 工具选择决定是否真正发言。

本报告只分析本地源码 `references/maibot`，没有运行 MaiBot。结论以源码路径、类名、函数名为准；未能确认的部分会明确标注“未确认”。

## 1. 总体链路

MaiBot 的群聊主链路可以简化成：

```txt
平台驱动
  -> PlatformIOManager.accept_inbound()
  -> _schedule_inbound_dispatch()
  -> ChatBot.message_process()
  -> ChatBot.receive_message()
  -> chat_manager 注册消息/会话
  -> 命令插件优先拦截
  -> HeartFCMessageReceiver.process_message()
  -> HeartflowManager.get_or_create_heartflow_chat()
  -> MaisakaHeartFlowChatting.register_message()
  -> message_cache 缓存
  -> _schedule_message_turn()
  -> MaisakaReasoningEngine.run_loop()
  -> Timing Gate: continue / wait / no_action
  -> Planner
  -> ToolRegistry.invoke()
  -> reply / tool / wait / no_action / finish
```

关键文件：

| 层级 | 文件 | 关键函数/类 | 作用 |
| --- | --- | --- | --- |
| 平台入站 | `references/maibot/src/platform_io/manager.py` | `PlatformIOManager.accept_inbound()`、`_schedule_inbound_dispatch()` | 验收平台消息、去重、异步分发 |
| 消息入口 | `references/maibot/src/chat/message_receive/bot.py` | `ChatBot.message_process()`、`receive_message()` | 统一消息格式、预处理、过滤、命令拦截、路由到 Maisaka |
| 会话管理 | `references/maibot/src/chat/message_receive/chat_manager.py` | `ChatManager.register_message()`、`get_or_create_session()` | 维护群聊/私聊会话和最近消息 |
| HeartFlow | `references/maibot/src/chat/heart_flow/heartflow_message_processor.py` | `HeartFCMessageReceiver.process_message()` | 写入消息、登记人物、找到对应 runtime |
| Runtime | `references/maibot/src/chat/heart_flow/heartflow_manager.py` | `HeartflowManager.get_or_create_heartflow_chat()` | 按 `session_id` 创建/复用 per-session runtime |
| 群聊运行时 | `references/maibot/src/maisaka/runtime.py` | `MaisakaHeartFlowChatting` | 缓存消息、调度 turn、打断、退避、工具注册 |
| 决策循环 | `references/maibot/src/maisaka/reasoning_engine.py` | `MaisakaReasoningEngine.run_loop()` | Timing Gate、Planner、工具执行、历史裁剪 |

## 2. 群聊消息处理机制

### 2.1 平台消息不是同步堵在入口

`PlatformIOManager.accept_inbound()` 先检查路由绑定和去重，然后调用 `_schedule_inbound_dispatch()`。后者用 `asyncio.create_task(self._inbound_dispatcher(envelope))` 投递后台任务，见 `references/maibot/src/platform_io/manager.py:450` 和 `:481`。

这说明平台入口不是直接等待完整 Agent 推理完成。它只负责验收和分发，真正的会话推理在后续 runtime 中处理。

### 2.2 入站仍然是逐条预处理，但不是逐条回复

`ChatBot.receive_message()` 每次处理一条 `SessionMessage`，但它做的是入站预处理和入队前处理，不是直接调用 LLM 回复：

- 计算 `session_id`：`references/maibot/src/chat/message_receive/bot.py:531`。
- 处理过大图片：`:540`。
- 调用 `message.process(...)`，并明确关闭重型媒体分析：`:586-593`。
- 过滤禁词和正则：`:607-620`。
- 注册消息和会话：`:622-633`。
- 命令系统先处理，命令可拦截后续 Agent：`:637-643`。
- 私聊/群聊最终都路由到 `heartflow_message_receiver.process_message()`：`:651-657`。

这里有一个很重要的设计细节：源码注释明确说入站主链“优先保证消息尽快入队，避免图片、表情包、语音分析阻塞适配器超时”。也就是说，群聊高频场景里，MaiBot 不把重活放在消息入口。

### 2.3 群聊和私聊会话是分开的

群聊/私聊的区分首先来自 `group_info` 是否存在。`SessionUtils.calculate_session_id()` 会用不同组件生成会话 ID：

- 群聊：`platform + route components + group_id`。
- 私聊：`platform + route components + user_id + private`。

对应文件是 `references/maibot/src/common/utils/utils_session.py`。

这意味着群聊在 runtime 里被当作一个持续流，而不是“每个群成员一条独立对话”。`chat_manager.py` 里还会在群聊 session 身份中清掉最近发言人的用户字段，避免把群会话错误绑定成某个人的私聊身份。

### 2.4 有消息缓存、批量收集和防抖

核心在 `MaisakaHeartFlowChatting`：

- `message_cache` 保存收到但未被消化的消息，初始化见 `references/maibot/src/maisaka/runtime.py:99`。
- `register_message()` 把新消息 append 到 `message_cache`，见 `:694-702`。
- `_collect_pending_messages()` 从 `_last_processed_index` 开始一次性收集待处理消息，并按 `message_id` 去重，见 `:1612-1635`。
- `_wait_for_message_quiet_period()` 在 planner 被新消息打断后等待静默窗口，默认约 1 秒，见 `:1637-1653`。

所以 MaiBot 的群聊不是：

```txt
收到一条消息 -> 调一次 LLM -> 回复或不回复
```

而更接近：

```txt
收到多条消息 -> 缓存 -> 达到触发条件 -> 等群聊短暂安静 -> 一次性构造上下文 -> 决定是否接话
```

### 2.5 触发方式：@、昵称/别名、回复、频率阈值、沉默补偿

`references/maibot/src/chat/utils/utils.py` 的 `is_mentioned_bot_in_message()` 做了多种提及检测：

- 平台上游标记：`additional_config.at_bot`、`additional_config.is_mentioned`。
- 消息段里的 `mention_bot`。
- QQ 风格或通用风格的 `@账号`。
- 回复机器人消息。
- 文本中出现机器人昵称或别名。

命中后，`MaisakaHeartFlowChatting._update_message_trigger_state()` 会给消息打 `is_at` / `is_mentioned`，并可能触发 `_arm_force_next_timing_continue()`，见 `references/maibot/src/maisaka/runtime.py:1036`。

回复频率不是简单“每条消息掷骰子”。MaiBot 把频率转成触发阈值：

- `_get_effective_reply_frequency()` 读取群聊/私聊基础频率和动态调整，见 `runtime.py:754`。
- `_get_message_trigger_threshold()` 用 `ceil(1 / effective_frequency)` 得到需要积累多少条消息才开一轮。
- `_should_trigger_message_turn_by_idle_compensation()` 允许“沉默时间”折算为等效消息数，但不会让纯沉默凭空触发，见 `runtime.py:985`。

未确认：没有在主链路里看到一个单独的“语义关键词规则触发器”。如果把“根据上下文判断是否接话”算作上下文触发，那么它发生在 Timing Gate LLM，而不是前置硬编码规则。

### 2.6 buffer 里的消息什么时候真正“刷出”

MaiBot 里“刷出 buffer”不是指 `register_message()` 立刻把消息送给 Planner，而是：

```txt
register_message()
  -> _schedule_message_turn()
  -> run_loop() 被唤醒
  -> 等静默窗口
  -> _collect_pending_messages()
  -> _ingest_messages(cached_messages)
  -> Timing Gate
  -> Planner
```

也就是说，消息先进入 `message_cache`，只有 turn 真正开始后，才会从 `_last_processed_index` 之后统一收集出来。关键点：

- `_collect_pending_messages()` 会从 `message_cache` 里收集尚未进入内部循环的消息，并按 `message_id` 去重，见 `references/maibot/src/maisaka/runtime.py:1612-1635`。
- `run_loop()` 会先调用 `_collect_pending_messages()`，再 `await self._ingest_messages(cached_messages)`，见 `references/maibot/src/maisaka/reasoning_engine.py:917-933`。
- 因此，Timing Gate 判断时，看到的已经不是 buffer 本身，而是刚刚 ingest 进共享 `_chat_history` 的这批消息。

这点很重要：MaiBot 不是“Timing Gate 通过后才把 buffer 放出来”，而是“先把本轮待处理消息刷进共享历史，再由 Timing Gate 决定要不要继续进 Planner”。

### 2.7 buffer 刷出的调度阈值

真正决定“什么时候开始一次刷出”的，是 `_schedule_message_turn()`，见 `references/maibot/src/maisaka/runtime.py:1559-1610`。它不是一个单一的 buffer size，而是一组条件：

- `pending_count > 0`
  - 没有待处理消息就不调度。
- `silent mode`
  - 如果当前回复频率为 0，会立刻排一次 `"message"` turn，但这是静默接收模式，不等于普通可见回复。
- `@ / mention 强触发`
  - 命中强触发后会直接排 turn，绕过普通频率阈值。
- `no_action backoff`
  - 如果最近连续几轮都是 `no_action`，群聊会进入退避期，临时延迟新的 turn。
- `pending_count >= trigger_threshold`
  - 普通阈值来自 `_get_message_trigger_threshold()`，公式是 `ceil(1 / effective_frequency)`，见 `references/maibot/src/maisaka/runtime.py:866-871`。
- `idle compensation`
  - 如果消息数还没达到阈值，但已经安静了一段时间，会把沉默时间折算为“等效消息数”，见 `references/maibot/src/maisaka/runtime.py:985-1015`。
- `deferred wakeup`
  - 如果当前既没到阈值，也还没补齐沉默补偿，就按最近平均消息间隔算一个 `delay_seconds`，挂一个延迟任务，时间到再重试调度。

一个简化例子：

```txt
effective_frequency = 0.5
-> trigger_threshold = ceil(1 / 0.5) = 2
-> 至少 2 条新消息触发

effective_frequency = 0.25
-> trigger_threshold = 4
-> 至少 4 条新消息，或者“少量消息 + 一段沉默”触发
```

另外，真正开始 collect 前还有一次静默防抖：

- `_wait_for_message_quiet_period()` 默认等待约 1 秒，见 `references/maibot/src/maisaka/runtime.py:115` 和 `:1637-1653`。

### 2.8 命令流和聊天流是分开的

MaiBot 没把所有入站群消息都当成自然聊天。`ChatBot.receive_message()` 会先走 `_process_commands()`，再根据 `continue_process` 决定是否继续进入 HeartFlow / Maisaka，见 `references/maibot/src/chat/message_receive/bot.py:242-335` 和 `:365-386`。

这条边界可以理解成：

```txt
命令流:
消息 -> 命令匹配 -> 执行命令 -> 是否拦截主链

聊天流:
消息 -> buffer -> Timing Gate -> Planner -> Replyer
```

其中 `_handle_command_processing_result()` 的语义很直接：

- `continue_process = True`
  - 命令执行过了，但仍然允许继续落入聊天主链。
- `continue_process = False`
  - 命令已经处理完，本条消息到此为止，不再进入 HeartFlow / Maisaka。

这对群聊很重要，因为群里会同时存在：

- 自然聊天
- slash command / 插件命令
- 明确控制消息

如果不分流，这些命令会污染对话上下文，也会把本来不需要 LLM 的操作硬塞进 Agent loop。

## 3. 是否回复的决策逻辑

MaiBot 的“回不回复”不是一个函数决定，而是分层决策。

| 阶段 | 代码位置 | 决策内容 | 类型 |
| --- | --- | --- | --- |
| 入站过滤 | `ChatBot.receive_message()` | 过滤禁词、正则、hook abort、命令是否拦截 | 规则 |
| turn 调度 | `MaisakaHeartFlowChatting._schedule_message_turn()` | 是否达到频率阈值、是否 @ 强制、是否 wait、是否 no_action 退避 | 规则 |
| Timing Gate | `MaisakaReasoningEngine._run_timing_gate()` | 当前是否应该继续思考、等待、还是不行动 | LLM + 工具约束 |
| Planner | `MaisakaReasoningEngine.run_loop()` + `MaisakaChatLoopService.chat_loop_step()` | 具体做什么：reply、tool、wait、no_action、finish | LLM + 工具约束 |
| Tool 执行 | `_handle_tool_calls()` | 执行模型选择的工具，并把 observation 写回上下文 | 程序执行 |

### 3.1 规则层先决定是否值得开一轮

`_schedule_message_turn()` 会判断当前会话是否能进入 focus、是否处于 wait、是否已有待处理消息、是否 silent、是否 @ 强制、是否处于 `no_action` 退避、是否达到消息阈值，见 `references/maibot/src/maisaka/runtime.py:1559`。

群聊专属的 `no_action` 退避在 `_should_delay_for_no_action_backoff()`，如果不是群聊直接返回 false，见 `runtime.py:1181-1189`。这能减少“刚刚判断不该说话，下一条普通闲聊又立刻开一轮”的抢话行为。

### 3.2 Timing Gate 是专门判断“现在该不该接话”的小 Agent

`MaisakaReasoningEngine._run_timing_gate()` 在 `references/maibot/src/maisaka/reasoning_engine.py:567`。它只允许选择有限动作：

```txt
continue  -> 继续进入 Planner
wait      -> 等一段时间再判断
no_action -> 本轮不行动
```

如果是 @ 或强提及，runtime 可以设置 `_force_next_timing_continue`，Timing Gate 会直接走 forced continue，见 `reasoning_engine.py:573`。

Timing Gate 的提示词在 `references/maibot/prompts/zh-CN/maisaka_timing_gate.prompt`。它的核心思想是：判断用户是在和机器人互动，还是用户之间聊天；不要盲目插话。

### 3.3 Planner 再决定“怎么做”

Timing Gate 返回 `continue` 后，才进入主 Planner。Planner 使用 `references/maibot/prompts/zh-CN/maisaka_chat.prompt`，可以选择可见回复、等待、不行动、查询记忆、调用工具等动作。

这点很关键：MaiBot 把“是否应该接话”和“接话时怎么做”拆开了。通用 Agent 很容易把这两件事混在一次 LLM 调用里，结果在群聊里表现为过度响应、抢话、无上下文感。

### 3.4 更准确地说：不是 3 个常驻 Agent，而是 3 段不同职责的模型调用

用户视角上可以把 MaiBot 理解成 Timing Gate、Planner、Replyer 三层；但从 runtime 结构看，它不是 3 个彼此独立、各自维护长期状态的常驻 agent。

- Timing Gate
  - 由 `references/maibot/src/maisaka/reasoning_engine.py:567-650` 的 `_run_timing_gate()` 驱动。
  - 本质是工具受限的小型子代理，只能在 `continue / wait / no_action` 里选。
- Planner
  - 由 `references/maibot/src/maisaka/reasoning_engine.py:884-1178` 的 `run_loop()` 主循环驱动。
  - 它负责决定要不要 `reply`、`wait`、`no_action`，或者调用其他工具。
- Replyer
  - 不是每轮都运行。
  - 只有 Planner 真的选中了 `reply` 工具后，`references/maibot/src/maisaka/builtin_tool/reply.py:141-154` 才会复制当前 `runtime._chat_history`，再调用 `replyer.generate_reply_with_context(...)` 生成最终可见文本。

更准确的理解应该是：

```txt
同一个 session runtime
  -> 同一份共享历史
  -> 三种不同职责的模型调用
```

这就是为什么它看起来像“三个 agent”，但又不会出现三套会话状态各自漂移的问题。

## 4. 上下文构建方式

MaiBot 的上下文不是单纯“最近 N 条聊天记录”。它由系统 prompt、短期历史、中期摘要、工具结果、行为参考、记忆参考、人物画像、当前时间和当前聊天注意事项组成。

### 4.1 System prompt 拼哪些

`MaisakaChatLoopService._build_request_messages()` 会先构造一个 system message，见 `references/maibot/src/maisaka/chat_loop_service.py:809-836`。

系统 prompt 来自 `_build_chat_system_prompt()`，它加载当前聊天模板：

- focus mode 用 `maisaka_chat_focus`。
- 普通聊天用 `maisaka_chat`。

模板上下文由 `build_prompt_template_context()` 提供，见 `chat_loop_service.py:726-735`，包括：

- `bot_name`：机器人名字。
- `file_tools_section`：工具说明片段。
- `group_chat_attention_block`：群聊或私聊通用注意事项。
- `identity`：人格提示。
- `timing_gate_wait_rule`：wait 工具说明。

人格提示由 `_build_personality_prompt()` 构造，见 `chat_loop_service.py:684-700`。它会拼：

```txt
你的名字是{bot_name}{aliases}。
{global_config.personality.personality}
```

如果人格配置为空，fallback 是“是人类。”。

### 4.2 额外记忆和当前时间是 user role

`_build_request_messages()` 在 system 和历史之后，还会追加一些 `RoleType.User` 消息，见 `chat_loop_service.py:846-866`：

- `injected_user_messages`：例如记忆参考、人物画像、行为参考等。
- 当前时间。
- `tail_user_messages`。
- 当前聊天额外注意事项。

这说明 MaiBot 的“记忆参考/当前时间/当前聊天注意事项”不是继续塞进 system，而是作为尾部 user 消息注入。这样做的好处是 system 保持稳定，人格和核心行为约束不被大量动态内容污染。

### 4.3 历史窗口选择

`select_llm_context_messages()` 在 `references/maibot/src/maisaka/chat_loop_service.py:1094`：

- 先按请求类型过滤历史：Timing Gate、Planner、sub-agent 能看到的历史不同。
- 从最新消息往前选。
- 只统计 `count_in_context` 的消息数量。
- 有 `CONTEXT_SELECTION_CACHE_STABILITY_RATIO`，effective window 会大于 base window，用于 prompt cache 稳定。
- `mid_term_memory` 会被 pin，不随普通窗口自然淘汰。

不同请求的过滤逻辑在 `_filter_history_for_request_kind()`，见 `chat_loop_service.py:1176-1280`：

- Timing Gate 会过滤掉 Planner 工具提示和行为参考，避免被“怎么回复”的材料干扰“该不该回复”。
- Planner 会过滤掉一部分 Timing Gate 工具残留，避免让主 Planner 被前置门控噪音污染。

### 4.4 上下文压缩：裁剪后生成中期摘要并插回历史

每轮结束后，`_post_process_chat_history_after_cycle()` 会调用 `process_chat_history_after_cycle()` 裁剪历史，见 `references/maibot/src/maisaka/reasoning_engine.py:1579-1590`。

如果有被裁掉的消息，且配置启用了 `mid_term_memory`，它会：

```txt
removed_messages
  -> build_mid_term_memory_message()
  -> insert_mid_term_memory_message()
  -> final_history
```

对应代码在 `reasoning_engine.py:1607-1622`。摘要结构在 `references/maibot/src/maisaka/memory/mid_term.py`，核心字段包括 `brief`、`long_summary`、`keywords`。

这不是“把整个上下文压成一个 summary 替换掉”，而是把被裁掉的一段历史总结成中期记忆消息，再作为 pinned context 保留下来。

### 4.5 Timing Gate、Planner、Replyer 三条上下文视图

MaiBot 不会让三条子流程各自维护三份独立历史。它们共享同一份 `_chat_history`，但读取的是不同视图。

#### Timing Gate 看到什么

- `system prompt`
  - 来自 `maisaka_timing_gate.prompt`，入口在 `references/maibot/src/maisaka/reasoning_engine.py:426-432`。
  - 模板参数复用 `build_prompt_template_context()`，也就是 `bot_name`、`identity`、`group_chat_attention_block`、`timing_gate_wait_rule`。
- `history`
  - 从共享 `_chat_history` 中选，`request_kind="timing_gate"`。
- `过滤规则`
  - 过滤掉 `planner_tool_hint`、`behavior_pattern`、以及非 Timing Gate 工具链痕迹。
  - 只保留 `continue / no_action / wait` 相关工具调用和结果，见 `references/maibot/src/maisaka/chat_loop_service.py:1183-1230`。
- `额外内容`
  - 当前时间。
  - 当前聊天额外注意事项。
- `工具`
  - 只提供 `continue`、`wait`、`no_action`。

它的职责是：只判断“现在该不该接话”，不负责复杂工具规划。

#### Planner 看到什么

- `system prompt`
  - 来自 `maisaka_chat.prompt` 或 `maisaka_chat_focus.prompt`。
- `history`
  - 从共享 `_chat_history` 中选，`request_kind="planner"`。
  - 能看到真实聊天、工具 observation、中期摘要，以及部分行为参考。
- `额外注入`
  - `deferred_tools_reminder`
  - `heuristic memory`
  - `person profile`
  - focus mode 的尾部 overview
  - 当前时间和当前聊天额外注意事项
  - 见 `references/maibot/src/maisaka/reasoning_engine.py:477-517` 和 `:1064-1085`。
- `工具`
  - 可见 action tools + 已发现的 deferred tools。

它的职责是：决定“接下来该做什么”。

#### Replyer 看到什么

- `system prompt`
  - 来自 `maisaka_replyer.prompt`，见 `references/maibot/src/chat/replyer/maisaka_generator_base.py:424-448`。
  - 模板参数包括：
    - `identity`
    - `reply_style`
    - `group_chat_attention_block`
    - `replyer_output_instruction`
- `history`
  - 也来自共享 `_chat_history` 快照，但会先强过滤。
- `过滤规则`
  - Replyer 不接收：
    - `ReferenceMessage`
    - `ToolResultMessage`
    - tool result media
    - `mid_term_memory`
  - 见 `references/maibot/src/chat/replyer/maisaka_generator_base.py:756-770`。
- `保留内容`
  - 真实用户聊天。
  - bot 之前真正发出去的 `guided_reply`。
- `额外注入`
  - `expression_habits`
  - 临时说话风格
  - 目标消息块
  - `【最新推理】`，也就是 Planner 给出的回复理由
  - 额外回复要求
  - 关键词反应提示
  - 最终输出格式要求
  - 见 `references/maibot/src/chat/replyer/maisaka_generator_base.py:455-477` 和 `:522-571`。

它的职责是：把 Planner 的意图转成最终自然语言，而不是继续做主决策。

这一层拆分非常关键，因为：

```txt
Planner 的上下文最全、最脏
Replyer 的上下文最净、最贴近最终发言
```

这能减少“内部工具痕迹、记忆提示、策略提示”泄露到最终群聊发言里。

### 4.6 不是三个子流程各压一份上下文

这里最容易误解。MaiBot 的上下文压缩不是：

```txt
Timing Gate 压一份
Planner 压一份
Replyer 再压一份
```

真实实现更接近：

```txt
共享 _chat_history
  -> 每轮结束后统一裁剪一次
  -> 被裁掉的部分可生成 mid_term_memory
  -> 下一轮 Timing Gate / Planner / Replyer 再各自读取不同视图
```

源码证据：

- 统一裁剪入口在 `references/maibot/src/maisaka/reasoning_engine.py:1565-1660`。
  - `_end_cycle()` 会调用 `_post_process_chat_history_after_cycle()`。
  - `_post_process_chat_history_after_cycle()` 直接修改共享的 `self._runtime._chat_history`。
- Replyer 拿到的是共享历史的一个快照副本，而不是它自己维护的独立历史。
  - `references/maibot/src/maisaka/builtin_tool/reply.py:141-148`
  - `replyer_chat_history = list(tool_ctx.runtime._chat_history)`
- Replyer 自己只做过滤，不会再把另一份 summary 写回主历史。
  - 过滤逻辑在 `references/maibot/src/chat/replyer/maisaka_generator_base.py:760-770`
  - 它会过滤 `ReferenceMessage`、`ToolResultMessage`、tool media 和 `mid_term_memory`

所以不会出现“3 个 agent 压出了 3 份不同 summary，然后互相打架”的情况。真正存在的差异是：

- 它们读的是同一份历史的不同视图。
- 这些视图是刻意做出来的职责隔离，而不是状态分裂。

## 5. 记忆系统

MaiBot 的记忆是多层结构，不是一个简单 vector search。

| 层级 | 代码位置 | 作用 |
| --- | --- | --- |
| 入站消息缓存 | `MaisakaHeartFlowChatting.message_cache` | 保存尚未被 runtime 消化的新消息 |
| LLM 短期历史 | `MaisakaHeartFlowChatting._chat_history` | 保存已经进入 LLM 上下文的消息、工具调用、工具结果 |
| 消息数据库 | `MessageUtils.store_message_to_db_async()` | 保存原始消息，支持恢复和长期处理 |
| 中期摘要 | `memory/mid_term.py` | 对被裁剪历史生成摘要并 pin 回上下文 |
| 长期记忆服务 | `services/memory_service.py` | 包装 A-memorix 的搜索、写入、维护、画像接口 |
| 启发式召回 | `memory/heuristic_injector.py` | 根据最近聊天印象召回相关长期记忆 |
| 人物画像 | `memory/person_profile.py` | 根据当前发言者、@ 对象、reply 目标注入人物信息 |
| 表达/行为/黑话学习 | `src/learners/*` | 从裁剪历史里提炼表达风格、行为模式、高频词 |
| 回复效果跟踪 | `reply_effect/tracker.py` | 观察机器人发言后的用户反馈，用于后续学习 |

### 5.1 长期记忆接口

`MemoryService` 在 `references/maibot/src/services/memory_service.py`，核心方法包括：

- `search()`：调用 `search_memory`，支持 `query`、`chat_id`、`person_id`、时间范围、`user_id`、`group_id`，见 `:197-234`。
- `ingest_summary()`：写入聊天摘要，见 `:260-295`。
- `ingest_text()`：写入文本，支持 `source_type`、`person_ids`、`entities`、`relations`，见 `:297-342`。
- `get_person_profile()`：获取人物画像，见 `:344-356`。
- `maintain_memory()`：维护记忆，见 `:358-377`。

### 5.2 记忆不是每轮都无脑召回

`HeuristicMemoryInjector.build_injection_message()` 在 `references/maibot/src/maisaka/memory/heuristic_injector.py:65`。它会先判断：

- 功能开关是否启用。
- 当前 session 是否能解析。
- 当前会话消息数是否达到窗口阈值。
- 是否命中缓存 TTL。
- 是否满足最小触发间隔。
- 是否有足够新增消息。

然后才基于最近窗口构造聊天 impression，再搜索相关长期记忆。

这说明 MaiBot 在群聊里非常克制：长期记忆召回不是“每条消息搜一次”，而是有窗口、节流、缓存和范围控制。

### 5.3 裁剪历史会触发后台学习

`_post_process_chat_history_after_cycle()` 裁剪历史后，会 `asyncio.create_task(self._runtime._trigger_trimmed_history_learning(...))`，见 `references/maibot/src/maisaka/reasoning_engine.py:1654-1660`。

`_trigger_trimmed_history_learning()` 再后台运行：

- 表达和黑话学习。
- 行为模式学习。
- 高频词学习。

对应入口在 `references/maibot/src/maisaka/runtime.py:1701-1818`。

这就是 MaiBot 真实感的一个来源：它不是只靠 prompt 写“你要像人”，而是从群聊历史中持续抽取表达习惯、行为模式和人物信息。

## 6. 人格、关系、情绪建模

### 6.1 人格来自稳定 prompt，不是动态状态机

人格主要由 `_build_personality_prompt()` 拼入 system prompt，见 `references/maibot/src/maisaka/chat_loop_service.py:684-700`。

它包括：

- bot 名字。
- bot 别名。
- `global_config.personality.personality`。

群聊/私聊额外注意事项由 `_build_group_chat_attention_block()` 拼入 prompt 模板，见 `chat_loop_service.py:744-759`。当前聊天的额外注意事项作为尾部 user 消息注入，见 `:761-769`。

### 6.2 关系感主要来自人物画像和行为模式

人物侧：

- 收到消息时会登记 `Person`，包括平台用户、昵称、群名片等。
- `person_profile.py` 会选择画像候选：私聊看当前用户，群聊看最近消息中的发言人、@ 对象、reply 目标。
- 画像再作为参考消息注入 Planner。

行为侧：

- `BehaviorPatternSelector.retrieve_for_planner()` 会基于当前场景召回历史行为模式。
- 排序会考虑成功次数、失败次数、激活次数、profile tag 匹配等。
- 行为参考以 `behavior_pattern` source 注入 Planner。

这比单纯“给模型一段人设”更像真人，因为它让模型知道“面对这个人/这个群/这种场景，以前怎样做过、效果如何”。

### 6.3 情绪更偏表达选择，不是已确认的全局 mood 引擎

已确认的情绪链路主要在表情和表达选择：

- `references/maibot/src/emoji_system/maisaka_tool.py` 处理 `requested_emotion`、`matched_emotion`、`emotions`。
- `chat_loop_service.py` 中存在 `request_kind = "emotion"` 的请求类型。
- 表达学习和表达选择 prompt 会考虑聊天情绪、话题、表达风格。

未确认：这次没有确认到一个长期持久化的全局 mood 变量，或者显式的“亲密度数值状态机”。所以不能把 MaiBot 讲成完整情绪仿真系统。更准确的说法是：它有稳定人格、人物画像、行为模式、表达学习和情绪化表情选择。

## 7. 工具调用能力

### 7.1 统一工具注册表

工具入口是 `ToolRegistry`，在 `references/maibot/src/core/tooling.py`：

- `ToolSpec` 描述工具。
- `ToolInvocation` 描述一次调用。
- `ToolExecutionContext` 描述执行上下文。
- `ToolProvider` 是 provider 协议。
- `ToolRegistry.list_tools()` 列出可用工具。
- `ToolRegistry.invoke()` 执行工具。

`MaisakaHeartFlowChatting._register_tool_providers()` 注册默认 provider，见 `references/maibot/src/maisaka/runtime.py:1252`：

- 内置工具 provider。
- 插件工具 provider。

MCP 工具不是在这里直接注册，而是在 MCPManager 初始化成功后，再通过 `references/maibot/src/maisaka/runtime.py:1898-1915` 单独 `register_provider(MCPToolProvider(...))`。

### 7.2 工具不是一次全部暴露给 Planner

`MaisakaReasoningEngine._build_action_tool_definitions()` 会区分当前可见工具和 deferred tools，见 `references/maibot/src/maisaka/reasoning_engine.py:434`。

这意味着 Planner 初始看到的工具集合是受控的。若需要更多工具，可以通过 `tool_search` 类工具展开 deferred tools。

这个设计适合群聊：群聊里不应该每次都把所有复杂能力暴露给模型，否则工具选择噪音会很大，也会提高误触发概率。

### 7.3 插件和 MCP

插件工具由 `PluginToolProvider` 接入，见 `references/maibot/src/plugin_runtime/tool_provider.py`。实际调用会进入 `component_query_service.invoke_tool_as_tool()`，见 `references/maibot/src/plugin_runtime/component_query.py:909`。

MCP 工具由 `MCPToolProvider` 接入，见 `references/maibot/src/mcp_module/provider.py`。实际调用进入 `MCPManager.call_tool_invocation()`。

### 7.4 任务到底是谁执行的

MaiBot 里真正执行任务的不是 Planner 本身，而是：

```txt
Planner
  -> 选择 tool + 参数
  -> _handle_tool_calls()
  -> ToolRegistry.invoke()
  -> builtin / plugin / MCP provider 执行
```

也就是说：

- Planner 负责决策。
- ToolRegistry / ToolProvider 负责真实执行。
- Replyer 负责把最终回复说出来。

这点在群聊里尤其重要，因为“该不该查”“查什么”“怎么说”不应该由一个阶段全部包办。

### 7.5 reply 工具和回复对象定位

群聊里一个非常关键的细节是：Replyer 不是凭“最后一条消息看起来像谁说的”去猜回复对象，而是由 `reply` 工具显式传 `msg_id`。

关键实现：

- `reply` 工具声明要求 `msg_id`，见 `references/maibot/src/maisaka/builtin_tool/reply.py:31-58`。
- 执行时会先用 `msg_id` 找到目标消息，见 `references/maibot/src/maisaka/builtin_tool/reply.py:97-118`。
- Replyer 在最终 user message 里还会单独构造“本次回复目标”块，把：
  - 发言人
  - 目标 `msg_id`
  - quote 关系
  - 目标消息内容
  明确写进去，见 `references/maibot/src/chat/replyer/maisaka_generator_base.py:155-195`。

这能显著降低群聊里“回了，但回错人”的概率。

### 7.6 Replyer 接的是共享历史副本，不是独立会话

`reply` 工具并不是“Planner 直接把一句文本吐给平台”。中间还有一层很关键的衔接：

```txt
Planner 选择 reply(msg_id, ...)
  -> reply builtin tool
  -> 复制当前 runtime._chat_history
  -> Replyer 过滤历史并生成最终文本
  -> send
```

关键代码：

- `references/maibot/src/maisaka/builtin_tool/reply.py:141-148`
  - `replyer_chat_history = list(tool_ctx.runtime._chat_history)`
  - `replyer.generate_reply_with_context(...)`
- `references/maibot/src/chat/replyer/maisaka_generator_base.py:967-977`
  - Replyer 先从这份副本里筛出自己保留的历史
- `references/maibot/src/chat/replyer/maisaka_generator_base.py:1048-1056`
  - 再基于过滤后的历史、目标消息、`reply_reason`、`reply_tool_args` 组装最终请求

因此：

- Planner 负责“决定回谁、为什么回、要注意什么”。
- Replyer 负责“把这件事说得像群里自然说话”。
- 但它们仍然属于同一个 session runtime，而不是两个独立对话线程。

还要再强调一层：Replyer 这里没有再走一遍通用 `ToolRegistry.invoke()`。`reply` builtin tool 在定位目标消息后，直接 `await replyer.generate_reply_with_context(...)`，见 `references/maibot/src/maisaka/builtin_tool/reply.py:131-154`。Replyer 内部也会先过滤 `ToolResultMessage`、`ReferenceMessage`、tool result media 和 `mid_term_memory`，见 `references/maibot/src/chat/replyer/maisaka_generator_base.py:760-770`。所以 Replyer 不是“第二个通用工具 Agent”；它最多通过 `sub_agent_runner` 触发表达方式选择这一类受控子流程，而不是继续执行任意用户工具。

## 8. 异步工具和长任务是否阻塞群聊

这里要分清三层。

### 8.1 不阻塞平台入口

平台入站通过 `asyncio.create_task()` 异步分发，见 `references/maibot/src/platform_io/manager.py:481`。

入站预处理刻意关闭重型媒体分析，见 `references/maibot/src/chat/message_receive/bot.py:586-593`。

每个 `session_id` 有自己的 `MaisakaHeartFlowChatting` runtime，`HeartflowManager.get_or_create_heartflow_chat()` 负责创建/复用，见 `references/maibot/src/chat/heart_flow/heartflow_manager.py:26`。

因此，一个群的当前推理不会把整个平台入口堵死。

### 8.2 普通工具会阻塞当前会话的当前 Planner 轮

`_handle_tool_calls()` 是按工具顺序循环执行，并且每个工具调用是：

```typescript
result = await self._runtime._tool_registry.invoke(invocation, execution_context)
```

见 `references/maibot/src/maisaka/reasoning_engine.py:2288-2297`。

所以普通 LLM tool 并不是“后台 job 化”。如果一个工具很慢，它会阻塞当前群会话的当前 planner round。新的群消息仍然能进入缓存，但当前会话这一轮要等工具返回、超时或报错后才能继续。

插件工具有 RPC timeout。`component_query.py` 调用插件时会传 `timeout_ms=resolve_component_rpc_timeout_ms(...)`，默认超时可从 `plugin_runtime/host/component_timeout.py` 看到。

### 8.3 wait、学习、监控等是后台任务

MaiBot 也确实有很多后台化能力：

- `wait` 工具不是同步 sleep，而是设置 session wait 状态，并挂一个 timeout task；时间到后向内部队列投递 `timeout`。
- 裁剪历史后的学习通过 `asyncio.create_task()` 后台触发，见 `reasoning_engine.py:1654-1660`。
- 表达/行为/高频词学习内部又并行 `asyncio.create_task()`，见 `runtime.py:1804-1814`。
- 监控事件、回复效果观察也走后台 task。

结论：MaiBot 的异步设计主要解决“平台入口和其他会话不被堵住”“等待/学习/监控不堵主链路”。但普通工具调用仍然是当前会话当前轮内的同步等待式 tool call。

### 8.4 新消息可以打断当前 Planner

群聊里一个很现实的问题是：上一轮推理还没结束，群里已经有人又发了新消息。MaiBot 对这个问题的处理不是“硬等旧轮跑完”，而是允许 Planner 被新消息打断。

关键链路在 `references/maibot/src/maisaka/reasoning_engine.py:1151-1216`：

- Planner 收到中断信号后抛出 `ReqAbortException`。
- 当前轮记录为 `planner_interrupted`。
- 再次等待静默窗口。
- 收集新消息。
- `await self._ingest_messages(interrupted_messages)`。
- 直接跳过 Timing Gate，重新尝试 Planner。

这说明 MaiBot 不只是“消息能继续进 buffer”，还支持在当前语境明显变化时，尽快放弃旧推理、重做主决策。

### 8.5 同一个 session 不会并发跑两套 Planner

这也是群聊 runtime 很关键的一点。`MaisakaHeartFlowChatting` 初始化时同时持有：

- 一条 `_internal_turn_queue`
- 一个 `_internal_loop_task`
- 一份 `message_cache`

对应初始化在 `references/maibot/src/maisaka/runtime.py:95-113`。真正的内部循环由 `_ensure_background_tasks_running()` 拉起，如果 loop 崩了才会重启，见 `references/maibot/src/maisaka/runtime.py:1233-1246`。而普通消息触发只是往 `_internal_turn_queue.put_nowait("message")` 里塞一个 turn 事件，见 `references/maibot/src/maisaka/runtime.py:1572-1608`。

因此同一个群会话不是：

```txt
消息 A -> 开一套 Planner
消息 B -> 再并发开一套 Planner
```

而更接近：

```txt
消息 A/B/C
  -> 先进 buffer 和 turn queue
  -> 同一条 internal loop 串行处理
  -> 必要时中断当前 Planner
  -> 合并新消息后重试
```

这解释了两个常见疑问：

- 为什么普通工具会阻塞“当前会话当前轮”，但不会把整个平台拖死。
- 为什么新消息来了以后，MaiBot 更偏向“中断并重做”，而不是“多开一条并发推理线程”。

## 9. 其他对群聊重要的机制

除了 `buffer + Timing Gate + Planner + Replyer` 这条主干，MaiBot 还有一些对群聊非常关键、但初看不一定会注意到的机制。

### 9.1 表达方式选择不是最后一拍脑袋

Replyer 前面还有一层 expression selector。它会结合：

- 最近聊天
- 目标消息
- 回复理由
- 候选表达方式

来挑这次更像当前群风格的表达习惯，见 `references/maibot/src/chat/replyer/maisaka_expression_selector.py:173-200` 和 `:456-517`。

这解决的是“内容没错，但说得不像这个群”的问题。

### 9.2 关键词反应和群聊特定规矩

Replyer 构造最终 user message 时，还会加入关键词反应提示、群聊通用注意事项和当前聊天额外规则，见 `references/maibot/src/chat/replyer/maisaka_generator_base.py:386-422` 和 `:241-266`。

这说明 MaiBot 不是纯自由聊天，而是允许为不同群设置额外风格边界和触发性反应。

### 9.3 focus mode 处理多群并发调度

MaiBot 不是默认所有群同时都能进入完整决策态。focus mode 下：

- 某些群只能先缓存消息。
- 当前可决策的会话才会真正进入主 loop。
- Planner 还能收到当前 focus scope 内其他聊天的 overview。

对应代码在 `references/maibot/src/maisaka/focus/runtime_mixin.py:349-410`。

这适合“一台 bot 同时挂很多群”的场景，避免所有群同时抢 LLM 和工具资源。

### 9.4 回复效果观察

MaiBot 会记录机器人发出去的一次 reply，之后观察用户后续是否继续接话、是否明显负反馈、是否进入修复循环，见 `references/maibot/src/maisaka/runtime.py:789-831` 和 `references/maibot/src/maisaka/reply_effect/tracker.py`。

这对群聊尤其有用，因为群聊 agent 后续要优化的往往不是“能不能答”，而是“这次答得值不值得、用户买不买账”。

## 10. 为什么它适合群聊

MaiBot 的群聊强点可以归纳为 12 个机制：

1. **把群聊当作持续流**：群聊是 group session，不是每个用户一条对话。
2. **消息先缓存再决策**：`message_cache` 让系统看到一小段群聊变化，而不是只看单条消息。
3. **批量 + 防抖**：高频消息先积累，群聊短暂安静后再判断。
4. **规则先节流，LLM 再判断时机**：规则处理频率、@、wait、no_action 退避；Timing Gate 处理语义时机。
5. **是否接话和怎么接话分离**：Timing Gate 只判断该不该继续，Planner 再决定回复、工具、等待或不行动。
6. **记忆/画像/行为模式按需注入**：长期资产不会每条消息都塞入上下文，而是有窗口、缓存、节流和范围控制。
7. **重活异步化**：入口、会话 runtime、wait、学习、监控分离，减少群聊高频场景的阻塞。
 8. **回复对象定位明确**：`reply` 工具要求 `msg_id`，Replyer 还会在 prompt 里单独强调当前要回复哪条消息。
 9. **新消息可打断旧推理，但仍保持单 session 串行 loop**：当前语境明显变化时，Planner 可以被中断并重做决策，而不是并发开第二套 planner。
 10. **命令流和聊天流分开**：slash command、插件命令不会天然污染自然聊天主链。
 11. **表达方式单独选择**：不是只生成一句“对的回答”，还要尽量说得像这个群。
 12. **回复效果可回看**：后续可以把“这次接话值不值”变成优化依据。

## 11. 对 Huaness Lite 的启发

如果 Huaness Lite 要支持群聊，不应让 QQ/Discord/Telegram 这类 channel 直接调用通用 AgentLoop。更合理的是在 channel adapter 和 AgentLoop 之间加一层 `ConversationRuntime` 或 `ChannelRuntime`。

P0 可以借鉴这些最小机制：

| 能力 | MaiBot 做法 | Huaness Lite P0 可借鉴 |
| --- | --- | --- |
| 会话模型 | group/private session 分离 | `sessionId = channel + scope + group/user` |
| 消息缓存 | `message_cache + _last_processed_index` | 每个 session 一个 pending message buffer |
| 批量触发 | 频率阈值 + idle compensation | 先做 `minMessages`、`maxDelayMs`、`quietMs` |
| 强触发 | @/昵称/回复触发 forced continue | adapter 只打 trigger 标记，不直接控制 core |
| 是否回复 | Timing Gate: continue/wait/no_action | 单独做 `ResponseGate`，不要塞进主 planner |
| 会话内调度 | 单 session 一条 internal loop，可中断重试 | P0 每个 session 串行执行 turn，避免并发 planner / 并发改同一会话状态 |
| 防抢话 | group-only no_action backoff | P0 支持 `noActionBackoffMs` |
| 上下文 | 短期历史 + pinned summary + memory/profile refs | 先做短期窗口 + injected references |
| 工具 | visible/deferred tools | P0 先做 visible tools，deferred 放 P1 |
| 异步 | 入站不等工具；学习后台化 | P0 保证 adapter 不等 Agent 完整执行 |

需要延后或避免的部分：

- **延后完整人格/情绪系统**：MaiBot 的真实感来自很多层，P0 不要一开始复制。
- **延后重型长期记忆图谱**：可以先保留 event log + summary + simple profile。
- **避免每条群消息进 LLM**：这是通用 Agent 接群聊最容易失败的点。
- **避免让 channel adapter 决定 core 架构**：QQ 只是外置频道，群聊运行时才是关键边界。

## 12. 未确认事项

- 没有确认到主链路里存在独立的“语义关键词触发器”；昵称/别名触发已确认，语义上下文触发主要由 Timing Gate 承担。
- 没有确认到一个长期持久化的全局 mood 状态机；已确认的是人格 prompt、人物画像、行为模式、表达学习和情绪化表情选择。
- 没有完整展开 MCP 工具内部的二级取消/超时策略；已确认到 `MCPToolProvider -> MCPManager.call_tool_invocation()` 这一层。
- 没有运行实际群聊，所以“表现强”的判断只来自架构机制，不来自实测效果。
