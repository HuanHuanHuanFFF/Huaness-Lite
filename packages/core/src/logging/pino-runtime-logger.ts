// Pino 适配层负责把 core 的最小日志接口映射到结构化 stdout 日志。
import pino from "pino";
import type { Logger as PinoLogger, LoggerOptions } from "pino";

import {resolveRuntimeConfig} from "../runtime/runtime-config.js";
import type {
  PinoRuntimeLoggerInput,
  PinoRuntimeLoggerOptions,
  RuntimeLogFields,
  RuntimeLogger
} from "./types.js";

const DEFAULT_REDACT_PATHS = [
  "authorization",
  "headers.authorization",
  "apiKey",
  "token",
  "password",
  "*.authorization",
  "*.apiKey",
  "*.token",
  "*.password"
] as const;

class PinoRuntimeLogger implements RuntimeLogger {
  constructor(private readonly logger: PinoLogger) {}

  debug(message: string, fields?: RuntimeLogFields): void {
    writeLog(this.logger, "debug", message, fields);
  }

  info(message: string, fields?: RuntimeLogFields): void {
    writeLog(this.logger, "info", message, fields);
  }

  warn(message: string, fields?: RuntimeLogFields): void {
    writeLog(this.logger, "warn", message, fields);
  }

  error(message: string, fields?: RuntimeLogFields): void {
    writeLog(this.logger, "error", message, fields);
  }

  child(bindings: RuntimeLogFields): RuntimeLogger {
    return new PinoRuntimeLogger(this.logger.child(bindings));
  }
}

// createPinoRuntimeLogger 创建默认输出到 stdout 的 Pino runtime logger。
export function createPinoRuntimeLogger(
  options: PinoRuntimeLoggerInput = {},
  destination?: NodeJS.WritableStream
): RuntimeLogger {
  const pinoOptions = toPinoOptions(options);

  const logger =
    destination === undefined ? pino(pinoOptions) : pino(pinoOptions, destination);

  return new PinoRuntimeLogger(logger);
}

// 把 core 的公开配置收敛成 Pino 实际使用的配置对象。
function toPinoOptions(options: PinoRuntimeLoggerInput): LoggerOptions {
  const pinoOptions: LoggerOptions = {};
  const loggingConfig = resolveRuntimeConfig(options.runtimeConfig).logging;

  pinoOptions.level = options.level ?? loggingConfig.level;

  if (options.base !== undefined) {
    pinoOptions.base = options.base;
  }

  pinoOptions.redact = mergeRedactPaths(options.redact);

  return pinoOptions;
}

// 在默认敏感字段之外，追加调用方声明的脱敏路径。
function mergeRedactPaths(customPaths: readonly string[] | undefined): string[] {
  return [...new Set([...DEFAULT_REDACT_PATHS, ...(customPaths ?? [])])];
}

// 统一把 message 和结构化字段映射到对应的 Pino level 方法。
function writeLog(
  logger: PinoLogger,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: RuntimeLogFields
): void {
  if (fields === undefined) {
    logger[level](message);
  } else {
    logger[level](fields, message);
  }
}
