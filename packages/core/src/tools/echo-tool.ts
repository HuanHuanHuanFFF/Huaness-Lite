// echo fake tool，用于 mock run 阶段返回可断言的工具结果。

import type { Tool } from "../types.js";

// 把 tool call 参数中的 text 原样返回。
export const echoTool: Tool = {
  name: "echo",
  // 执行 echo 调用，优先返回 args.text。
  execute(toolCall) {
    return {
      callId: toolCall.id,
      output:
        typeof toolCall.args.text === "string"
          ? toolCall.args.text
          : JSON.stringify(toolCall.args)
    };
  }
};
