import {completeAgentEvent} from "./create-agent-event.js";
import type {
    AgentEvent,
    AgentEventDraft,
} from "./types.js";
import type {EventLog} from "./event-log.js";
import type {
    RunId
} from "../shared/ids.js";

// 内存事件日志，用于 mock run 阶段验证事件写入和读取顺序。
export class InMemoryEventLog implements EventLog {
    // 把完整事件保存在数组中，方便测试直接断言。
    readonly events: AgentEvent[] = [];

    private readonly nextSeqByRun = new Map<RunId, number>();

    // 补齐 draft 并记录到内存数组。
    append(event: AgentEventDraft): AgentEvent {
        const seq = this.nextSeq(event.runId);
        const completed = completeAgentEvent(event, seq);

        this.events.push(completed);
        this.nextSeqByRun.set(event.runId, seq + 1);

        return completed;
    }

    // 按 runId 读取事件，保留原始写入顺序。
    readRunEvents(runId: RunId): AgentEvent[] {
        return this.events.filter((event) => event.runId === runId);
    }

    // 每个 run 独立从 1 开始递增。
    private nextSeq(runId: RunId): number {
        return this.nextSeqByRun.get(runId) ?? 1;
    }
}
