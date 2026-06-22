// 默认上下文组装器，用静态 system/context 消息加当前用户输入生成模型消息。
import type { AgentRunInput } from "../loop/types.js";
import type { ModelMessage } from "../model/types.js";
import type { ContextAssembler } from "./types.js";

// 供测试和 P0 默认路径使用的最小 ContextAssembler 实现。
export class StaticContextAssembler implements ContextAssembler {
  private readonly systemMessages: string[];
  private readonly contextMessages: string[];

  constructor(input: {
    systemMessages?: string[];
    contextMessages?: string[];
  } = {}) {
    this.systemMessages = input.systemMessages ?? [];
    this.contextMessages = input.contextMessages ?? [];
  }

  // 按 system、context、user 的顺序生成初始消息列表。
  assemble(input: AgentRunInput): ModelMessage[] {
    return [
      ...this.systemMessages.map((content) => ({
        role: "system" as const,
        content
      })),
      ...this.contextMessages.map((content) => ({
        role: "user" as const,
        content
      })),
      {
        role: "user",
        content: input.userMessage
      }
    ];
  }
}
