// 模型适配层使用的消息和客户端类型。

import type { RunId, SessionId } from "../shared/ids.js";
import type { ToolCall } from "../tools/types.js";

// 传给模型或由模型返回的消息。
export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

// 模型单轮响应，可能包含 tool call。
export type ModelResponse = {
  message: ModelMessage;
  toolCalls?: ToolCall[];
};

// 模型适配器接口，真实 LLM 和 fake model 都实现它。
export type ModelClient = {
  complete(input: {
    runId: RunId;
    sessionId: SessionId;
    messages: ModelMessage[];
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
};
