# Huaness Lite 开发推进策略

本文用于指导 Huaness Lite 从文档研究进入代码实现。核心策略是：

> 先做最小可运行骨架，再做一个核心单模块的纵向切片。

这不是先做完整 MVP，也不是把单个模块关起来孤岛式开发。当前更合适的方式是：先建立极薄的工程骨架和核心接口边界，再选择一个最能代表 Agent Harness 价值的模块做深、做透、做可测试。

## 1. 当前结论

Huaness Lite 的第一阶段不要追求“功能完整”，而是先证明这条链路能被工程化承载：

```text
run/session
  -> AgentLoop
  -> ToolGateway
  -> PolicyEngine / Approval
  -> EventLog
  -> Replay / Eval
```

第一阶段的目标不是接入真实 LLM、真实 shell、完整 Fastify API 或复杂部署，而是确认：

- TypeScript 工程能跑。
- core 类型和模块边界清楚。
- fake run 能产生可读的 JSONL event log。
- 后续每个模块都能挂回这条链路验收。

## 2. 为什么不是直接整体 MVP

直接铺完整 MVP 的风险很高：

- 会过早同时处理 Fastify、真实 LLM、真实 shell、配置、部署和测试。
- TypeScript 与工程组织还没稳定时，不同模块容易写出不同风格。
- 状态管理、接口抽象、错误处理、事件格式会在没有真实样板前被提前设计。
- 最后可能出现很多入口和文件，但没有一条 Agent Harness 流程真正稳定。

所以 P0 不做横向铺开的产品 MVP。Fastify、真实模型、真实命令执行都应该在 core 纵向样板稳定后再接入。

## 3. 为什么也不是纯单模块开发

纯单模块开发也容易变成孤岛。

例如单独把 `PolicyEngine` 写得很完整，但没有和 `AgentLoop`、`ToolGateway`、`EventLog` 接起来，最后可能发现策略输入、事件记录、approval 状态和 run/session 生命周期都需要返工。

Huaness Lite 的价值在模块之间的控制关系，而不是单个模块本身：

```text
AgentLoop 不能直接执行工具。
ToolGateway 不能绕过 PolicyEngine。
PolicyEngine 的决策必须能被 EventLog 记录。
Replay/Eval 必须能从事件里复原关键行为。
```

所以单模块可以深挖，但必须放在一个最小骨架里验收。

## 4. 阶段一：最小工程骨架

先建立能跑起来、能扩展、能测试的空壳。

建议最小目录：

```text
apps/
  server/              # Fastify 外壳，P0 可先占位

packages/
  core/
    src/
      events/
      loop/
      model/
      policy/
      replay/
      tools/
      types.ts
      index.ts
    tests/
```

这一阶段只做必要内容：

- pnpm workspace。
- TypeScript 编译配置。
- Vitest 基础测试。
- ESLint / Prettier 基础配置。
- `packages/core` 的公开入口。
- 最小核心类型：`RunId`、`SessionId`、`AgentEvent`、`ModelClient`、`ToolCall`、`ToolResult`、`PolicyDecision`。

这一阶段不要做复杂业务：

- 不接真实 LLM。
- 不接真实 shell。
- 不做完整 HTTP API。
- 不做 UI。
- 不做复杂配置系统。
- 不抽象插件系统。

阶段验收标准：

```text
pnpm install
pnpm test
pnpm typecheck
```

能跑通即可。如果某个命令暂时不存在，要在 README 或 AGENTS.md 里明确当前可用命令。

## 5. 阶段二：第一个核心模块纵向切片

第一个建议深挖模块是 `EventLog`。

原因：

- JSONL append-only 是 Harness 与普通聊天机器人的关键区别。
- 后续 AgentLoop、ToolGateway、PolicyEngine 都要依赖事件记录来证明行为。
- EventLog 相对稳定，不依赖真实模型和真实工具。
- 最容易写出清晰测试。

`EventLog V1` 至少包含：

- append event。
- read events by run。
- 保持事件顺序。
- 基础 schema version。
- 写入失败时返回明确错误。
- 测试覆盖 append/read/order。

最小事件可以先包括：

```text
run.created
model.requested
model.responded
tool.requested
policy.decided
tool.completed
run.completed
run.failed
```

纵向验收不是只测试文件读写，而是让一个 fake run 真的写出事件，再从 JSONL 读回来断言顺序和内容。

## 6. 阶段三：FakeModelClient + 最小 AgentLoop

EventLog 稳定后，再接最小 AgentLoop。

先用 `FakeModelClient`，不要急着接真实 LLM。Fake 模型固定模拟两步：

```text
step 1: 返回一个 tool call
step 2: 收到 tool result 后返回 final answer
```

这一阶段要跑通：

```text
create run
  -> FakeModelClient returns tool call
  -> AgentLoop asks ToolGateway
  -> PolicyEngine returns allow
  -> fake tool returns result
  -> EventLog records all steps
  -> FakeModelClient returns final answer
  -> run completed
```

验收重点：

- `AgentLoop` 不直接执行工具。
- `ToolGateway` 不绕过 policy。
- 每个关键动作都进入 EventLog。
- 测试可以稳定复现，不依赖网络和真实模型。

## 7. 阶段四：加深 ToolGateway / PolicyEngine

当 fake loop 能跑后，再分别加深工具和策略。

`ToolGateway V1` 可以先做：

- tool registry。
- tool name 查找。
- 参数校验入口。
- fake executor。
- output cap 抽象。
- timeout 抽象。

`PolicyEngine V1` 可以先做：

- `allow`。
- `deny`。
- `requires_approval`。
- 决策理由。
- 决策事件记录。

真实 `child_process.spawn` / `execFile` 放到后面。先把策略和事件记录跑顺，再接真实执行环境。

## 8. 阶段五：再接外壳和真实依赖

只有 core 跑通后，再接外部系统：

- Fastify HTTP/RPC/SSE。
- real LLM adapter。
- shell command tool。
- workspace guard。
- approval API。
- replay/eval CLI。
- Linux systemd 部署。

接入原则：

- Fastify 只调用 core，不把 `FastifyRequest` 传进 core。
- 真实 LLM 只实现 `ModelClient`，不改 AgentLoop 主体。
- shell tool 必须走 ToolGateway、PolicyEngine、EventLog。
- 外部 channel 只做 adapter，不拥有 run/session 决策权。

## 9. TypeScript 学习策略

实现时不需要先系统学完整个 TypeScript。优先掌握能让边界清楚的部分：

```ts
type RunId = string;

type PolicyDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "requires_approval"; reason: string };

type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};
```

优先使用：

- `type` / `interface`。
- union type。
- array 类型。
- function 参数和返回值类型。
- component 或 class 的输入输出类型。
- API / event 的结构化返回值类型。

暂时避免：

- 高级泛型。
- 条件类型。
- 类型体操。
- 过早做复杂 utility types。
- 为了抽象而抽象。

当前目标不是写出炫技类型，而是让数据结构清楚、模块边界清楚、错误尽早暴露。

## 10. 每一步的判断标准

每次准备加功能前，先问：

> 这一步是在降低未知风险，还是在制造更多架构负担？

优先做能降低未知风险的事：

- 跑通 TypeScript 工程。
- 明确 core 类型。
- 让事件可落盘。
- 用 fake model 跑通 loop。
- 让工具调用必须经过 policy。
- 用测试证明 replay 能读回关键事件。

暂缓会制造负担的事：

- 完整 UI。
- 多 channel 同时接入。
- 真实 LLM streaming 细节。
- 复杂权限系统。
- 数据库 schema。
- 插件市场或动态插件加载。
- 多进程 worker。

## 11. 推荐近期里程碑

### Milestone 1：工程骨架可运行

目标：

- pnpm workspace 建好。
- `packages/core` 可编译。
- Vitest 能运行。
- 核心类型能被测试引用。

不要求：

- 没有真实 AgentLoop。
- 没有真实 LLM。
- 没有真实工具执行。

### Milestone 2：EventLog V1

目标：

- JSONL append/read。
- run 级别事件读取。
- 顺序稳定。
- schema version。
- 单元测试覆盖。

### Milestone 3：Fake Agent Run

目标：

- FakeModelClient。
- 最小 AgentLoop。
- fake tool。
- allow policy。
- 完整事件落盘。
- replay smoke test。

完成 Milestone 3 后，再考虑 Fastify、真实 LLM 和真实 shell 工具。

