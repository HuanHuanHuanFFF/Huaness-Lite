// noop logger 用于禁用 runtime log，同时保持调用端接口稳定。
import type {
  RuntimeLogFields,
  RuntimeLogger
} from "./types.js";

// NoopRuntimeLogger 会忽略所有日志写入。
export class NoopRuntimeLogger implements RuntimeLogger {
  debug(_message: string, _fields?: RuntimeLogFields): void {}

  info(_message: string, _fields?: RuntimeLogFields): void {}

  warn(_message: string, _fields?: RuntimeLogFields): void {}

  error(_message: string, _fields?: RuntimeLogFields): void {}

  child(_bindings: RuntimeLogFields): RuntimeLogger {
    return this;
  }
}
