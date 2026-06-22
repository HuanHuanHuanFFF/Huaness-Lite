// 验证 core 包最早暴露的公共类型可以被正常引用。

import { describe, expect, test } from "vitest";

import { CORE_SCHEMA_VERSION } from "../src/index.js";
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  AgentEventSource,
  EventLog,
  EventReader,
  EventWriter,
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
    const eventType: AgentEventType = "run.created";
    const eventSource: AgentEventSource = "agent_loop";

    const toolCall: ToolCall = {
      id: "call_01",
      name: "echo",
      args: { text: "hello" }
    };

    const toolResult: ToolResult = {
      callId: toolCall.id,
      toolName: toolCall.name,
      output: "hello"
    };

    const decision: PolicyDecision = {
      kind: "allow",
      reason: "placeholder test fixture"
    };

    const event: AgentEvent = {
      schemaVersion: CORE_SCHEMA_VERSION,
      id: "event_01",
      seq: 1,
      type: eventType,
      runId,
      sessionId,
      source: eventSource,
      timestamp: "2026-06-15T00:00:00.000Z",
      data: { userMessage: "start" }
    };

    const eventDraft: AgentEventDraft = {
      type: eventType,
      runId,
      sessionId,
      source: eventSource,
      data: { userMessage: "start" }
    };

    const eventWriter: EventWriter = {
      append: () => event
    };

    const eventReader: EventReader = {
      readByRun: () => [event]
    };

    const eventLog: EventLog = {
      append: eventWriter.append,
      readByRun: eventReader.readByRun
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

    expect(eventWriter.append(eventDraft)).toEqual(event);
    expect(decision.kind).toBe("allow");
    expect(toolResult.callId).toBe(toolCall.id);
    expect(eventLog.readByRun(runId)).toEqual([event]);
    expect(response.message.content).toBe("ready");
    expect(response.toolCalls).toEqual([toolCall]);
  });
});
