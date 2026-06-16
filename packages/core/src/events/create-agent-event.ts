// 创建标准 AgentEvent，统一补齐 schema 版本和时间戳。

import { CORE_SCHEMA_VERSION } from "../types.js";
import type { AgentEvent } from "../types.js";

// 根据调用方提供的事件内容生成完整事件。
export function createAgentEvent(
  input: Omit<AgentEvent, "schemaVersion" | "timestamp">
): AgentEvent {
  return {
    ...input,
    schemaVersion: CORE_SCHEMA_VERSION,
    timestamp: new Date().toISOString()
  };
}
