import {
  resolveRuntimeConfig,
  type RuntimeConfig,
  type RuntimeLogLevel
} from "@huaness-lite/core";
import { z } from "zod";

const RUNTIME_LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly RuntimeLogLevel[];

const runtimeConfigEnvSchema = z.object({
  HUANESS_EVENT_LOG_BASE_DIR: z.string().trim().min(1).optional(),
  HUANESS_EVENT_LOG_NEXT_SEQ_CACHE_SIZE: z.coerce.number().int().positive().optional(),
  HUANESS_AGENT_DEFAULT_MAX_STEPS: z.coerce.number().int().positive().optional(),
  HUANESS_LOG_LEVEL: z.enum(RUNTIME_LOG_LEVELS).optional()
});

// 启动时一次性读取环境变量，并映射成 core 可消费的 RuntimeConfig。
export function loadRuntimeConfigFromEnv(input: {
  envFilePath?: string;
} = {}): RuntimeConfig {
  loadEnvFile(input.envFilePath);

  const parsed = runtimeConfigEnvSchema.safeParse({
    HUANESS_EVENT_LOG_BASE_DIR: process.env.HUANESS_EVENT_LOG_BASE_DIR,
    HUANESS_EVENT_LOG_NEXT_SEQ_CACHE_SIZE:
      process.env.HUANESS_EVENT_LOG_NEXT_SEQ_CACHE_SIZE,
    HUANESS_AGENT_DEFAULT_MAX_STEPS:
      process.env.HUANESS_AGENT_DEFAULT_MAX_STEPS,
    HUANESS_LOG_LEVEL: process.env.HUANESS_LOG_LEVEL
  });

  if (!parsed.success) {
    throw new Error(formatEnvValidationError(parsed.error));
  }

  return resolveRuntimeConfig({
    eventLog: {
      baseDir: parsed.data.HUANESS_EVENT_LOG_BASE_DIR,
      nextSeqCacheSize: parsed.data.HUANESS_EVENT_LOG_NEXT_SEQ_CACHE_SIZE
    },
    agent: {
      defaultMaxSteps: parsed.data.HUANESS_AGENT_DEFAULT_MAX_STEPS
    },
    logging: {
      level: parsed.data.HUANESS_LOG_LEVEL
    }
  });
}

// 默认读取 cwd 下的 .env；文件缺失时沿用进程环境和 core 默认值。
function loadEnvFile(envFilePath?: string): void {
  try {
    if (envFilePath === undefined) {
      process.loadEnvFile();
      return;
    }

    process.loadEnvFile(envFilePath);
  } catch (error) {
    if (envFilePath === undefined && isMissingEnvFileError(error)) {
      return;
    }

    throw error;
  }
}

function isMissingEnvFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// 把 Zod 的字段级错误整理成启动期更易读的一行报错。
function formatEnvValidationError(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  return `Invalid runtime environment configuration: ${details}`;
}
