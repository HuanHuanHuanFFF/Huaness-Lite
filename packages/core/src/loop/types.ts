// AgentLoop 运行输入和输出类型。

import type { RunId, SessionId } from "../shared/ids.js";
import type { ToolResult } from "../tools/types.js";

// 启动一次 agent run 所需的最小输入。
export type AgentRunInput = {
  runId: RunId;
  sessionId: SessionId;
  userMessage: string;
  maxSteps?: number;
  signal?: AbortSignal;
};

// 一次 agent run 完成后的最小输出。
export type AgentRunResult = {
  finalAnswer: string;
  toolResults: ToolResult[];
};
