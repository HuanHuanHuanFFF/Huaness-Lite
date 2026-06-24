// 最小 AgentLoop，跑通 fake model 到工具调用再到最终回答的链路。

import {StaticContextAssembler} from "../context/static-context-assembler.js";
import type {
    AgentEvent,
    AgentEventDataByType,
    AgentEventDraft,
    AgentEventType
} from "../events/types.js";
import type {EventWriter} from "../events/event-log.js";
import type {ContextAssembler} from "../context/types.js";
import type {
    ModelClient,
    ModelMessage
} from "../model/types.js";
import type {ToolResult} from "../tools/types.js";
import type {ToolGateway} from "../tools/tool-gateway.js";
import type {AgentRunInput, AgentRunResult} from "./types.js";

const DEFAULT_MAX_STEPS = 8;

export class MaxStepsExceededError extends Error {
    constructor(maxSteps: number) {
        super(`AgentLoop exceeded maxSteps: ${maxSteps}`);
        this.name = "MaxStepsExceededError";
    }
}

export class AgentRunCancelledError extends Error {
    constructor() {
        super("Agent run cancelled");
        this.name = "AgentRunCancelledError";
    }
}

export class AgentLoop {
    private readonly eventWriter: EventWriter;
    private readonly modelClient: ModelClient;
    private readonly toolGateway: ToolGateway;
    private readonly contextAssembler: ContextAssembler;
    private readonly defaultMaxSteps: number;

    // 注入模型、工具网关和事件写入端，保持 loop 不直接依赖具体实现。
    constructor(input: {
        eventWriter: EventWriter;
        modelClient: ModelClient;
        toolGateway: ToolGateway;
        contextAssembler?: ContextAssembler;
        defaultMaxSteps?: number;
    }) {
        this.eventWriter = input.eventWriter;
        this.modelClient = input.modelClient;
        this.toolGateway = input.toolGateway;
        this.contextAssembler =
            input.contextAssembler ?? new StaticContextAssembler();
        this.defaultMaxSteps = input.defaultMaxSteps ?? DEFAULT_MAX_STEPS;
    }

    // 执行一次最小 agent run，直到模型给出最终回答或超过步数。
    async run(input: AgentRunInput): Promise<AgentRunResult> {
        await this.emit(input, "run.created", {
            userMessage: input.userMessage
        });

        try {
            const messages = (await this.contextAssembler.assemble(input)).map(
                (message) => ({...message})
            );
            await this.emit(input, "context.built", {
                messages: messages.map((message) => ({...message})),
                messageCount: messages.length
            });

            const toolResults: ToolResult[] = [];
            const maxSteps = input.maxSteps ?? this.defaultMaxSteps;

            for (let step = 0; step < maxSteps; step += 1) {
                this.throwIfAborted(input.signal);

                await this.emit(input, "model.requested", {step}, {step});

                const response = await this.modelClient.complete({
                    runId: input.runId,
                    sessionId: input.sessionId,
                    messages,
                    signal: input.signal
                });

                this.throwIfAborted(input.signal);

                await this.emit(
                    input,
                    "model.responded",
                    {
                        content: response.message.content,
                        toolCalls: response.toolCalls ?? []
                    },
                    {step}
                );

                messages.push(response.message);

                if (response.toolCalls && response.toolCalls.length > 0) {
                    for (const toolCall of response.toolCalls) {
                        this.throwIfAborted(input.signal);

                        const execution = await this.toolGateway.execute({
                            runId: input.runId,
                            sessionId: input.sessionId,
                            step,
                            toolCall,
                            signal: input.signal
                        });

                        const result = execution.result;
                        toolResults.push(result);
                        const toolMessage = this.createToolMessage(result);
                        messages.push(toolMessage);
                        await this.emit(
                            input,
                            "observation.appended",
                            {
                                toolCallId: result.callId,
                                toolName: result.toolName,
                                message: {...toolMessage}
                            },
                            {
                                step,
                                toolCallId: result.callId,
                                parentEventId: execution.terminalEvent.id
                            }
                        );
                        this.throwIfAborted(input.signal);
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

            await this.emit(input, "run.max_steps_exceeded", {
                maxSteps
            });

            throw new MaxStepsExceededError(maxSteps);
        } catch (error) {
            if (this.isCancellation(input, error)) {
                const cancelledError =
                    error instanceof AgentRunCancelledError
                        ? error
                        : new AgentRunCancelledError();

                await this.emit(input, "run.cancelled", {
                    reason: cancelledError.message
                });
                throw cancelledError;
            }

            await this.emit(input, "run.failed", {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    // 把 loop 内部动作转换成事件 draft，完整 envelope 由 EventLog 补齐。
    private async emit<Type extends AgentEventType>(
        input: AgentRunInput,
        type: Type,
        data: AgentEventDataByType[Type],
        correlation: Pick<
            AgentEventDraft,
            "step" | "toolCallId" | "parentEventId"
        > = {}
    ): Promise<AgentEvent> {
        return this.eventWriter.append({
            type,
            runId: input.runId,
            sessionId: input.sessionId,
            source: "agent_loop",
            ...correlation,
            data
        } as AgentEventDraft);
    }

    private createToolMessage(result: ToolResult): ModelMessage {
        return {
            role: "tool",
            content: result.output,
            toolCallId: result.callId,
            toolName: result.toolName,
            isError: result.isError
        };
    }

    private throwIfAborted(signal?: AbortSignal): void {
        if (signal?.aborted) {
            throw new AgentRunCancelledError();
        }
    }

    private isCancellation(input: AgentRunInput, error: unknown): boolean {
        return (
            error instanceof AgentRunCancelledError ||
            input.signal?.aborted === true ||
            (error instanceof Error && error.name === "AbortError")
        );
    }
}
