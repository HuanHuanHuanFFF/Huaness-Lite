// EventLog 读写接口，描述事件日志的最小边界。
import type {RunId} from "../shared/ids.js";
import type {AgentEvent, AgentEventDraft} from "./types.js";

// 事件写入接口，接收 draft 并返回补齐后的完整事件。
export type EventWriter = {
    append(event: AgentEventDraft): Promise<AgentEvent> | AgentEvent;
};

// 事件读取接口，按 runId 取回事件序列。
export type EventReader = {
    readRunEvents(runId: RunId): Promise<AgentEvent[]> | AgentEvent[];
};

// 完整事件日志接口，同时支持写入和读取。
export type EventLog = EventWriter & EventReader;
