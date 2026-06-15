# 后续派分析任务的方法

这份文档记录这次并行分析的方法，方便之后继续派子线程或自己读源码。

核心原则：不要让子线程“总结某仓库”。要让它回答一个 Harness 问题。

## 0. 调度规则

以后不要同时开超过 3 个子线程，避免把本机卡住。

子线程也不只是一仓库一个。更合理的调度分三层：

1. `仓库考古线程`：每个线程只读一个仓库或一个子系统，回答事实问题。
2. `横向专题线程`：跨仓库比较一个主题，比如 tool gateway、policy、event trace、session/run。
3. `Leader 汇总`：主线程负责审核、去重、纠偏，并产出最终学习路线和 Huaness Lite 架构草案。

推荐批次：

- 第一批最多 3 个：`mini-swe-agent`、`OpenClaw`、`Codex`。
- 第二批最多 3 个：`Gemini CLI`、`OpenHands`、`Claude Code`。
- 第三批最多 2 到 3 个横向专题：`agent loop`、`tool/policy`、`event/replay/eval`。

如果已经有足够材料，第三批也可以不派，由 leader 本地整合，避免无意义并发。

## 1. 好任务的结构

一个好的分析任务应该包含：

- 背景：Huaness Lite 是轻量 Agent Harness，要替代个人服务器上的 OpenClaw。
- 角色：你是某个 reference 的代码考古员。
- 范围：只读一个仓库或一个子系统。
- 问题：围绕输入、session、model、tool、policy、event、eval。
- 输出：固定格式，方便 leader 合并。
- 边界：不能凭空推断；如果仓库没有核心实现，要明确说没有。

## 2. 标准 Prompt 模板

```text
你是 Huaness Lite 的 reference 分析子线程。

背景：
- Huaness Lite 是一个轻量 Agent Harness 项目，用于个人服务器，未来替代 OpenClaw。
- CLI/HTTP/IM 只是 channel 入口，核心是 run/session、agent loop、tool gateway、policy、trace、eval。
- 请从完全初学者能理解的角度解释，但证据必须来自当前本地仓库。

分析范围：
- 仅读取 <repo path>。
- 不要修改文件。
- 不要运行重型安装或测试。

请重点回答：
1. 外部输入从哪里进入？
2. session/run 状态保存在哪里？
3. prompt/context 如何组装？
4. model call 在哪里发生？
5. tool call 如何声明、解析、审批、执行？
6. observation 如何回到下一轮模型？
7. stop/cancel/error/limit 如何处理？
8. trace/event/transcript/replay/eval 在哪里？
9. Huaness Lite 应该 adopt/defer/avoid 什么？
10. 这个仓库有什么不能直接学习的空洞或 caveat？

输出格式：
1. 5 行 thesis。
2. beginner glossary。
3. step-by-step execution chain，带关键文件路径和行号。
4. Huaness Lite adopt/defer/avoid。
5. gaps/caveats。
```

## 3. 本轮六个任务的分工

### mini-swe-agent

任务重点：

- 解释最小 Agent loop。
- 路线是 `input -> task/session -> prompt/context -> model -> tool/action -> observation -> next loop -> stop`。
- 重点找 `DefaultAgent.run/step/query/execute_actions`。

审核结论：

- 非常适合作为第一份学习材料。
- 最大风险是 shell 执行太轻，不能直接用于公网入口。

### Codex

任务重点：

- 解释 Codex 作为 Agent Harness 控制面的形状。
- 看 workspace、tools、approvals、sandbox、session/resume、patching、events/trace。

审核结论：

- 很适合学习 permission profile、approval、sandbox、rollout。
- 不适合照搬完整生产复杂度。

### Gemini CLI

任务重点：

- 解释 CLI Agent Harness。
- 看 session、tool registry、permission/approval、shell/file tools、memory/context、telemetry/evals、core vs UI。

审核结论：

- 很适合学习 tool registry + scheduler + policy engine。
- `LegacyAgentSession` 是过渡 API，学模式不要学命名。

### OpenClaw

任务重点：

- 作为替代目标，分析外部消息、plugins/tools、config、skills/extensions、execution chain。
- 重点区分 channel/gateway/harness/agent-core。

审核结论：

- 是 Huaness Lite 的直接参照。
- 应该学小边界，不搬大生态。

### OpenHands

任务重点：

- 分析平台级 conversation/runtime/event/action 架构。
- 注意判断当前仓库是否包含核心 loop。

审核结论：

- 当前 checkout 主要是 app-server/platform shell。
- 核心 SDK/agent-server loop 在外部包里，不能过度推断。

### Claude Code

任务重点：

- 分析公开仓库能学什么、不能学什么。
- 看 commands/plugins/hooks/permissions/session/usage/tool extension examples。

审核结论：

- 不能当核心 runtime 源码。
- 可以学 extension surface 和产品交互模式。

## 4. Leader 合并时的审核清单

合并子线程产出时，不要只看“写得多不多”，看这些：

- 是否明确区分源码证据和推断？
- 是否回答了 input/session/model/tool/observation/event？
- 是否说明该仓库哪些部分不适合 Huaness Lite？
- 是否把复杂功能降级成 lite 版本？
- 是否有具体文件路径，不是泛泛而谈？
- 是否识别了安全边界：shell、write、network、model override？
- 是否能转成 Huaness Lite 的组件设计？

## 5. 下一批建议派发任务

等你明天读完第一轮文档，可以继续派更窄的任务：

1. `OpenClaw agent-core deep dive`
   - 只看 `references/openclaw/packages/agent-core/src/agent-loop.ts`。
   - 输出完整 loop 伪代码和 Huaness Lite P0 对应实现。

2. `Codex tool orchestrator deep dive`
   - 只看 `references/codex/codex-rs/core/src/tools/orchestrator.rs`、`sandboxing.rs`、`handlers/shell.rs`、`handlers/apply_patch.rs`。
   - 输出 approval/sandbox/tool execution 状态机。

3. `Gemini policy scheduler deep dive`
   - 只看 `references/gemini-cli/packages/core/src/scheduler`、`policy`、`tools/shell.ts`。
   - 输出 tool call lifecycle。

4. `mini-swe-agent tests to Huaness tests`
   - 只看 `references/mini-swe-agent/tests/agents` 和 `models/test_models.py`。
   - 输出 Huaness Lite P0 测试清单。

5. `OpenClaw channel adapter mapping`
   - 用 Telegram/Slack channel 作为外部 IM channel 类比。
   - 输出 ChannelAdapter 不应该污染 core 的边界，以及 OneBot 这类 IM 插件应如何挂接。

## 6. 给自己的阅读纪律

读大仓库时不要从目录树开始发散。每次只追一条链：

```text
入口在哪里？
状态在哪里？
模型在哪里？
工具在哪里？
权限在哪里？
事件在哪里？
停止在哪里？
```

看不懂时先回 `mini-swe-agent`。如果一个概念在 mini 里不存在，再去 Codex/Gemini/OpenClaw 看它为什么会出现。
