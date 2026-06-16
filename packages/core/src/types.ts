// Core 运行链路的共享类型定义。

// 当前 core 事件 schema 版本。
export const CORE_SCHEMA_VERSION = 1;

// 事件 schema 版本类型。
export type CoreSchemaVersion = typeof CORE_SCHEMA_VERSION;

// 一次 agent run 的唯一标识。
export type RunId = string;

// 一段会话的唯一标识。
export type SessionId = string;

// Agent 运行过程中的可观察事件。
export type AgentEvent = {
  schemaVersion: CoreSchemaVersion;
  type: string;
  runId: RunId;
  sessionId: SessionId;
  timestamp: string;
  data?: Record<string, unknown>;
};

// 传给模型或由模型返回的消息。
export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

// 模型请求执行工具时给出的结构化调用。
export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// 工具执行后的结构化结果。
export type ToolResult = {
  callId: string;
  output: string;
  metadata?: Record<string, unknown>;
};

// 模型单轮响应，可能包含 tool call。
export type ModelResponse = {
  message: ModelMessage;
  toolCalls?: ToolCall[];
};

// 模型适配器接口，真实 LLM 和 fake model 都实现它。
export type ModelClient = {
  // 根据当前消息上下文返回下一步模型响应。
  complete(input: {
    runId: RunId;
    sessionId: SessionId;
    messages: ModelMessage[];
  }): Promise<ModelResponse>;
};

// 策略引擎对工具调用的决策结果。
export type PolicyDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "requires_approval"; reason: string };

// 事件写入接口，当前可由内存实现承接。
export type EventSink = {
  // 记录一个 agent 运行事件。
  append(event: AgentEvent): Promise<void> | void;
};

// 工具调用策略接口，后续可扩展审批和权限规则。
export type PolicyEngine = {
  // 判断一次工具调用是否允许执行。
  decide(input: {
    runId: RunId;
    sessionId: SessionId;
    toolCall: ToolCall;
  }): Promise<PolicyDecision> | PolicyDecision;
};

// 工具接口，所有工具都通过 ToolGateway 调用。
export type Tool = {
  name: string;
  // 执行一次工具调用并返回结果。
  execute(toolCall: ToolCall): Promise<ToolResult> | ToolResult;
};

// 启动一次 agent run 所需的最小输入。
export type AgentRunInput = {
  runId: RunId;
  sessionId: SessionId;
  userMessage: string;
};

// 一次 agent run 完成后的最小输出。
export type AgentRunResult = {
  finalAnswer: string;
  toolResults: ToolResult[];
};
