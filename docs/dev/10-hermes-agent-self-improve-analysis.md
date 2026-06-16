# Hermes Agent Self-Improve 核心设计蒸馏

本文只分析 `references/hermes-agent` 里的 self-improve 机制：它如何从一次任务/对话中沉淀经验，并让下次表现变好。本文不介绍 Hermes 是什么，也不泛读 README。

## 1. 一句话总结

Hermes self-improve 的本质是：把一次对话里的稳定经验，通过后台 review 转成可持久化资产 `memory` / `skill`，再通过下一次 system prompt、skill index、`skill_view` 和 curator 生命周期管理重新喂回 agent。

这里的“改进”不是模型权重训练，也不是自动改 agent 源码，而是把经验沉淀成更容易被下次检索、加载、执行的外部资产。

## 2. 完整流程

核心链路可以压成这条线：

```text
用户任务
  -> run_conversation 产生 messages/session/trajectory
  -> turn finalizer 判断是否触发 memory / skill review
  -> fork 一个 background review AIAgent
  -> review agent 只允许 memory/skill 工具
  -> 产出 memory 写入或 skill 创建/更新候选
  -> write_approval gate 决定直接写入或 pending
  -> MemoryStore / skill_manage 落盘
  -> 下次 prompt 构建 / skill_view 加载时复用
  -> curator 定期整理 agent-created skills
```

### 2.1 用户任务到 session/trace

入口不是某个单独的 self-improve runner，而是普通 agent turn 的尾部。

- `references/hermes-agent/agent/conversation_loop.py::run_conversation` 负责主 loop，维护本轮 `messages`。
- `references/hermes-agent/agent/turn_context.py::build_turn_context` 在每轮开始做会话初始化、session id 绑定、memory review 计数。
- `references/hermes-agent/agent/turn_finalizer.py::finalize_turn` 在主 loop 结束后保存轨迹、持久化 session，并决定是否触发后台 review。
- `references/hermes-agent/run_agent.py::AIAgent._persist_session` 把消息写到内存态 `_session_messages`、JSON snapshot 和 SQLite session DB。
- `references/hermes-agent/run_agent.py::AIAgent._save_trajectory` 可以把 conversation trajectory 写到 JSONL 样本文件。

关键点：background review 用的是已经完成的 `messages_snapshot`，不是另起一个没有上下文的 prompt。

### 2.2 触发 background review

触发逻辑在 turn 末尾：

- `references/hermes-agent/agent/turn_finalizer.py::finalize_turn` 计算 `_should_review_skills`。
- `references/hermes-agent/agent/turn_context.py::build_turn_context` 计算 `should_review_memory`。
- `references/hermes-agent/run_agent.py::AIAgent._spawn_background_review` 调用 `agent.background_review.spawn_background_review_thread` 并启动 daemon thread。

触发条件是 nudge 计数，不是每轮都 review：

- memory：`agent._memory_nudge_interval`
- skill：`agent._skill_nudge_interval` / `agent._iters_since_skill`

默认间隔来自 config；如果达到阈值，才进入 review。

### 2.3 background review 怎么跑

核心文件是 `references/hermes-agent/agent/background_review.py`。

关键函数：

- `spawn_background_review_thread(agent, messages_snapshot, review_memory, review_skills)`
- `_run_review_in_thread(agent, messages_snapshot, prompt)`
- `summarize_background_review_actions(review_messages, prior_snapshot, notification_mode)`
- `build_memory_write_metadata(agent, ...)`

`_run_review_in_thread` 的设计要点：

- fork 一个新的 `AIAgent`，不是复用主 agent。
- 继承父 agent 的 provider、model、base_url、api_key、api_mode。
- `max_iterations=16`，限制后台 review 的预算。
- `quiet_mode=True`，尽量不污染前台输出。
- `skip_memory=True`，避免后台 review 自己触发外部 memory provider 的 prefetch/sync。
- 重新绑定父 agent 的 `_memory_store`，让内置 `MEMORY.md` / `USER.md` 写入仍然生效。
- 继承父 agent 的 `_cached_system_prompt`、`session_start`、`session_id`，保持 prompt cache 友好。
- `review_agent.compression_enabled = False`，避免 review fork 和主会话争抢 compression/session rotation。
- 通过 `set_thread_tool_whitelist` 把可用工具限制到 memory/skills toolset。
- 给 terminal dangerous approval 安装 `_bg_review_auto_deny`，后台线程遇到危险命令默认拒绝。

review prompt 有三种：

- `_MEMORY_REVIEW_PROMPT`
- `_SKILL_REVIEW_PROMPT`
- `_COMBINED_REVIEW_PROMPT`

它们的分工很清楚：

- memory：记录“用户是谁、偏好、环境事实、稳定项目约定”。
- skill：记录“这类任务下次怎么做”，尤其是用户纠正、踩坑修复、非平凡 workflow。
- combined：同时判断 memory 和 skill，并强调“用户/当前情况进 memory，任务类别方法进 skill”。

### 2.4 memory / skill candidate 到写入

background review agent 不是返回一个结构化 JSON 给主进程审核，而是直接调用工具：

- `references/hermes-agent/tools/memory_tool.py::memory_tool`
- `references/hermes-agent/tools/skill_manager_tool.py::skill_manage`

但是“直接调用工具”不等于一定直接写盘。真正是否写盘由 write-approval gate 决定。

`references/hermes-agent/tools/write_approval.py::evaluate_gate` 的决策矩阵是：

```text
write_approval=false
  -> allow，直接写入

write_approval=true + memory + foreground interactive CLI
  -> inline approval

write_approval=true + memory + background/gateway/script
  -> stage 到 pending

write_approval=true + skills 任意来源
  -> stage 到 pending
```

默认配置里 `memory.write_approval=false`、`skills.write_approval=false`。所以必须明确：Hermes 不是默认所有自改进都人工审批；它提供了可打开的审批闸门。

pending 记录由这些函数处理：

- `references/hermes-agent/tools/write_approval.py::stage_write`
- `references/hermes-agent/tools/write_approval.py::list_pending`
- `references/hermes-agent/tools/write_approval.py::get_pending`
- `references/hermes-agent/tools/write_approval.py::discard_pending`
- `references/hermes-agent/tools/write_approval.py::skill_pending_diff`
- `references/hermes-agent/hermes_cli/write_approval_commands.py::handle_pending_subcommand`
- `references/hermes-agent/hermes_cli/write_approval_commands.py::_approve`
- `references/hermes-agent/hermes_cli/write_approval_commands.py::_reject`
- `references/hermes-agent/hermes_cli/write_approval_commands.py::_diff`

### 2.5 写入后如何下次加载

memory 的加载链路：

- `references/hermes-agent/agent/agent_init.py::init_agent` 创建 `MemoryStore` 并调用 `MemoryStore.load_from_disk()`。
- `references/hermes-agent/tools/memory_tool.py::MemoryStore.load_from_disk` 读取 `~/.hermes/memories/MEMORY.md` 和 `USER.md`。
- `references/hermes-agent/tools/memory_tool.py::MemoryStore.format_for_system_prompt` 把启动时 frozen snapshot 渲染为 prompt block。
- `references/hermes-agent/agent/system_prompt.py::build_system_prompt_parts` 把 memory/user profile 放进 volatile prompt tier。

重要细节：`MemoryStore` 明确采用 frozen snapshot。中途 `memory(action=add/replace/remove)` 会立刻落盘，但不会修改当前 session 已缓存的 system prompt。下次 session 或 prompt rebuild 才稳定进入模型输入。

skill 的加载链路：

- `references/hermes-agent/agent/prompt_builder.py::build_skills_system_prompt` 扫描 skill metadata，构建 system prompt 中的 skill index。
- `references/hermes-agent/tools/skills_tool.py::skills_list` 返回 name + description，低 token 成本。
- `references/hermes-agent/tools/skills_tool.py::skill_view` 加载完整 `SKILL.md` 或支持文件。
- `references/hermes-agent/tools/skills_tool.py::_skill_view_with_bump` 在成功加载后调用 `bump_view` 和 `bump_use` 记录 telemetry。
- `references/hermes-agent/agent/skill_commands.py::build_skill_invocation_message` 支持 `/skill-name` 这类显式加载。

skill 被 `skill_manage` 改动后，会调用 `agent.prompt_builder.clear_skills_system_prompt_cache(clear_snapshot=True)` 清理 skills prompt cache。但当前 agent 已经缓存的 `_cached_system_prompt` 不一定立刻重建，所以更可靠的理解是：新 skill/改过的 skill 会在下一次 prompt 构建或显式 `skill_view` 时发挥作用。

## 3. 核心模块表

| 模块 | 文件路径 | 关键函数/类 | 职责 |
| --- | --- | --- | --- |
| Turn/session 捕获 | `references/hermes-agent/agent/conversation_loop.py` | `run_conversation` | 主 agent loop，累计本轮 `messages`，给后续 review 提供完整上下文。 |
| Turn 初始化 | `references/hermes-agent/agent/turn_context.py` | `build_turn_context` | 创建/绑定 session，计数 memory review nudge，绑定 write origin ContextVar。 |
| Turn 收尾 | `references/hermes-agent/agent/turn_finalizer.py` | `finalize_turn` | 保存 trajectory/session，触发外部 memory sync，按计数触发 background review。 |
| Agent wrapper | `references/hermes-agent/run_agent.py` | `AIAgent._spawn_background_review`, `_persist_session`, `_save_trajectory` | 对外提供后台 review 启动、会话持久化、trajectory 保存入口。 |
| Background review | `references/hermes-agent/agent/background_review.py` | `spawn_background_review_thread`, `_run_review_in_thread`, `summarize_background_review_actions` | fork review agent，限制工具，基于对话生成 memory/skill 写入。 |
| 内置 memory | `references/hermes-agent/tools/memory_tool.py` | `MemoryStore`, `memory_tool`, `apply_memory_pending` | 文件型 `MEMORY.md` / `USER.md`，当前 `memory_tool()` 实现处理 add/replace/remove、写入 gate、冻结 prompt snapshot；源码注释提到 read，但本次未确认当前分支暴露 read action。 |
| 外部 memory provider | `references/hermes-agent/agent/memory_manager.py` | `MemoryManager`, `build_memory_context_block`, `prefetch_all`, `sync_all` | 插件式 memory provider 编排；主 turn 可同步/预取外部 memory，background review 明确跳过外部 provider。 |
| Memory provider 接口 | `references/hermes-agent/agent/memory_provider.py` | `MemoryProvider` | 定义 `prefetch`、`sync_turn`、`get_tool_schemas`、`handle_tool_call` 等扩展接口。 |
| Skill 读取 | `references/hermes-agent/tools/skills_tool.py` | `skills_list`, `skill_view`, `_skill_view_with_bump` | progressive disclosure：先列 metadata，再按需加载完整 skill/support file，并记录 usage。 |
| Skill prompt index | `references/hermes-agent/agent/prompt_builder.py` | `build_skills_system_prompt`, `clear_skills_system_prompt_cache` | 构建 system prompt 中的可用 skill index，支持缓存与 snapshot。 |
| Skill 写入 | `references/hermes-agent/tools/skill_manager_tool.py` | `skill_manage`, `_create_skill`, `_edit_skill`, `_patch_skill`, `_delete_skill`, `_write_file`, `_remove_file` | 创建、更新、删除、写支持文件；带 schema、路径、大小、安全扫描、rollback。 |
| Skill provenance | `references/hermes-agent/tools/skill_provenance.py` | `set_current_write_origin`, `get_current_write_origin`, `is_background_review` | 区分 foreground 用户指令写入和 background review 自主写入。 |
| Skill usage telemetry | `references/hermes-agent/tools/skill_usage.py` | `bump_view`, `bump_use`, `bump_patch`, `mark_agent_created`, `archive_skill`, `restore_skill`, `agent_created_report` | `.usage.json` 侧车记录 usage/provenance/state/pinned，供 curator 判断生命周期。 |
| Write approval | `references/hermes-agent/tools/write_approval.py` | `write_approval_enabled`, `evaluate_gate`, `stage_write`, `skill_pending_diff` | memory/skill 写入审批闸门、pending store、skill diff。 |
| Pending UX | `references/hermes-agent/hermes_cli/write_approval_commands.py` | `handle_pending_subcommand`, `_approve`, `_reject`, `_diff` | `/memory pending/approve/reject`、`/skills pending/diff/approve/reject`。 |
| Curator | `references/hermes-agent/agent/curator.py` | `maybe_run_curator`, `run_curator_review`, `apply_automatic_transitions`, `_run_llm_review` | 定期整理 agent-created skills：stale、archive、umbrella consolidation、report。 |
| Curator CLI | `references/hermes-agent/hermes_cli/curator.py` | `_cmd_run`, `_cmd_pin`, `_cmd_restore`, `_cmd_archive`, `_cmd_backup`, `_cmd_rollback` | curator 的人工操作入口：run/dry-run/pin/restore/archive/backup/rollback。 |
| Curator backup | `references/hermes-agent/agent/curator_backup.py` | `snapshot_skills`, `rollback`, `summarize_backups` | curator 运行前给 skills tree 打 tar.gz 快照，rollback 时先给当前树再打安全快照。 |
| ACP edit approval | `references/hermes-agent/acp_adapter/edit_approval.py` | `EditProposal`, `maybe_require_edit_approval`, `make_acp_edit_approval_requester` | 普通文件 edit approval，不是 self-improve 主链路，但体现 diff/pending approval 的接口模式。 |

## 4. 它到底“改进”了什么

### 4.1 memory

已确认。

内置 memory 改进的是两个文件：

- `~/.hermes/memories/MEMORY.md`
- `~/.hermes/memories/USER.md`

对应代码：

- `references/hermes-agent/tools/memory_tool.py::MemoryStore`
- `references/hermes-agent/tools/memory_tool.py::memory_tool`

它记录：

- 用户偏好、沟通风格、长期事实。
- 环境事实、项目约定、工具 quirks。
- 以后还会有用的稳定经验。

它明确不该记录：

- 本轮任务进度。
- 一次性 TODO。
- 已完成工作流水账。
- 复杂 procedure；这些应该进 skill。

### 4.2 skill

已确认。

skill 是 Hermes 的“过程性记忆”。它改进的是：

- `SKILL.md` 主说明。
- `references/` 支持文档。
- `templates/` 模板。
- `scripts/` 可复用脚本。
- `assets/` 附属资源。

对应代码：

- `references/hermes-agent/tools/skill_manager_tool.py::skill_manage`
- `references/hermes-agent/tools/skill_manager_tool.py::_create_skill`
- `references/hermes-agent/tools/skill_manager_tool.py::_patch_skill`
- `references/hermes-agent/tools/skill_manager_tool.py::_write_file`

background review prompt 明确建议优先更新已加载 skill 或已有 umbrella skill，最后才新建 class-level umbrella skill。

### 4.3 skill lifecycle / curator state

已确认。

Hermes 还会改进 skill collection 的组织状态：

- `.usage.json`：usage/provenance/state/pinned。
- `.curator_state`：curator 调度状态。
- `.archive/`：可恢复归档 skill。
- `.curator_backups/`：curator 运行前快照。
- `logs/curator/.../REPORT.md`：curator run report。

对应代码：

- `references/hermes-agent/tools/skill_usage.py`
- `references/hermes-agent/agent/curator.py`
- `references/hermes-agent/agent/curator_backup.py`

### 4.4 prompt / tool description / 源码

需要分清：

- 直接优化 prompt 模板：未确认，未在本次分析范围内找到专门的 prompt optimizer。
- 直接修改 tool description：未确认，未发现 background review 会编辑内置 tool schema。
- 直接修改 Hermes 源码：未确认，background review 通过 whitelist 只能使用 memory/skill 工具，不应改源码。
- 间接影响 prompt：已确认，memory 和 skill index 会在后续 system prompt 构建时进入模型输入。
- skill 内脚本/模板：已确认，skill 可以新增 `scripts/`、`templates/`、`references/`，这属于可复用资产，不是修改 core agent 代码。

### 4.5 eval / self-evolution

本次源码搜索发现：

- `apps/desktop/scripts/eval.mjs` 是 desktop/CDP 的页面 eval helper，不是 agent self-improvement eval loop。
- `hermes_cli/goals.py` 有 judge/evaluate 逻辑，但它是 goal 完成度判断，不是 memory/skill 优化评测主链路。
- `agent/curator.py` 有 LLM review + structured summary，用于 skill consolidation，不是自动 benchmark-driven prompt/skill optimizer。

结论：未确认存在完整的“自动 eval -> 优化 prompt/skill -> 回归验证 -> 发布”的 self-evolution 管线。Hermes 的核心 self-improve 更偏经验沉淀和技能库维护。

## 5. 它如何避免乱改

### 5.1 background review 的边界

`references/hermes-agent/agent/background_review.py::_run_review_in_thread` 做了几层限制：

- 只给 review fork `max_iterations=16`。
- `skip_memory=True`，避免污染外部 memory provider。
- 只重新绑定内置 `_memory_store`，允许 `MEMORY.md` / `USER.md` 写入。
- `set_thread_tool_whitelist` 只允许 memory/skills toolset。
- `_bg_review_auto_deny` 让危险 command approval 在后台线程里自动 deny。
- `compression_enabled=False`，避免后台 review 影响主 session 的 compression/session rotation。

这说明 Hermes 把“沉淀经验”当成后台副作用，但用工具白名单和低预算限制它的行为半径。

### 5.2 write approval / pending / diff

`references/hermes-agent/tools/write_approval.py` 提供 memory/skill 写入的统一审批闸门。

安全语义：

- gate 默认 off，保持旧行为。
- gate on 时，background-origin writes 不会直接提交，而是 staged。
- skill writes 永远 staged，因为 `SKILL.md` 可能很大，不适合 inline eyeball。
- pending records 存在 `<HERMES_HOME>/pending/{memory,skills}/<id>.json`。
- `/skills diff <id>` 通过 `skill_pending_diff` 生成完整 diff。
- approve 后用 `apply_memory_pending` / `apply_skill_pending` 重放写入。
- reject 只是删除 pending 记录。

这套机制不是为了阻止所有写入，而是让用户可以把自动沉淀改成“先暂存，后批准”。

### 5.3 memory 写入保护

`references/hermes-agent/tools/memory_tool.py::MemoryStore` 的保护点：

- 写入前用 `tools.threat_patterns` 做 strict scope 注入/外泄模式扫描。
- `memory_char_limit` / `user_char_limit` 限制 memory 膨胀。
- add 拒绝重复 entry。
- replace/remove 用短 substring 匹配，多个不同命中会拒绝，要求更精确。
- 文件写入用 lock + atomic replace。
- `_detect_external_drift` 检测手工编辑、shell append、并发 session 导致的非 round-trip 内容，并写 `.bak.<ts>` 后拒绝覆盖。
- system prompt 使用 frozen snapshot，中途写入不会立刻改当前 prompt。

### 5.4 skill 写入保护

`references/hermes-agent/tools/skill_manager_tool.py` 的保护点：

- `_validate_name`：只允许文件系统安全的 skill name。
- `_validate_category`：category 只能是单段目录名。
- `_validate_frontmatter`：`SKILL.md` 必须有 YAML frontmatter、`name`、`description` 和正文。
- `_validate_content_size`：限制 `SKILL.md` 内容大小。
- `_validate_file_path`：支持文件只能在 `references`、`templates`、`scripts`、`assets` 或安全的 `SKILL.md` 路径。
- `_resolve_skill_target`：确保目标路径不逃出 skill 目录。
- `_security_scan_skill`：当 `skills.guard_agent_created` 打开时扫描 agent-created skill；失败时 rollback。
- `_edit_skill`、`_patch_skill`、`_write_file` 会保存原内容，安全扫描失败则回滚。
- `_delete_skill` 删除前检查 pinned、`absorbed_into`、路径是否在 skills root 内、是否 symlink/junction、是否等于 skills root。
- `_pinned_guard` 只阻止删除 pinned skill，不阻止 patch/edit。

### 5.5 provenance 限制

Hermes 不把所有 skill 都交给 curator。

关键代码：

- `references/hermes-agent/tools/skill_provenance.py::is_background_review`
- `references/hermes-agent/tools/skill_usage.py::mark_agent_created`
- `references/hermes-agent/tools/skill_usage.py::list_agent_created_skill_names`
- `references/hermes-agent/tools/skill_usage.py::is_curation_eligible`

规则：

- 只有 background review 创建的 skill 才会 `created_by="agent"`，进入 curator 管理。
- foreground 用户要求创建的 skill 不自动归 curator 管。
- hub-installed skills 永远不归 curator 管。
- bundled skills 默认不归 curator 管，除非打开 `curator.prune_builtins`。
- protected built-in `plan` 永远不归 curator 管。

这解决了一个很实际的问题：自动整理不应该把用户手写的资产、Hub 上游资产、内置关键 UX 技能一起拿去合并/归档。

### 5.6 curator 的安全边界

`references/hermes-agent/agent/curator.py` 是二级维护器，不是每轮 self-improve 的直接写入点。

它的保护点：

- `should_run_now` 按 `curator.enabled`、paused、interval gating 控制运行频率。
- `maybe_run_curator` 还可以按 idle 时间 gate。
- `run_curator_review(dry_run=True)` 只生成报告，不做 mutation。
- `apply_automatic_transitions` 跳过 pinned skill。
- stale 只是打状态，archive 是移动到 `.archive/`，不是删除。
- `CURATOR_REVIEW_PROMPT` 明确禁止触碰 bundled/hub-installed/pinned/protected skills。
- `agent/curator_backup.py::snapshot_skills` 在真实 curator run 前给 `~/.hermes/skills/` 打快照。
- `agent/curator_backup.py::rollback` 会先给当前树再打安全快照，再从目标快照恢复。
- `hermes_cli/curator.py` 提供 `pin`、`unpin`、`restore`、`backup`、`rollback`、`dry-run` 等人工控制。

未确认点：curator prompt 明确允许使用 `terminal` 做 archive/mv；本次没有确认 curator fork 还有和 background review 一样严格的 runtime tool whitelist。因此 curator 的安全性更多依赖 provenance、prompt hard rules、archive-not-delete、dry-run、backup/rollback。

## 6. 和普通 Agent 的区别

普通 Agent 会忘，通常有四个原因：

1. 当前对话只在 context window 里，窗口压缩或会话结束后细节消失。
2. 用户纠正过的偏好没有被结构化写入，下次只能靠模型泛化猜。
3. 工具踩坑和修复步骤只存在于一次 transcript，不能变成可检索 procedure。
4. 即使有 transcript search，也需要 agent 主动搜；它不会天然变成下次任务的操作规范。

Hermes 的不同点：

- 它把“谁是用户、用户偏好、环境稳定事实”写成 memory。
- 它把“这类任务下次怎么做”写成 skill。
- 它把 skill 暴露成 prompt index，再要求模型用 `skill_view` 加载完整说明。
- 它记录 skill usage，让长期不用、过窄、重复的 skill 可以被 curator 整理。
- 它用 provenance 区分自动生成资产和用户/Hub/内置资产。
- 它提供 pending/diff/approval/rollback 让自动学习的副作用可审计、可撤销。

所以 Hermes 的 self-improve 不是“模型自己变聪明”，而是“agent runtime 把经验转成可复用操作资产，并在下次任务前重新装载”。

## 7. 可复刻的最小设计

如果给 Huaness Lite 做一个简化版 self-improve，建议只保留 5 个模块。

### 7.1 SessionTrace

职责：

- 记录每轮 user message、assistant message、tool call、tool result、turn exit reason。
- 给 post-run review 一个干净的 `messages_snapshot`。

最小接口：

```ts
interface SessionTrace {
  append(event: TraceEvent): Promise<void>
  snapshot(sessionId: string): Promise<TraceMessage[]>
}
```

### 7.2 PostRunReviewer

职责：

- 在 turn 结束后异步运行。
- 输入 `messages_snapshot`。
- 输出 `MemoryProposal[]` 和 `SkillProposal[]`。
- P0 不需要真 fork 一个完整 agent，也可以先用一个受限 reviewer prompt。

必须有的限制：

- max review steps / timeout。
- 禁止真实 shell。
- 只能调用 `memory.propose` / `skill.propose` 或写 pending。
- review prompt 明确区分 memory 和 skill。

### 7.3 DurableKnowledgeStore

职责：

- `MemoryStore`：保存用户偏好、项目事实、环境 quirks。
- `SkillStore`：保存 class-level procedure，不保存一次性流水账。

P0 可以用文件：

```text
.huaness/memory/user.md
.huaness/memory/project.md
.huaness/skills/<skill-name>/SKILL.md
.huaness/skills/<skill-name>/references/*.md
```

必须有：

- atomic write。
- 路径 guard。
- entry size limit。
- schema/frontmatter 校验。
- “当前 session 不热更新 system prompt”的明确语义。

### 7.4 ApprovalGate

职责：

- 所有 memory/skill 写入先走 gate。
- P0 推荐默认“自动写 memory 需要 approval”，因为 Huaness 早期 prompt 质量不稳定。
- skill 默认 pending，提供 diff。

最小 pending 结构：

```json
{
  "id": "abc123",
  "subsystem": "skills",
  "origin": "background_review",
  "action": "patch",
  "summary": "patch coding-workflow SKILL.md",
  "payload": {}
}
```

最小命令：

```text
/memory pending
/memory approve <id>
/memory reject <id>
/skills pending
/skills diff <id>
/skills approve <id>
/skills reject <id>
```

### 7.5 KnowledgeLoader + UsageCurator

职责：

- 在 prompt 构建时加载 memory snapshot 和 skill index。
- 用 `skill_view` 按需加载完整 skill。
- 记录 skill view/use/patch 计数。
- P0 curator 可以先不做 LLM consolidation，只做 pinned + stale report。

P0 先实现：

- skill metadata index。
- skill usage sidecar。
- pinned。
- archived 目录。
- restore。

P1 再实现：

- umbrella consolidation。
- curator dry-run report。
- pre-run backup/rollback。

## 8. 数据流 / 模块关系图

```text
User task
  -> AgentLoop.run_conversation
  -> SessionTrace(messages + tool results + final response)
  -> TurnFinalizer
  -> PostRunReviewer(background, limited tools)
  -> MemoryProposal / SkillProposal
  -> ApprovalGate
       -> pending queue + diff + approve/reject
       -> or direct write when gate off
  -> MemoryStore / SkillStore
  -> PromptBuilder(memory snapshot + skill index)
  -> Next AgentLoop
  -> skill_view loads full procedural memory
  -> UsageTelemetry records view/use/patch
  -> Curator stale/archive/consolidate
  -> Backup / Restore / Rollback
```

更短的核心闭环：

```text
conversation trace
  -> background review
  -> durable memory / durable skill
  -> next prompt / skill load
  -> better next task behavior
```
