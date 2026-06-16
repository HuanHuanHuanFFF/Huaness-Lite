// 内存事件接收器，用于 mock run 阶段验证事件顺序。

import type { AgentEvent, EventSink } from "../types.js";

// 把事件保存在数组中，方便测试直接断言。
export class InMemoryEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  // 记录一个事件到内存数组。
  append(event: AgentEvent): void {
    this.events.push(event);
  }
}
