// Runtime logging 模块的公开类型，保持与具体日志库解耦。
export type RuntimeLogSource = string;

// source 是 runtime log v0 的第一个 reserved field，但不是 required field。
export type RuntimeLogReservedFields = {
  readonly source?: RuntimeLogSource;
};

export type RuntimeLogFields = RuntimeLogReservedFields & Record<string, unknown>;

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeLogRedact = readonly string[];

// PinoRuntimeLoggerOptions 只暴露 core 认可的 Pino 配置。
export type PinoRuntimeLoggerOptions = {
  readonly level?: RuntimeLogLevel;
  readonly base?: RuntimeLogFields | null;
  readonly redact?: RuntimeLogRedact;
};

export type PinoRuntimeLoggerInput = PinoRuntimeLoggerOptions & {
  readonly runtimeConfig?: {
    readonly logging?: {
      readonly level?: RuntimeLogLevel;
    };
  };
};

// RuntimeLogger 描述 core 内部使用的最小日志能力。
export interface RuntimeLogger {
  debug(message: string, fields?: RuntimeLogFields): void;
  info(message: string, fields?: RuntimeLogFields): void;
  warn(message: string, fields?: RuntimeLogFields): void;
  error(message: string, fields?: RuntimeLogFields): void;
  child(bindings: RuntimeLogFields): RuntimeLogger;
}
