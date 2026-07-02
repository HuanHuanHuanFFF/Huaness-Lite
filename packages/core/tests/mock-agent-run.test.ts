// 验证 Milestone 2 的 mock agent run 可以完整跑通。

import { describe, expect, test } from "vitest";

import {
  AgentLoop,
  AllowPolicyEngine,
  FakeModelClient,
  getDefaultRuntimeConfig,
  InMemoryEventLog,
  StaticContextAssembler,
  ToolGateway,
  resolveRuntimeConfig,
  echoTool
} from "../src/index.js";
import type {
  AgentEvent,
  AgentEventDraft,
  ContextAssembler,
  ModelClient,
  ModelMessage,
  ModelResponse,
  PolicyDecision,
  PolicyEngine,
  RuntimeConfigInput,
  Tool,
  ToolCall
} from "../src/index.js";

class ScriptedModelClient implements ModelClient {
  readonly calls: ModelMessage[][] = [];

  constructor(
    private readonly responses: ((
      messages: ModelMessage[]
    ) => ModelResponse | Promise<ModelResponse>)[]
  ) {}

  async complete(
    input: Parameters<ModelClient["complete"]>[0]
  ): Promise<ModelResponse> {
    this.calls.push(input.messages.map((message) => ({ ...message })));
    const response = this.responses.shift();

    if (!response) {
      throw new Error("No scripted model response available");
    }

    return response(input.messages);
  }
}

function createAbortError(message = "The operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class DenyPolicyEngine implements PolicyEngine {
  decide(): PolicyDecision {
    return {
      kind: "deny",
      reason: "mock policy denies this tool"
    };
  }
}

class AbortAfterEventLog extends InMemoryEventLog {
  constructor(
    private readonly abortController: AbortController,
    private readonly eventType: string
  ) {
    super();
  }

  override append(event: AgentEventDraft): AgentEvent {
    const completed = super.append(event);

    if (completed.type === this.eventType) {
      this.abortController.abort();
    }

    return completed;
  }
}

function createLoop(input: {
  eventLog: InMemoryEventLog;
  modelClient: ModelClient;
  policyEngine?: PolicyEngine;
  tools?: Tool[];
  contextAssembler?: ContextAssembler;
  runtimeConfig?: RuntimeConfigInput;
}): AgentLoop {
  const toolGateway = new ToolGateway({
    eventWriter: input.eventLog,
    policyEngine: input.policyEngine ?? new AllowPolicyEngine(),
    tools: input.tools ?? [echoTool]
  });

  return new AgentLoop({
    eventWriter: input.eventLog,
    modelClient: input.modelClient,
    toolGateway,
    contextAssembler: input.contextAssembler,
    runtimeConfig: input.runtimeConfig
  });
}

describe("mock agent run", () => {
  // 覆盖 fake model、policy、tool gateway、event writer 的 happy path。
  test("runs a fake model through policy, echo tool, events, and final answer", async () => {
    const eventLog = new InMemoryEventLog();
    const toolGateway = new ToolGateway({
      eventWriter: eventLog,
      policyEngine: new AllowPolicyEngine(),
      tools: [echoTool]
    });
    const loop = new AgentLoop({
      eventWriter: eventLog,
      modelClient: new FakeModelClient(),
      toolGateway
    });

    const result = await loop.run({
      runId: "run_mock_01",
      sessionId: "session_mock_01",
      userMessage: "Echo the fake input"
    });

    const runEvents = eventLog.readRunEvents("run_mock_01");

    expect(result.finalAnswer).toBe("Final answer: hello from fake model");
    expect(result.toolResults).toEqual([
      {
        callId: "call_echo_01",
        toolName: "echo",
        output: "hello from fake model"
      }
    ]);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "observation.appended",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "observation.appended",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(runEvents.map((event) => event.seq)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11
    ]);
    expect(runEvents[2]).toMatchObject({ step: 0 });
    expect(runEvents[3]).toMatchObject({ step: 0 });
    expect(runEvents[4]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01"
    });
    expect(runEvents[5]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01"
    });
    expect(runEvents[6]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01"
    });
    expect(runEvents[6]?.id).toEqual(expect.any(String));
    expect(runEvents[7]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01",
      parentEventId: runEvents[6]?.id
    });
    expect(runEvents[8]).toMatchObject({ step: 1 });
    expect(runEvents[9]).toMatchObject({ step: 1 });
    expect(eventLog.events[1]?.data).toEqual({
      messages: [
        {
          role: "user",
          content: "Echo the fake input"
        }
      ],
      messageCount: 1
    });
    expect(eventLog.events[7]?.data).toEqual({
      toolCallId: "call_echo_01",
      toolName: "echo",
      message: {
        role: "tool",
        content: "hello from fake model",
        toolCallId: "call_echo_01",
        toolName: "echo",
        isError: undefined
      }
    });
  });

  test("emits run.cancelled when the model aborts through AbortSignal", async () => {
    const eventLog = new InMemoryEventLog();
    const abortController = new AbortController();
    const modelClient = new ScriptedModelClient([
      () => {
        abortController.abort();
        throw createAbortError();
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient
    });

    await expect(
      loop.run({
        runId: "run_model_abort_01",
        sessionId: "session_model_abort_01",
        userMessage: "Abort during model call",
        signal: abortController.signal
      })
    ).rejects.toThrow("Agent run cancelled");

    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "run.cancelled"
    ]);
  });

  test("cancels after model return before entering tool execution", async () => {
    const eventLog = new InMemoryEventLog();
    const abortController = new AbortController();
    let toolExecuted = false;
    const modelClient = new ScriptedModelClient([
      () => {
        abortController.abort();

        return {
          message: {
            role: "assistant",
            content: "Calling echo after abort"
          },
          toolCalls: [
            {
              id: "call_abort_before_tool_01",
              name: "echo",
              args: { text: "should not execute" }
            }
          ]
        };
      }
    ]);
    const guardedTool: Tool = {
      name: "echo",
      execute(toolCall) {
        toolExecuted = true;
        return {
          callId: toolCall.id,
          toolName: toolCall.name,
          output: "unexpected"
        };
      }
    };
    const loop = createLoop({
      eventLog,
      modelClient,
      tools: [guardedTool]
    });

    await expect(
      loop.run({
        runId: "run_abort_before_tool_01",
        sessionId: "session_abort_before_tool_01",
        userMessage: "Abort before tool",
        signal: abortController.signal
      })
    ).rejects.toThrow("Agent run cancelled");

    expect(toolExecuted).toBe(false);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "run.cancelled"
    ]);
  });

  test("cancels after policy aborts without executing the tool", async () => {
    const eventLog = new InMemoryEventLog();
    const abortController = new AbortController();
    let toolExecuted = false;
    const policyEngine: PolicyEngine = {
      decide(): PolicyDecision {
        abortController.abort();
        return {
          kind: "allow",
          reason: "aborted after policy"
        };
      }
    };
    const guardedTool: Tool = {
      name: "echo",
      execute(toolCall) {
        toolExecuted = true;
        return {
          callId: toolCall.id,
          toolName: toolCall.name,
          output: "unexpected"
        };
      }
    };
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling echo"
        },
        toolCalls: [
          {
            id: "call_policy_abort_01",
            name: "echo",
            args: { text: "should not execute" }
          }
        ]
      })
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      policyEngine,
      tools: [guardedTool]
    });

    await expect(
      loop.run({
        runId: "run_policy_abort_01",
        sessionId: "session_policy_abort_01",
        userMessage: "Abort after policy",
        signal: abortController.signal
      })
    ).rejects.toThrow("Agent run cancelled");

    expect(toolExecuted).toBe(false);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "run.cancelled"
    ]);
  });

  test("cancels when signal aborts while awaiting tool execution", async () => {
    const eventLog = new InMemoryEventLog();
    const abortController = new AbortController();
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling slow tool"
        },
        toolCalls: [
          {
            id: "call_slow_abort_01",
            name: "slow",
            args: {}
          }
        ]
      }),
      () => {
        throw new Error("model should not receive a cancelled tool result");
      }
    ]);
    const slowTool: Tool = {
      name: "slow",
      async execute(toolCall) {
        await Promise.resolve();
        abortController.abort();

        return {
          callId: toolCall.id,
          toolName: toolCall.name,
          output: "late success"
        };
      }
    };
    const loop = createLoop({
      eventLog,
      modelClient,
      tools: [slowTool]
    });

    await expect(
      loop.run({
        runId: "run_tool_await_abort_01",
        sessionId: "session_tool_await_abort_01",
        userMessage: "Abort while awaiting tool",
        signal: abortController.signal
      })
    ).rejects.toThrow("Agent run cancelled");

    expect(modelClient.calls).toHaveLength(1);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "run.cancelled"
    ]);
  });

  test("records observation before cancelling after a terminal tool event", async () => {
    const abortController = new AbortController();
    const eventLog = new AbortAfterEventLog(abortController, "tool.completed");
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling echo"
        },
        toolCalls: [
          {
            id: "call_abort_after_tool_completed_01",
            name: "echo",
            args: { text: "late cancellation" }
          }
        ]
      }),
      () => {
        throw new Error("model should not receive a cancelled observation");
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient
    });

    await expect(
      loop.run({
        runId: "run_abort_after_tool_completed_01",
        sessionId: "session_abort_after_tool_completed_01",
        userMessage: "Abort after tool completed",
        signal: abortController.signal
      })
    ).rejects.toThrow("Agent run cancelled");

    expect(modelClient.calls).toHaveLength(1);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "observation.appended",
      "run.cancelled"
    ]);
    expect(eventLog.events[7]?.data).toMatchObject({
      toolCallId: "call_abort_after_tool_completed_01",
      toolName: "echo",
      message: {
        role: "tool",
        content: "late cancellation",
        toolCallId: "call_abort_after_tool_completed_01",
        toolName: "echo"
      }
    });
    expect(eventLog.events[7]).toMatchObject({
      step: 0,
      toolCallId: "call_abort_after_tool_completed_01",
      parentEventId: eventLog.events[6]?.id
    });
  });

  test("uses the original tool call id and name when a tool returns mismatched identity", async () => {
    const eventLog = new InMemoryEventLog();
    const mismatchedTool: Tool = {
      name: "identity",
      execute() {
        return {
          callId: "wrong_call_id",
          toolName: "wrong_tool_name",
          output: "identity result"
        };
      }
    };
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling identity"
        },
        toolCalls: [
          {
            id: "call_identity_01",
            name: "identity",
            args: {}
          }
        ]
      }),
      (messages) => {
        expect(messages.at(-1)).toMatchObject({
          role: "tool",
          toolCallId: "call_identity_01",
          toolName: "identity"
        });

        return {
          message: {
            role: "assistant",
            content: "Recovered with stable identity"
          }
        };
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      tools: [mismatchedTool]
    });

    const result = await loop.run({
      runId: "run_identity_01",
      sessionId: "session_identity_01",
      userMessage: "Call identity"
    });

    expect(result.finalAnswer).toBe("Recovered with stable identity");
    expect(result.toolResults).toEqual([
      {
        callId: "call_identity_01",
        toolName: "identity",
        output: "identity result"
      }
    ]);
  });

  test("does not mutate messages returned by a reusable ContextAssembler", async () => {
    const eventLog = new InMemoryEventLog();
    const cachedMessages: ModelMessage[] = [
      {
        role: "user",
        content: "cached context"
      }
    ];
    const contextAssembler: ContextAssembler = {
      assemble: () => cachedMessages
    };
    const modelClient = new ScriptedModelClient([
      (messages) => {
        expect(messages).toEqual([
          {
            role: "user",
            content: "cached context"
          }
        ]);

        return {
          message: {
            role: "assistant",
            content: "first run"
          }
        };
      },
      (messages) => {
        expect(messages).toEqual([
          {
            role: "user",
            content: "cached context"
          }
        ]);

        return {
          message: {
            role: "assistant",
            content: "second run"
          }
        };
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      contextAssembler
    });

    await loop.run({
      runId: "run_cached_context_01",
      sessionId: "session_cached_context_01",
      userMessage: "First run"
    });
    await loop.run({
      runId: "run_cached_context_02",
      sessionId: "session_cached_context_02",
      userMessage: "Second run"
    });

    expect(cachedMessages).toEqual([
      {
        role: "user",
        content: "cached context"
      }
    ]);
  });

  test("uses ContextAssembler to provide system, context, and user messages to the model", async () => {
    const eventLog = new InMemoryEventLog();
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "assembled"
        }
      })
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      contextAssembler: new StaticContextAssembler({
        systemMessages: ["You are Huaness Lite core."],
        contextMessages: ["Repo context: packages/core only."]
      })
    });

    const result = await loop.run({
      runId: "run_context_01",
      sessionId: "session_context_01",
      userMessage: "Assemble this"
    });

    expect(result.finalAnswer).toBe("assembled");
    expect(modelClient.calls[0]).toEqual([
      {
        role: "system",
        content: "You are Huaness Lite core."
      },
      {
        role: "user",
        content: "Repo context: packages/core only."
      },
      {
        role: "user",
        content: "Assemble this"
      }
    ]);
  });

  test("returns unknown tool failures as model-visible tool observations", async () => {
    const eventLog = new InMemoryEventLog();
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling missing tool"
        },
        toolCalls: [
          {
            id: "call_missing_01",
            name: "missing",
            args: {}
          }
        ]
      }),
      (messages) => {
        const toolMessage = messages.at(-1);

        expect(toolMessage).toMatchObject({
          role: "tool",
          toolCallId: "call_missing_01",
          toolName: "missing",
          isError: true
        });
        expect(toolMessage?.content).toContain("Unknown tool: missing");

        return {
          message: {
            role: "assistant",
            content: "Recovered from missing tool"
          }
        };
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      tools: []
    });

    const result = await loop.run({
      runId: "run_unknown_tool_01",
      sessionId: "session_unknown_tool_01",
      userMessage: "Call a missing tool"
    });

    expect(result.finalAnswer).toBe("Recovered from missing tool");
    expect(result.toolResults).toEqual([
      {
        callId: "call_missing_01",
        toolName: "missing",
        output: "Unknown tool: missing",
        isError: true
      }
    ]);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.failed",
      "observation.appended",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(eventLog.events[7]?.data).toEqual({
      toolCallId: "call_missing_01",
      toolName: "missing",
      message: {
        role: "tool",
        content: "Unknown tool: missing",
        toolCallId: "call_missing_01",
        toolName: "missing",
        isError: true
      }
    });
    expect(eventLog.events[7]).toMatchObject({
      step: 0,
      toolCallId: "call_missing_01",
      parentEventId: eventLog.events[6]?.id
    });
    expect(modelClient.calls).toHaveLength(2);
  });

  test("returns policy denial as a model-visible tool observation", async () => {
    const eventLog = new InMemoryEventLog();
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling denied tool"
        },
        toolCalls: [
          {
            id: "call_denied_01",
            name: "echo",
            args: { text: "blocked" }
          }
        ]
      }),
      (messages) => {
        const toolMessage = messages.at(-1);

        expect(toolMessage).toMatchObject({
          role: "tool",
          toolCallId: "call_denied_01",
          toolName: "echo",
          isError: true
        });
        expect(toolMessage?.content).toContain(
          "Tool call blocked by policy: mock policy denies this tool"
        );

        return {
          message: {
            role: "assistant",
            content: "Recovered from denied tool"
          }
        };
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      policyEngine: new DenyPolicyEngine()
    });

    const result = await loop.run({
      runId: "run_policy_denied_01",
      sessionId: "session_policy_denied_01",
      userMessage: "Call a denied tool"
    });

    expect(result.finalAnswer).toBe("Recovered from denied tool");
    expect(result.toolResults).toEqual([
      {
        callId: "call_denied_01",
        toolName: "echo",
        output: "Tool call blocked by policy: mock policy denies this tool",
        isError: true
      }
    ]);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.blocked",
      "observation.appended",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(eventLog.events[7]?.data).toEqual({
      toolCallId: "call_denied_01",
      toolName: "echo",
      message: {
        role: "tool",
        content: "Tool call blocked by policy: mock policy denies this tool",
        toolCallId: "call_denied_01",
        toolName: "echo",
        isError: true
      }
    });
    expect(eventLog.events[7]).toMatchObject({
      step: 0,
      toolCallId: "call_denied_01",
      parentEventId: eventLog.events[6]?.id
    });
    expect(modelClient.calls).toHaveLength(2);
  });

  test("returns tool execution errors as model-visible tool observations", async () => {
    const eventLog = new InMemoryEventLog();
    const throwingTool: Tool = {
      name: "explode",
      execute() {
        throw new Error("boom");
      }
    };
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling throwing tool"
        },
        toolCalls: [
          {
            id: "call_explode_01",
            name: "explode",
            args: {}
          }
        ]
      }),
      (messages) => {
        const toolMessage = messages.at(-1);

        expect(toolMessage).toMatchObject({
          role: "tool",
          toolCallId: "call_explode_01",
          toolName: "explode",
          isError: true
        });
        expect(toolMessage?.content).toContain(
          "Tool execution failed: boom"
        );

        return {
          message: {
            role: "assistant",
            content: "Recovered from throwing tool"
          }
        };
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      tools: [throwingTool]
    });

    const result = await loop.run({
      runId: "run_tool_throw_01",
      sessionId: "session_tool_throw_01",
      userMessage: "Call a throwing tool"
    });

    expect(result.finalAnswer).toBe("Recovered from throwing tool");
    expect(result.toolResults).toEqual([
      {
        callId: "call_explode_01",
        toolName: "explode",
        output: "Tool execution failed: boom",
        isError: true
      }
    ]);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.failed",
      "observation.appended",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(eventLog.events[7]?.data).toEqual({
      toolCallId: "call_explode_01",
      toolName: "explode",
      message: {
        role: "tool",
        content: "Tool execution failed: boom",
        toolCallId: "call_explode_01",
        toolName: "explode",
        isError: true
      }
    });
    expect(eventLog.events[7]).toMatchObject({
      step: 0,
      toolCallId: "call_explode_01",
      parentEventId: eventLog.events[6]?.id
    });
    expect(modelClient.calls).toHaveLength(2);
  });

  test("emits a distinct event when maxSteps is exceeded", async () => {
    const eventLog = new InMemoryEventLog();
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling echo forever"
        },
        toolCalls: [
          {
            id: "call_echo_loop_01",
            name: "echo",
            args: { text: "again" }
          }
        ]
      })
    ]);
    const loop = createLoop({
      eventLog,
      modelClient
    });

    await expect(
      loop.run({
        runId: "run_max_steps_01",
        sessionId: "session_max_steps_01",
        userMessage: "Loop once",
        maxSteps: 1
      })
    ).rejects.toThrow("AgentLoop exceeded maxSteps: 1");

    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "observation.appended",
      "run.max_steps_exceeded",
      "run.failed"
    ]);
  });

  test("uses runtimeConfig.agent.defaultMaxSteps when run input omits maxSteps", async () => {
    const defaults = getDefaultRuntimeConfig();
    const eventLog = new InMemoryEventLog();
    const modelClient = new ScriptedModelClient([
      () => ({
        message: {
          role: "assistant",
          content: "Calling echo forever"
        },
        toolCalls: [
          {
            id: "call_default_max_steps_01",
            name: "echo",
            args: { text: "again" }
          }
        ]
      })
    ]);
    const loop = createLoop({
      eventLog,
      modelClient,
      runtimeConfig: resolveRuntimeConfig({
        agent: {
          defaultMaxSteps: 1
        }
      })
    });

    await expect(
      loop.run({
        runId: "run_default_max_steps_01",
        sessionId: "session_default_max_steps_01",
        userMessage: "Loop once via runtime config"
      })
    ).rejects.toThrow("AgentLoop exceeded maxSteps: 1");

    expect(defaults.agent.defaultMaxSteps).toBeGreaterThan(1);
  });

  test("emits run.cancelled when AbortSignal is cancelled before model call", async () => {
    const eventLog = new InMemoryEventLog();
    const modelClient = new ScriptedModelClient([
      () => {
        throw new Error("model should not be called after cancellation");
      }
    ]);
    const loop = createLoop({
      eventLog,
      modelClient
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      loop.run({
        runId: "run_cancelled_01",
        sessionId: "session_cancelled_01",
        userMessage: "Do not call model",
        signal: abortController.signal
      })
    ).rejects.toThrow("Agent run cancelled");

    expect(modelClient.calls).toHaveLength(0);
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "run.cancelled"
    ]);
  });
});
