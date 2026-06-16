// Fake 模型客户端，用固定两步响应模拟 LLM tool call 流程。

import type { ModelClient, ModelResponse } from "../types.js";

// 第一次返回 echo tool call，收到 tool 消息后返回最终答案。
export class FakeModelClient implements ModelClient {
  // 根据当前消息列表决定返回 tool call 还是 final answer。
  async complete(input: Parameters<ModelClient["complete"]>[0]): Promise<ModelResponse> {
    const lastToolMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "tool");

    if (lastToolMessage) {
      return {
        message: {
          role: "assistant",
          content: `Final answer: ${lastToolMessage.content}`
        }
      };
    }

    return {
      message: {
        role: "assistant",
        content: "Calling echo"
      },
      toolCalls: [
        {
          id: "call_echo_01",
          name: "echo",
          args: { text: "hello from fake model" }
        }
      ]
    };
  }
}
