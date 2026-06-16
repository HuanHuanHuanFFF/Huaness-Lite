// 验证 core 包最早暴露的公共类型可以被正常引用。

import { describe, expect, test } from "vitest";

import { CORE_SCHEMA_VERSION } from "../src/index.js";
import type {
  AgentEvent,
  ModelClient,
  PolicyDecision,
  RunId,
  SessionId,
  ToolCall,
  ToolResult
} from "../src/index.js";

describe("core public types", () => {
  // 覆盖 Milestone 1 的类型和导出形状。
  test("exports the first milestone core API shape", async () => {
    const runId: RunId = "run_01";
    const sessionId: SessionId = "session_01";

    const toolCall: ToolCall = {
      id: "call_01",
      name: "echo",
      args: { text: "hello" }
    };

    const toolResult: ToolResult = {
      callId: toolCall.id,
      output: "hello"
    };

    const decision: PolicyDecision = {
      kind: "allow",
      reason: "placeholder test fixture"
    };

    const event: AgentEvent = {
      schemaVersion: CORE_SCHEMA_VERSION,
      type: "run.created",
      runId,
      sessionId,
      timestamp: "2026-06-15T00:00:00.000Z",
      data: { source: "test" }
    };

    const modelClient: ModelClient = {
      complete: async () => ({
        message: {
          role: "assistant",
          content: "ready"
        },
        toolCalls: [toolCall]
      })
    };

    const response = await modelClient.complete({
      runId,
      sessionId,
      messages: [{ role: "user", content: "start" }]
    });

    expect(event.schemaVersion).toBe(1);
    expect(decision.kind).toBe("allow");
    expect(toolResult.callId).toBe(toolCall.id);
    expect(response.message.content).toBe("ready");
    expect(response.toolCalls).toEqual([toolCall]);
  });
});
