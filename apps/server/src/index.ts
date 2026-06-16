// Server 应用占位入口，后续接 Fastify 时从这里扩展。

// 描述当前 server 还只是占位实现。
export type ServerPlaceholderStatus = {
  name: "huaness-lite-server";
  status: "placeholder";
};

// 暴露一个可导入的占位状态，验证 app 包可编译。
export const serverPlaceholderStatus: ServerPlaceholderStatus = {
  name: "huaness-lite-server",
  status: "placeholder"
};
