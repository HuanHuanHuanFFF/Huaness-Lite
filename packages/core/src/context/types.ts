// 上下文组装层使用的接口类型。

import type { AgentRunInput } from "../loop/types.js";
import type { ModelMessage } from "../model/types.js";

// 上下文组装接口，负责生成模型初始消息。
export type ContextAssembler = {
  assemble(input: AgentRunInput): Promise<ModelMessage[]> | ModelMessage[];
};
