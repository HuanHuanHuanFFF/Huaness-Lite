# Huaness Lite 技术选型调查

调查日期：2026-06-13

目标：给 Huaness Lite 定一个能马上开工、能长期演进、又能体现 Agent Harness 深度的 P0 技术栈。本文的主角是 Agent Harness，不是某个聊天平台。CLI、HTTP、IM 都只是外部 channel adapter；选型必须服务于核心链路：

```text
Channel Adapter (CLI / HTTP / IM / future channels)
  -> Gateway
  -> RunService / SessionQueue
  -> AgentLoop
  -> ToolGateway
  -> PolicyEngine / Approval
  -> ToolExecutor
  -> EventLog
  -> Replay / Eval
```

## 1. 最终推荐

P0 推荐栈：

| 层 | P0 推荐 | 不选其他方案的主因 | P1/P2 升级 |
| --- | --- | --- | --- |
| Agent core | 自研轻量 AgentLoop | 项目价值在可控 loop、step guard、tool call 生命周期，不在套现成框架 | P1 增加 compaction、multi-model、interrupt/resume |
| Tool gateway | ToolRegistry + ToolGateway + PolicyEngine + ApprovalManager | 这是 Harness 的控制面；shell/write/network 不能绕过它 | P1 持久 approvals、policy profiles、per-channel scopes |
| EventLog | JSONL append-only source of truth | 最快实现 trace、replay、审计，避免 P0 被 schema/migration 拖住 | P1 SQLite 做查询索引；P2 Postgres 支持多进程/多用户 |
| Replay/Eval | JSONL replay + fake model/tool tests + golden assertions | P0 能证明可复现和可评测，比做复杂 UI 更有面试价值 | P1 eval suite、trace viewer、失败用例最小化 |
| 主语言与运行时 | TypeScript + Node.js 24 LTS | 和 OpenClaw/Gemini CLI 参考项目同类，适合做长期服务、CLI、HTTP、工具执行 | 保持 Node LTS，core 接口稳定后再考虑多语言工具进程 |
| 服务外壳 | Fastify | 比 Express 更能守住 schema/插件边界，比 NestJS 更轻，比 Hono 更贴近 Node 后端服务 | P1 typed client 或控制台可评估 Hono；后台膨胀再评估 NestJS |
| 进程形态 | 一个核心进程，内部模块化 | P0 需要先跑通 harness 链路，不拆微服务 | P1 将 eval worker、tool worker、UI 分离 |
| 工具执行 | Node `child_process.spawn`/`execFile` + workspace guard + timeout + output cap + approval | P0 先保证可控、可记录、可解释；Docker sandbox 初期成本高 | P1 Docker sandbox；P2 per-tool container / seccomp / firejail |
| 事件流 | JSONL source of truth + HTTP SSE 投影 | P0 单向 run events 最简单；WebSocket 只在需要双向控制时上 | P1 WebSocket approval/cancel/live output |
| Channel adapter | 统一 `ChannelAdapter` 接口；OneBot 只是 IM 插件实例 | 外部频道不能决定 core 架构；先用 CLI/HTTP 验证 core，再接真实 IM | P1 增加 Telegram/Official QQ/Slack 等插件 |
| 部署 | Huaness core 用 systemd | systemd 适合 Linux 单机长期守护、日志、重启；PM2 更像开发/临时方案 | P1 Docker Compose 管理 channel plugins、backup、可选 SQLite |

一句话结论：

> Huaness Lite P0 应该做成 TypeScript/Node 的 Mini Agent Harness。真正核心是自研的 AgentLoop、ToolGateway、PolicyEngine、EventLog、Replay/Eval；Fastify 是服务外壳，CLI/HTTP/IM 都只是 channel adapter。

## 2. 决策原则

1. P0 开发速度优先，但不能牺牲 AgentLoop、ToolGateway、PolicyEngine、EventLog、Replay/Eval。
2. 任何外部频道都只能是边缘适配层，不能决定 core 架构。
3. 单台 Linux 服务器长期运行，不默认依赖复杂集群。
4. 存储先满足可追踪和可回放，再考虑复杂查询。
5. shell/write/network 工具必须支持权限拦截、超时、输出截断、事件记录。
6. 任何框架对象都不能进入 core：`FastifyRequest`、channel raw event、OneBot client、systemd/pm2 配置都只能留在 adapter/runtime 层。

## 3. P0 目标架构

```text
apps/
  server/              # Fastify HTTP/RPC/SSE ingress
  cli/                 # 本地 CLI adapter

packages/
  core/                # AgentLoop, RunService, SessionQueue, ContextBuilder
  gateway/             # method registry, auth/scope, input schema
  channels/
    cli/               # local command line channel
    http/              # HTTP channel adapter
    onebot/            # optional IM plugin: OneBot normalize + deliver
  tools/
    registry/          # tool definition and schema
    gateway/           # policy + approval + execution orchestration
    executors/         # file, search, shell, http_fetch
  policy/              # PolicyEngine, permission profiles
  runtime/             # workspace guard, process runner, future sandbox
  storage/             # JSONL EventLog, session/message stores
  eval/                # replay runner, fake model, golden assertions
```

核心依赖方向：

```text
channels -> gateway -> core -> tools -> policy/runtime/storage
```

禁止方向：

```text
core -> channels
core -> Fastify
core -> OneBot / any channel SDK
ToolExecutor -> PolicyEngine decision
EventLog -> business logic
```

## 4. 主服务框架

### 候选项矩阵

| 方案 | HTTP/RPC | Event stream / WebSocket | 插件边界 | 类型安全 | 学习成本 | P0 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| Fastify | HTTP API 强，schema 校验/序列化成熟；RPC 需自建 method registry | 可用 SSE；`@fastify/websocket` 可作为 approval/cancel 通道 | `register` 和封装模型适合拆插件 | TS 支持好，可配 TypeBox/Zod/JSON Schema | 中 | 推荐 |
| Hono | 轻，RPC 类型共享强 | SSE 很顺，Node WebSocket 仍需 adapter/ws | middleware 边界轻 | TS/RPC 体验强 | 低 | 备选，适合未来 typed client |
| NestJS | controller/module/DI 完整 | WebSocket Gateway、SSE、microservices 都有官方路径 | 模块边界强 | TS 原生，但更偏 DTO/pipe/decorator | 高 | P0 过重 |
| Express | 路由/middleware 成熟 | 需要手接 `ws`/SSE | 靠团队纪律 | TS/schema/RPC 都要自补 | 低 | 可原型，不推荐 P0 |

### P0 推荐

选 Fastify。

Fastify 在 Huaness Lite 里只承担三件事：

1. HTTP ingress：`POST /rpc/agent.run`、`POST /rpc/agent.wait`、`GET /runs/:id`。
2. 输入 contract：请求 schema、auth hook、错误格式。
3. 事件投影：`GET /runs/:id/events` 用 SSE 读取 EventLog。

不要让 Fastify 变成核心架构。核心应该是框架无关的：

```ts
interface Gateway {
  dispatch(method: string, input: unknown, ctx: RequestContext): Promise<GatewayResult>;
}
```

Fastify route 只做：

```text
parse/auth/schema -> gateway.dispatch(...) -> serialize response
```

### 风险

Fastify 风险是过度使用 `decorate` 或插件作用域，让依赖变成隐式全局状态。P0 规避方式：Fastify plugin 只能创建 route 和注入外层 adapter，不允许 core import Fastify 类型。

### P1 路线

如果要做 Web 控制台和 typed client，可以基于同一份 schema 生成客户端，或者把控制台 API 另用 Hono 封装。不要为了 typed RPC 在 P0 重写核心。

## 5. Agent Core 形态

### 推荐结论

Agent core 自研轻量 loop，不引入完整 agent framework。

原因：Huaness Lite 的学习和面试价值不在“套一个 agent 框架”，而在你能讲清楚每一步控制点：

```text
model request
model response
tool call requested
policy decision
approval requested/resolved
tool execution started/finished
observation appended
loop guard checked
run completed/failed/cancelled
```

### P0 接口形态

```ts
export interface ModelClient {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ToolRegistry {
  list(scope: ToolScope): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
}

export interface ToolGateway {
  invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
}

export interface ApprovalManager {
  request(decision: ApprovalRequired, ctx: ToolContext): Promise<ApprovalResult>;
}

export interface EventLog {
  append(event: HuanessEvent): Promise<void>;
  readRun(runId: string): AsyncIterable<HuanessEvent>;
}
```

### P0 AgentLoop 伪代码

```ts
async function runAgentLoop(run: RunContext, signal: AbortSignal) {
  await eventLog.append(runStarted(run));

  for (let step = 0; step < run.limits.maxSteps; step++) {
    const context = await contextBuilder.build(run);
    await eventLog.append(modelRequestCreated(run, context));

    const modelEvents = modelClient.stream(context, signal);
    const output = await collectModelOutput(modelEvents, eventLog);

    if (output.toolCalls.length === 0) {
      await eventLog.append(runCompleted(run, output.text));
      return output.text;
    }

    for (const call of output.toolCalls) {
      const result = await toolGateway.invoke(call, run.toolContext);
      await sessionStore.appendObservation(run.sessionId, result.observation);
    }
  }

  await eventLog.append(runFailed(run, "max_steps_exceeded"));
}
```

### 参考项目启发

OpenClaw 的本地参考里可以看到 `agent-core`、agent loop、session JSONL storage 是独立模块。Gemini CLI 的本地参考里可以看到 tool executor、tool output truncation、sandbox policy manager 被拆成清晰边界。Huaness Lite 可以学习边界，不需要照搬规模。

### 风险

最大风险是把 AgentLoop 写成“模型输出后直接执行 shell”。这样就只是聊天入口加工具，不是 harness。P0 必须把 `ToolGateway -> PolicyEngine -> Approval -> Executor -> EventLog` 做成硬路径。

## 6. Channel Adapter 边界

这一节只解决外部入口问题，不是项目主线。Huaness Lite 的第一个可用版本应该先用 CLI/HTTP 验证 core，再把真实 IM 作为 channel plugin 接上。

### P0 Channel 接口

```ts
export interface ChannelAdapter {
  name: string;
  start(ctx: ChannelRuntimeContext): Promise<void>;
  deliver(reply: OutboundMessage): Promise<void>;
}

export type InboundMessage = {
  channel: "cli" | "http" | "onebot";
  externalConversationId: string;
  externalUserId?: string;
  text: string;
  attachments?: Attachment[];
  rawEventId?: string;
  receivedAt: string;
};
```

Channel adapter 只做：

1. 把外部事件 normalize 成 `InboundMessage`。
2. 把 core 的 `OutboundMessage` deliver 回外部平台。
3. 做 channel 级别的连接、鉴权、重连、去重、raw event 归档。

Channel adapter 不做：

1. 是否允许工具执行。
2. 是否需要审批。
3. Agent loop 如何推进。
4. Tool result 如何写入上下文。
5. Replay/Eval 如何判断成功。

这些只能由 Harness core 决定。

### P0 Channel 顺序

| 顺序 | Channel | 目的 | 原因 |
| --- | --- | --- | --- |
| 1 | CLI channel | 本地调试 core | 最少外部变量，最适合验证 AgentLoop/ToolGateway/EventLog |
| 2 | HTTP channel | 暴露 RPC/SSE | 让外部系统能创建 run、看 events、回填 approval |
| 3 | OneBot channel | 接入现有 IM 使用场景 | 只是第一个真实 IM 插件，不是架构中心 |

### OneBot 插件选型

如果要替代当前服务器上的聊天入口，P0 可以用：

```text
NapCatQQ
  -> OneBot v11 reverse WebSocket
  -> channels/onebot
  -> Gateway.dispatch(...)
```

候选项只作为 channel 插件调查：

| 方案 | 结论 | 说明 |
| --- | --- | --- |
| OneBot v11 | 作为插件协议边界 | 统一 HTTP/WS/reverse WS，不让具体平台实现进入 core |
| NapCatQQ | P0 插件 provider | 当前较活跃，Linux/Docker 路径清楚 |
| Lagrange.OneBot/Core | 不作为新项目主依赖 | 2025-10-12 已归档只读 |
| go-cqhttp | 不推荐 | 停止维护，老链路风险高 |
| Official QQ Bot | P1 合规插件 | 适合公开/合规场景，但不是个人 QQ 入口等价替代 |

### Channel 风险

| 风险 | 说明 | P0 缓解 |
| --- | --- | --- |
| channel 污染 core | 外部平台字段渗入 AgentLoop/ToolGateway | core 只认 `InboundMessage` / `OutboundMessage` |
| channel 可靠性 | IM 平台断线、协议漂移、消息重复 | adapter 内重连、去重、raw event 归档 |
| 外部接口暴露 | OneBot/HTTP 如果未鉴权暴露公网风险高 | 只监听本机或内网，必须 token |
| 权限错配 | 群聊/陌生来源触发高危工具 | channel 只提供 source/scope，最终由 PolicyEngine 决策 |

## 7. 存储与 EventLog

### 候选项矩阵

| 方案 | trace 写入 | 回放 | 查询 | 一致性 | 部署复杂度 | P0 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| JSONL + 文件目录 | append-only 最自然 | 逐行读事件重建 run | 弱，靠目录/索引 | 单文件 append 可控，跨文件弱 | 最低 | 推荐 |
| SQLite | event 表和索引更强 | 可按 seq 回放 | 强于 JSONL | 事务可靠，WAL 支持读写并发但仍单写者 | 低 | P1 |
| Postgres | 并发和查询最强 | 可回放 | 最强 | ACID 完整 | 高 | P2 |

### P0 推荐

P0 选 JSONL + 文件目录，EventLog 是 source of truth。

建议目录：

```text
data/
  runs/
    2026-06/
      run_01J...jsonl
  sessions/
    session_01J.../
      messages.jsonl
      summary.json
  raw/
    channels/
      onebot-2026-06-13.jsonl
  evals/
    results.jsonl
```

事件最小字段：

```ts
type HuanessEvent = {
  id: string;
  runId: string;
  sessionId: string;
  seq: number;
  type: string;
  ts: string;
  data: unknown;
  schemaVersion: number;
};
```

P0 必须记录这些事件：

| 事件 | 用途 |
| --- | --- |
| `run.created` | run 边界 |
| `model.requested` | 当时模型看到了什么 |
| `model.output` | 模型返回了什么 |
| `tool.requested` | 模型想调什么工具 |
| `policy.decided` | 为什么放行/拒绝/审批 |
| `approval.requested` / `approval.resolved` | 人类介入证据 |
| `tool.started` / `tool.finished` | 执行输入、输出摘要、耗时、退出码 |
| `session.observation_appended` | 上下文变化 |
| `run.completed` / `run.failed` / `run.cancelled` | run 结束状态 |

### 风险

JSONL 风险不是“功能不够高级”，而是写入纪律：

1. 每个 run 单文件或每个 session 串行队列，避免乱序。
2. 每条 JSON 必须 newline 结尾。
3. 启动时要能跳过或报告坏行。
4. secret 必须 redaction 后入日志。
5. 输出大文本只记录摘要和 artifact path。

### P1 路线

P1 上 SQLite，但不要删 JSONL。SQLite 做查询索引和状态快照：

```text
runs
sessions
events
messages
tool_calls
eval_results
```

写入策略推荐：

```text
append JSONL first -> ingest/update SQLite index
```

这样 replay 仍然读原始 JSONL，SQLite 只是加速查询。

## 8. 工具执行与安全链

### 候选项矩阵

| 方案 | 能力 | 优点 | 缺点 | P0 结论 |
| --- | --- | --- | --- | --- |
| Node `child_process.spawn` | 运行命令，流式 stdout/stderr，可 AbortSignal | 原生、可控、适合 timeout 和输出截断 | 不是 sandbox，命令注入风险要自己管 | 推荐 |
| Node `execFile` | 不经 shell 执行固定程序 | 比 `exec` 更适合结构化工具 | 不适合任意 shell 语义 | 固定工具优先 |
| Node `exec` | shell 字符串 | 兼容用户 shell 命令 | 注入和 quoting 风险最高 | 高风险工具，必须审批 |
| Docker sandbox | 隔离文件系统/网络/进程 | 安全边界更强 | P0 运维和性能成本高 | P1 |
| 只做 path guard | 实现快 | 能防误写 workspace 外 | 不能限制进程、网络、系统调用 | P0 的最低线，不是完整安全 |

### P0 推荐安全链

任何工具调用都必须走：

```text
ToolGateway.invoke()
  -> ToolRegistry.get()
  -> validate args
  -> PolicyEngine.evaluate()
  -> ApprovalManager.request() if required
  -> ToolExecutor.execute()
  -> EventLog.append()
```

P0 policy profile：

| Profile | 读文件 | 写文件 | shell | 网络 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `read_only` | workspace 内可读 | 禁止 | 禁止 | 禁止或白名单 | 群聊默认 |
| `workspace_write` | workspace 内可读 | workspace 内可写 | 需要审批 | 需要审批 | 私聊可信会话 |
| `full_access` | 可配置 | 可配置 | 每次审批或持久审批 | 每次审批或白名单 | 维护者本地/CLI |

### Workspace guard 规则

P0 不要用字符串 `startsWith` 判路径。建议规则：

1. `realpath(workspaceRoot)` 得到真实根路径。
2. 对用户输入 path 做 resolve + realpath 或父目录 realpath。
3. 用 `path.relative(root, target)` 判断是否逃逸。
4. 禁止写入 `.git`、`node_modules`、`data/raw-secret` 等敏感路径，除非显式允许。
5. 所有 write/shell 都记录 `cwd`、resolved path、decision、approval id。

### Shell runner 最小要求

| 要求 | P0 规则 |
| --- | --- |
| cwd | 必须在 workspace 内 |
| timeout | 默认 30s，可按 tool 配置上限 |
| output cap | stdout/stderr 分别截断，完整输出可落 artifact |
| env | 默认最小环境，敏感变量不透传 |
| signal | 支持 cancel run 时杀进程 |
| exit code | 进入 tool result 和 EventLog |
| approval | shell 默认需要审批，低风险命令可后续白名单 |

### 风险

P0 最大安全风险是“模型生成 shell 字符串后直接执行”。这会让项目在实际使用中不可控，也会让面试讲不出 harness 价值。你要把安全链作为核心功能，而不是附加功能。

## 9. 部署运行

### 候选项矩阵

| 方案 | 优点 | 缺点 | P0 结论 |
| --- | --- | --- | --- |
| systemd | Linux 原生，长期守护，journalctl 查日志，重启策略清晰 | 需要写 unit，Node 版本路径要固定 | 推荐 |
| pm2 | Node 项目启动快，日志/重启/monitor 简单 | 又套一层 daemon，最终还是要接 systemd startup | 开发或临时服务器可用 |
| Docker Compose | 服务编排、网络、volume、channel plugins、Postgres 等方便 | P0 会增加镜像、volume、权限、日志复杂度 | P1；外部 channel provider 可先独立部署 |

### P0 推荐

Huaness core 用 systemd。P0 部署的中心是 core 服务，不是某个外部频道：

```text
huaness-lite.service
  WorkingDirectory=/opt/huaness-lite
  ExecStart=/usr/bin/node dist/apps/server/main.js
  Restart=on-failure
  EnvironmentFile=/etc/huaness-lite/env
```

外部 channel provider 按自己的文档部署。为了减少公网暴露，优先让 provider 与 Huaness 在同机本地网络或 Docker 内网通信：

```text
channel provider -> ws://127.0.0.1:<port>/channels/<name>
```

如果某个 channel provider 用 Docker，Huaness core 仍可先裸机 systemd。等 P1 再统一成 Compose：

```text
compose:
  huaness-core
  optional-channel-provider
  backup job
  optional sqlite volume
```

### 日志策略

P0 日志分两类：

1. 运行日志：Pino -> stdout -> journald。
2. 事实日志：EventLog -> JSONL。

不要把这两类混用。运行日志用来看服务健康，EventLog 用来 replay/eval/audit。

## 10. Eval 与 Replay 最小方案

### P0 推荐

P0 做“能证明 core 可复现”的最小 eval，不做复杂 benchmark 平台。

三件事：

1. `replay run_*.jsonl`：逐行读事件，重建 run timeline。
2. `FakeModelClient`：给定脚本化输出，稳定地产生 tool call/text。
3. `eval cases`：输入消息、权限 profile、fake model script、期望事件断言。

### Eval case 示例

```ts
type EvalCase = {
  id: string;
  input: InboundMessage;
  permissionProfile: "read_only" | "workspace_write";
  modelScript: ModelEvent[];
  expect: {
    finalStatus: "completed" | "failed" | "waiting_approval";
    requiredEvents: string[];
    forbiddenTools?: string[];
  };
};
```

P0 评测指标：

| 指标 | 说明 |
| --- | --- |
| run 是否完成 | 不死循环，不丢状态 |
| tool 顺序是否正确 | 模型请求和执行结果可对齐 |
| policy 是否命中 | read_only 下 shell/write 必须 deny 或 approval |
| trace 是否完整 | 每个关键动作都有事件 |
| replay 是否可重建 | 不依赖当前内存状态 |

### P1 路线

1. trace viewer：按 run 展示 model/tool/policy/approval。
2. eval runner：批量跑 fake model cases。
3. regression suite：修 policy/tool 时先跑 eval。
4. diff mode：两个 run 对比事件差异。

## 11. 分专题结论

### 11.1 Node 后端框架

P0：Fastify。

优点：

1. schema、路由、插件封装适合做 Gateway 外壳。
2. 性能和生态足够，不需要为 P0 自建 HTTP 框架。
3. 比 NestJS 少很多框架仪式感，核心更容易保持纯净。

缺点：

1. 没有 Hono 那种端到端 RPC，需要自己设计 method registry。
2. 插件封装如果滥用，会变成隐式依赖。

对 Huaness Lite 的影响：

1. `channels/http` 或 `apps/server` 持有 Fastify。
2. `gateway/core/tools` 不 import Fastify。
3. API contract 放在 gateway 层统一管理。

### 11.2 Channel Adapter

P0：统一 `ChannelAdapter` 接口，先 CLI/HTTP，OneBot 只是第一个真实 IM 插件。

优点：

1. core 可以不依赖任何聊天平台。
2. CLI/HTTP 能最早验证 AgentLoop、ToolGateway、EventLog。
3. 后续接 OneBot、Telegram、Slack、Official QQ 时不改 core。

缺点：

1. 需要先设计好 `InboundMessage` / `OutboundMessage`。
2. 每个真实 channel 都要处理连接、鉴权、重连、去重。

对 Huaness Lite 的影响：

1. channel 是插件，不是 core。
2. 群聊、陌生来源、公开 Webhook 默认低权限。
3. 所有 tool 权限走 PolicyEngine。

### 11.3 存储/EventLog

P0：JSONL + 文件目录。

优点：

1. 最适合 append-only trace。
2. replay 最直接。
3. 部署零依赖。

缺点：

1. 查询弱。
2. 并发写入纪律要自己保证。

对 Huaness Lite 的影响：

1. EventLog 抽象先写稳。
2. P1 SQLite 可以作为索引层，不改 core。
3. 面试能清楚展示可追踪、可回放。

### 11.4 Tool/Policy 安全链

P0：Node 原生进程执行 + workspace guard + approval。

优点：

1. 开发快。
2. 控制点清楚。
3. 能直接落事件。

缺点：

1. 不是真正 sandbox。
2. network/system call 无法从 OS 层隔离。

对 Huaness Lite 的影响：

1. ToolGateway 是核心模块，不是工具集合。
2. shell/write/network 是默认高风险工具。
3. Docker sandbox 放 P1，不阻塞 P0。

### 11.5 Linux 单机部署

P0：systemd。

优点：

1. Linux 服务器长期运行稳定。
2. 日志、重启、开机启动都直接。
3. 比 PM2 少一层 Node daemon。

缺点：

1. 需要写 unit 和环境文件。
2. 多服务编排不如 Compose。

对 Huaness Lite 的影响：

1. core 服务可长期替代当前 OpenClaw 项目。
2. 运行日志交给 journald。
3. EventLog 仍写到 data 目录。

### 11.6 Eval/Replay

P0：JSONL replay + fake model eval。

优点：

1. 直接证明 harness 能力。
2. 不依赖真实模型和真实外部频道。
3. 能做回归测试。

缺点：

1. 不是完整 benchmark。
2. 需要一开始就设计事件 schema。

对 Huaness Lite 的影响：

1. 每个核心事件都要稳定命名。
2. tool/policy 的测试优先级高于 UI。
3. 这是项目区别于普通聊天入口或简单 agent demo 的关键展示点。

## 12. 建议开工顺序

1. 建 monorepo 骨架：TypeScript、Node 24 LTS、pnpm、Vitest、ESLint/Prettier。
2. 定 core types：`Run`、`Session`、`InboundMessage`、`ToolCall`、`PolicyDecision`、`HuanessEvent`。
3. 实现 JSONL `EventLog.append/readRun`。
4. 实现 `FakeModelClient` 和最小 `AgentLoop`。
5. 实现 `ToolRegistry`、`ToolGateway`、`PolicyEngine`，先接 `finish/read_file/list_files/search_text`。
6. 加 `write_file/shell`，强制 approval、timeout、output cap、workspace guard。
7. 用 Fastify 暴露 `/rpc/agent.run`、`/rpc/agent.wait`、`/runs/:id/events`。
8. 接 CLI channel，先不用任何 IM 平台验证 core。
9. 接 HTTP channel 和可选 OneBot channel，只做 normalize/deliver。
10. 做 replay/eval：fake model cases 覆盖 read_only deny、approval、tool success/failure。
11. 写 systemd unit 和服务器部署说明。

## 13. P0 不能做什么

这些都不是 P0 主线：

1. 复杂 Web dashboard。
2. 多用户权限后台。
3. Postgres + migration 系统。
4. 完整 Docker sandbox。
5. 插件市场。
6. 多模型 provider 大集合。
7. 长期记忆/RAG。
8. 仿 OpenClaw 全生态 channel。

这些可以作为 P1/P2，但 P0 的核心必须先跑通：

```text
可控执行 + 完整 trace + 可回放 + 可评测
```

## 14. 来源索引

### 官方/项目资料

- Node.js release schedule: https://nodejs.org/en/about/previous-releases
- Fastify docs: https://fastify.dev/docs/latest/
- Fastify TypeScript: https://fastify.dev/docs/latest/Reference/TypeScript/
- Fastify plugins: https://fastify.dev/docs/latest/Reference/Plugins/
- Hono docs: https://hono.dev/docs/
- Hono RPC: https://hono.dev/docs/guides/rpc
- NestJS docs: https://docs.nestjs.com/
- NestJS WebSocket gateways: https://docs.nestjs.com/websockets/gateways
- Express routing: https://expressjs.com/en/guide/routing.html
- OneBot ecosystem: https://onebot.dev/ecosystem
- OneBot v11 HTTP: https://raw.githubusercontent.com/botuniverse/onebot-11/master/communication/http.md
- OneBot v11 WebSocket: https://raw.githubusercontent.com/botuniverse/onebot-11/master/communication/ws.md
- OneBot v11 reverse WebSocket: https://raw.githubusercontent.com/botuniverse/onebot-11/master/communication/ws-reverse.md
- NapCatQQ GitHub: https://github.com/NapNeko/NapCatQQ
- NapCat docs: https://napneko.github.io/
- NapCat security notes: https://napneko.github.io/other/security
- Lagrange.Core GitHub: https://github.com/LagrangeDev/Lagrange.Core
- JSON Lines: https://jsonlines.org/
- SQLite when to use: https://www.sqlite.org/whentouse.html
- SQLite WAL: https://www.sqlite.org/wal.html
- PostgreSQL transactions: https://www.postgresql.org/docs/current/tutorial-transactions.html
- PostgreSQL WAL: https://www.postgresql.org/docs/current/wal-intro.html
- Node child_process: https://nodejs.org/api/child_process.html
- systemd.service: https://man7.org/linux/man-pages/man5/systemd.service.5.html
- PM2 quick start: https://pm2.keymetrics.io/docs/usage/quick-start/
- PM2 startup: https://pm2.keymetrics.io/docs/usage/startup/
- Docker Compose docs: https://docs.docker.com/compose/

### 本地参考项目

- `references/openclaw/packages/agent-core/src/agent-loop.ts`
- `references/openclaw/packages/agent-core/src/harness/session/jsonl-storage.ts`
- `references/openclaw/package.json`
- `references/gemini-cli/packages/core/src/scheduler/tool-executor.ts`
- `references/gemini-cli/packages/core/src/policy/sandboxPolicyManager.ts`
- `references/gemini-cli/package.json`
- `references/mini-swe-agent/pyproject.toml`
