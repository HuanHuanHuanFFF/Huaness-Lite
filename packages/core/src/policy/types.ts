// 工具调用策略层使用的决策类型。

import type { RunId, SessionId } from "../shared/ids.js";
import type { ToolCall } from "../tools/types.js";

// 策略引擎对工具调用的决策结果。
export type PolicyDecision =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "requires_approval"; reason: string };

// 工具调用策略接口，后续可扩展审批和权限规则。
export type PolicyEngine = {
  decide(input: {
    runId: RunId;
    sessionId: SessionId;
    toolCall: ToolCall;
  }): Promise<PolicyDecision> | PolicyDecision;
};
