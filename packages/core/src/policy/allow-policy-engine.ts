// 最小策略引擎，mock run 阶段默认允许所有工具调用。

import type { PolicyDecision, PolicyEngine } from "../types.js";

// 固定返回 allow，用于验证 ToolGateway 必须经过 policy。
export class AllowPolicyEngine implements PolicyEngine {
  // 返回允许执行的策略决策。
  decide(): PolicyDecision {
    return {
      kind: "allow",
      reason: "mock policy allows every tool call"
    };
  }
}
