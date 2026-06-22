// 工具注册和执行链路使用的基础类型。

// 模型请求执行工具时给出的结构化调用。
export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// 工具执行后的结构化结果。
export type ToolResult = {
  callId: string;
  toolName: string;
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
};

// 工具接口，所有工具都通过 ToolGateway 调用。
export type Tool = {
  name: string;
  execute(toolCall: ToolCall): Promise<ToolResult> | ToolResult;
};
