// 最小工具网关，负责策略检查、工具查找、执行和事件记录。

import type {
  AgentEvent,
  AgentEventDataByType,
  AgentEventDraft,
  AgentEventType,
  EventWriter
} from "../events/types.js";
import type { PolicyEngine } from "../policy/types.js";
import type {
  RunId,
  SessionId
} from "../shared/ids.js";
import type {
  Tool,
  ToolCall,
  ToolResult
} from "./types.js";

export type ToolGatewayResult = {
  result: ToolResult;
  terminalEvent: AgentEvent;
};

export class ToolGateway {
  private readonly eventWriter: EventWriter;
  private readonly policyEngine: PolicyEngine;
  private readonly tools: Map<string, Tool>;

  // 注入工具列表、策略引擎和事件写入端。
  constructor(input: {
    eventWriter: EventWriter;
    policyEngine: PolicyEngine;
    tools: Tool[];
  }) {
    this.eventWriter = input.eventWriter;
    this.policyEngine = input.policyEngine;
    this.tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  }

  // 执行一次工具调用，必须先经过 policy 决策。
  async execute(input: {
    runId: RunId;
    sessionId: SessionId;
    step: number;
    toolCall: ToolCall;
    signal?: AbortSignal;
  }): Promise<ToolGatewayResult> {
    this.throwIfAborted(input.signal);

    await this.emit(input, "tool.requested", {
      toolCall: input.toolCall
    });

    this.throwIfAborted(input.signal);

    const decision = await this.policyEngine.decide(input);

    await this.emit(input, "policy.decided", {
      decision,
      toolCall: input.toolCall
    });

    this.throwIfAborted(input.signal);

    if (decision.kind !== "allow") {
      const result = this.createErrorResult(
        input.toolCall,
        `Tool call blocked by policy: ${decision.reason}`
      );

      const terminalEvent = await this.emit(input, "tool.blocked", {
        result,
        toolCall: input.toolCall
      });

      return { result, terminalEvent };
    }

    const tool = this.tools.get(input.toolCall.name);

    if (!tool) {
      const result = this.createErrorResult(
        input.toolCall,
        `Unknown tool: ${input.toolCall.name}`
      );

      const terminalEvent = await this.emit(input, "tool.failed", {
        result,
        toolCall: input.toolCall
      });

      return { result, terminalEvent };
    }

    this.throwIfAborted(input.signal);

    try {
      const rawResult = await tool.execute(input.toolCall);

      this.throwIfAborted(input.signal);

      const result = this.normalizeResult(input.toolCall, rawResult);

      const terminalEvent = await this.emit(input, "tool.completed", {
        result,
        toolCall: input.toolCall
      });

      return { result, terminalEvent };
    } catch (error) {
      if (this.isCancellation(input.signal, error)) {
        throw error;
      }

      const result = this.createErrorResult(
        input.toolCall,
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      );

      const terminalEvent = await this.emit(input, "tool.failed", {
        result,
        toolCall: input.toolCall
      });

      return { result, terminalEvent };
    }
  }

  private normalizeResult(
    toolCall: ToolCall,
    result: ToolResult
  ): ToolResult {
    return {
      ...result,
      callId: toolCall.id,
      toolName: toolCall.name
    };
  }

  private createErrorResult(toolCall: ToolCall, output: string): ToolResult {
    return {
      callId: toolCall.id,
      toolName: toolCall.name,
      output,
      isError: true
    };
  }

  // 记录工具网关产生的事件 draft，完整 envelope 由 EventLog 补齐。
  private async emit<Type extends AgentEventType>(
    input: {
      runId: RunId;
      sessionId: SessionId;
      step: number;
      toolCall: ToolCall;
    },
    type: Type,
    data: AgentEventDataByType[Type]
  ): Promise<AgentEvent> {
    return this.eventWriter.append({
      type,
      runId: input.runId,
      sessionId: input.sessionId,
      source: "tool_gateway",
      step: input.step,
      toolCallId: input.toolCall.id,
      data
    } as AgentEventDraft);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const error = new Error("Tool execution cancelled");
      error.name = "AbortError";
      throw error;
    }
  }

  private isCancellation(
    signal: AbortSignal | undefined,
    error: unknown
  ): boolean {
    return (
      signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError")
    );
  }
}
