import { Writable } from "node:stream";

import { describe, expect, test } from "vitest";

import * as core from "../src/index.js";
import type {
  PinoRuntimeLoggerOptions,
  RuntimeLogReservedFields,
  RuntimeLogger
} from "../src/index.js";

describe("NoopRuntimeLogger", () => {
  test("ignores log calls and keeps child chaining available", () => {
    acceptsRuntimeLogger(new core.NoopRuntimeLogger());

    const logger = new core.NoopRuntimeLogger();
    const child = logger.child({ module: "runtime" });

    expect(child).toBeInstanceOf(core.NoopRuntimeLogger);
    expect(() => {
      logger.debug("debug", { step: 1 });
      logger.info("info", { step: 1 });
      child.warn("warn", { step: 1 });
      child.error("error", { step: 1 });
    }).not.toThrow();
  });
});

describe("createPinoRuntimeLogger", () => {
  test("exports a factory function", () => {
    expect(typeof core.createPinoRuntimeLogger).toBe("function");
  });

  test("writes JSON logs with base fields and respects level filtering", () => {
    const sink = createMemorySink();
    const logger = core.createPinoRuntimeLogger(
      {
        level: "info",
        base: { service: "core-runtime" }
      },
      sink
    );

    logger.debug("hidden", { step: 0 });
    logger.info("visible", { step: 1 });

    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      level: 30,
      service: "core-runtime",
      step: 1,
      msg: "visible"
    });
  });

  test("adds child bindings to descendant log lines", () => {
    const sink = createMemorySink();
    const logger = core.createPinoRuntimeLogger(
      {
        base: { service: "core-runtime" }
      },
      sink
    );
    const child = logger.child({ module: "gateway", runId: "run_01" });

    child.info("child line", { step: 2 });

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      service: "core-runtime",
      module: "gateway",
      runId: "run_01",
      step: 2,
      msg: "child line"
    });
  });

  test("writes the reserved source field when provided on a log line", () => {
    const sink = createMemorySink();
    const logger = core.createPinoRuntimeLogger({}, sink);

    logger.info("with source", {
      source: "agent_loop",
      step: 6
    });

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      source: "agent_loop",
      step: 6,
      msg: "with source"
    });
  });

  test("applies default redaction and appends custom redaction paths", () => {
    const sink = createMemorySink();
    const options: PinoRuntimeLoggerOptions = {
      redact: ["nested.secret"]
    };
    const logger = core.createPinoRuntimeLogger(
      options,
      sink
    );

    logger.info("redacted", {
        authorization: "Bearer top-secret",
        headers: { authorization: "Bearer nested-secret" },
        apiKey: "api-key-secret",
        token: "token-secret",
        password: "password-secret",
        auth: { token: "nested-token-secret" },
        nested: { secret: "hidden", visible: "shown" }
      });

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      authorization: "[Redacted]",
      headers: {
        authorization: "[Redacted]"
      },
      apiKey: "[Redacted]",
      token: "[Redacted]",
      password: "[Redacted]",
      auth: {
        token: "[Redacted]"
      },
      nested: {
        secret: "[Redacted]",
        visible: "shown"
      },
      msg: "redacted"
    });
  });

  test("redacts base and child bindings before writing the log line", () => {
    const sink = createMemorySink();
    const logger = core.createPinoRuntimeLogger(
      {
        base: {
          service: "core-runtime",
          token: "base-secret"
        }
      },
      sink
    );
    const child = logger.child({
      source: "tool_gateway",
      authorization: "Bearer child-secret",
      module: "gateway"
    });

    child.info("bound fields", { step: 5 });

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      service: "core-runtime",
      source: "tool_gateway",
      token: "[Redacted]",
      authorization: "[Redacted]",
      module: "gateway",
      step: 5,
      msg: "bound fields"
    });
  });

  test("writes JSON to stdout by default when no destination is injected", () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    process.stdout.write = (((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);

    try {
      const logger = core.createPinoRuntimeLogger({ base: { service: "core-runtime" } });

      logger.info("stdout line", { step: 3 });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(JSON.parse(chunks.join("").trim())).toMatchObject({
      service: "core-runtime",
      step: 3,
      msg: "stdout line"
    });
  });

  test("does not expose pretty in public options", () => {
    const sink = createMemorySink();
    const options = {
      level: "info"
    } satisfies PinoRuntimeLoggerOptions;

    const logger = core.createPinoRuntimeLogger(options, sink);
    logger.info("no pretty", { step: 4 });

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      step: 4,
      msg: "no pretty"
    });
  });

  test("uses runtimeConfig.logging.level when logger options omit level", () => {
    const sink = createMemorySink();
    const logger = core.createPinoRuntimeLogger(
      {
        runtimeConfig: core.resolveRuntimeConfig({
          logging: {
            level: "error"
          }
        })
      },
      sink
    );

    logger.warn("hidden", { step: 1 });
    logger.error("visible", { step: 2 });

    expect(sink.lines).toHaveLength(1);
    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({
      step: 2,
      msg: "visible"
    });
  });
});

test("RuntimeLogger rejects ambiguous second string arguments at type level", () => {
  const logger = new core.NoopRuntimeLogger();
  const options: PinoRuntimeLoggerOptions = { level: "info" };
  const reservedFields: RuntimeLogReservedFields = { source: "agent_loop" };

  logger.info("valid", { step: 1 });
  // @ts-expect-error RuntimeLogger should not accept a second string argument
  logger.info("first", "second");
  // @ts-expect-error PinoRuntimeLoggerOptions should not expose pretty
  const invalidOptions: PinoRuntimeLoggerOptions = { pretty: true };

  expect(options.level).toBe("info");
  expect(reservedFields.source).toBe("agent_loop");
  expect(typeof invalidOptions).toBe("object");
});

function createMemorySink(): NodeJS.WritableStream & { lines: string[] } {
  const lines: string[] = [];
  let buffer = "";

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      buffer += toUtf8(chunk);

      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter((line) => line.length > 0));
      callback();
    }
  }) as unknown as NodeJS.WritableStream & { lines: string[] };

  sink.lines = lines;

  return sink;
}

function toUtf8(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

function acceptsRuntimeLogger(_logger: RuntimeLogger): void {}
