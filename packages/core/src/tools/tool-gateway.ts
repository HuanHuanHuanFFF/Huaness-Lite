// 最小工具网关，负责策略检查、工具查找、执行和事件记录。

import { createAgentEvent } from "../events/create-agent-event.js";
import type {
  EventSink,
  PolicyEngine,
  RunId,
  SessionId,
  Tool,
  ToolCall,
  ToolResult
} from "../types.js";

export class ToolGateway {
  private readonly eventSink: EventSink;
  private readonly policyEngine: PolicyEngine;
  private readonly tools: Map<string, Tool>;

  // 注入工具列表、策略引擎和事件接收器。
  constructor(input: {
    eventSink: EventSink;
    policyEngine: PolicyEngine;
    tools: Tool[];
  }) {
    this.eventSink = input.eventSink;
    this.policyEngine = input.policyEngine;
    this.tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  }

  // 执行一次工具调用，必须先经过 policy 决策。
  async execute(input: {
    runId: RunId;
    sessionId: SessionId;
    toolCall: ToolCall;
  }): Promise<ToolResult> {
    await this.emit(input, "tool.requested", {
      toolCall: input.toolCall
    });

    const decision = await this.policyEngine.decide(input);

    await this.emit(input, "policy.decided", {
      decision,
      toolCall: input.toolCall
    });

    if (decision.kind !== "allow") {
      throw new Error(`Tool call blocked by policy: ${decision.reason}`);
    }

    const tool = this.tools.get(input.toolCall.name);

    if (!tool) {
      throw new Error(`Unknown tool: ${input.toolCall.name}`);
    }

    const result = await tool.execute(input.toolCall);

    await this.emit(input, "tool.completed", {
      result,
      toolCall: input.toolCall
    });

    return result;
  }

  // 记录工具网关产生的事件。
  private async emit(
    input: { runId: RunId; sessionId: SessionId },
    type: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await this.eventSink.append(
      createAgentEvent({
        type,
        runId: input.runId,
        sessionId: input.sessionId,
        data
      })
    );
  }
}
