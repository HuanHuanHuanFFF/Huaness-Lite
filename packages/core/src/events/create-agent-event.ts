import { randomUUID } from "node:crypto";

import { CORE_SCHEMA_VERSION } from "./types.js";
import type { AgentEvent, AgentEventDraft } from "./types.js";

// 根据 EventLog 分配的 seq，把 draft 补齐成完整 AgentEvent。
export function completeAgentEvent(
  draft: AgentEventDraft,
  seq: number
): AgentEvent {
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    id: randomUUID(),
    seq,
    timestamp: new Date().toISOString(),
    type: draft.type,
    runId: draft.runId,
    sessionId: draft.sessionId,
    source: draft.source,
    ...(draft.step === undefined ? {} : { step: draft.step }),
    ...(draft.toolCallId === undefined ? {} : { toolCallId: draft.toolCallId }),
    ...(draft.parentEventId === undefined
      ? {} : { parentEventId: draft.parentEventId }),
    data: draft.data
  } as AgentEvent;
}
