// Agent 事件 schema 使用的核心类型。
import type {ModelMessage} from "../model/types.js";
import type {PolicyDecision} from "../policy/types.js";
import type {RunId, SessionId} from "../shared/ids.js";
import type {ToolCall, ToolResult} from "../tools/types.js";

// 当前 core 事件 schema 版本。
export const CORE_SCHEMA_VERSION = "1.0" as const;

// 事件 schema 版本类型。
export type CoreSchemaVersion = typeof CORE_SCHEMA_VERSION;

// 当前 core 已知的 agent 事件类型。
export const AGENT_EVENT_TYPES = [
    "run.created",
    "context.built",
    "model.requested",
    "model.responded",
    "tool.requested",
    "policy.decided",
    "tool.completed",
    "tool.failed",
    "tool.blocked",
    "observation.appended",
    "run.completed",
    "run.max_steps_exceeded",
    "run.failed",
    "run.cancelled"
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// 事件来源，表示哪个运行组件发出了事件。
export const AGENT_EVENT_SOURCES = [
    "agent_loop",
    "tool_gateway"
] as const;

export type AgentEventSource = (typeof AGENT_EVENT_SOURCES)[number];

// 各事件类型对应的业务 payload。
export type AgentEventDataByType = {
    "run.created": {
        userMessage: string;
    };
    "context.built": {
        messages: ModelMessage[];
        messageCount: number;
    };
    "model.requested": {
        step: number;
    };
    "model.responded": {
        content: string;
        toolCalls: ToolCall[];
    };
    "tool.requested": {
        toolCall: ToolCall;
    };
    "policy.decided": {
        decision: PolicyDecision;
        toolCall: ToolCall;
    };
    "tool.completed": {
        result: ToolResult;
        toolCall: ToolCall;
    };
    "tool.failed": {
        result: ToolResult;
        toolCall: ToolCall;
    };
    "tool.blocked": {
        result: ToolResult;
        toolCall: ToolCall;
    };
    "observation.appended": {
        toolCallId: string;
        toolName: string;
        message: ModelMessage;
    };
    "run.completed": {
        finalAnswer: string;
    };
    "run.max_steps_exceeded": {
        maxSteps: number;
    };
    "run.failed": {
        error: string;
    };
    "run.cancelled": {
        reason: string;
    };
};

// 调用方写入事件时只提供业务字段，完整 envelope 由 EventLog 补齐。
export type AgentEventDraftOf<Type extends AgentEventType> = {
    type: Type;
    runId: RunId;
    sessionId: SessionId;
    source: AgentEventSource;
    step?: number;
    toolCallId?: string;
    parentEventId?: string;
    data: AgentEventDataByType[Type];
};

export type AgentEventDraft = {
    [Type in AgentEventType]: AgentEventDraftOf<Type>;
}[AgentEventType];

// 已补齐 schema、id、seq 和 timestamp 的完整事件。
export type AgentEventOf<Type extends AgentEventType> =
    AgentEventDraftOf<Type> & {
    schemaVersion: CoreSchemaVersion;
    id: string;
    seq: number;
    timestamp: string;
};

export type AgentEvent = {
    [Type in AgentEventType]: AgentEventOf<Type>;
}[AgentEventType];
