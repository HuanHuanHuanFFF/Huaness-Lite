// 最小 AgentLoop，跑通 fake model 到工具调用再到最终回答的链路。

import { createAgentEvent } from "../events/create-agent-event.js";
import type {
  AgentRunInput,
  AgentRunResult,
  EventSink,
  ModelClient,
  ModelMessage,
  ToolResult
} from "../types.js";
import type { ToolGateway } from "../tools/tool-gateway.js";

export class AgentLoop {
  private readonly eventSink: EventSink;
  private readonly modelClient: ModelClient;
  private readonly toolGateway: ToolGateway;

  // 注入模型、工具网关和事件接收器，保持 loop 不直接依赖具体实现。
  constructor(input: {
    eventSink: EventSink;
    modelClient: ModelClient;
    toolGateway: ToolGateway;
  }) {
    this.eventSink = input.eventSink;
    this.modelClient = input.modelClient;
    this.toolGateway = input.toolGateway;
  }

  // 执行一次最小 agent run，直到模型给出最终回答或超过步数。
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const messages: ModelMessage[] = [
      { role: "user", content: input.userMessage }
    ];
    const toolResults: ToolResult[] = [];

    await this.emit(input, "run.created", {
      userMessage: input.userMessage
    });

    try {
      for (let step = 0; step < 4; step += 1) {
        await this.emit(input, "model.requested", { step });

        const response = await this.modelClient.complete({
          runId: input.runId,
          sessionId: input.sessionId,
          messages
        });

        await this.emit(input, "model.responded", {
          content: response.message.content,
          toolCalls: response.toolCalls ?? []
        });

        messages.push(response.message);

        if (response.toolCalls && response.toolCalls.length > 0) {
          for (const toolCall of response.toolCalls) {
            const result = await this.toolGateway.execute({
              runId: input.runId,
              sessionId: input.sessionId,
              toolCall
            });
            toolResults.push(result);
            messages.push({ role: "tool", content: result.output });
          }
          continue;
        }

        await this.emit(input, "run.completed", {
          finalAnswer: response.message.content
        });

        return {
          finalAnswer: response.message.content,
          toolResults
        };
      }

      throw new Error("AgentLoop exceeded max mock steps");
    } catch (error) {
      await this.emit(input, "run.failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  // 把 loop 内部动作转换成标准事件。
  private async emit(
    input: AgentRunInput,
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
