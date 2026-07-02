import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // clean 后 core/dist 不存在时，测试直接解析到 workspace 源码入口。
      "@huaness-lite/core": path.resolve(
        rootDir,
        "../../packages/core/src/index.ts"
      )
    }
  }
});
