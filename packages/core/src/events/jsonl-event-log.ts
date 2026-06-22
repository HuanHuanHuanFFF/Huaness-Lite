import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { completeAgentEvent } from "./create-agent-event.js";
import {
  AGENT_EVENT_SOURCES,
  AGENT_EVENT_TYPES,
  CORE_SCHEMA_VERSION
} from "./types.js";
import type {
  AgentEvent,
  AgentEventDraft,
  AgentEventType,
  AgentEventSource,
  EventLog,
} from "./types.js";
import type {
  RunId
} from "../shared/ids.js";

const DEFAULT_BASE_DIR = ".huaness";
const RUNS_DIR = "runs";
const EVENTS_FILE_NAME = "events.jsonl";

// 将事件按 runId 写入独立 JSONL 文件，并支持按 run 读回。
export class JsonlEventLog implements EventLog {
  private readonly baseDir: string;
  private readonly appendQueues = new Map<RunId, Promise<void>>();
  private readonly nextSeqByRun = new Map<RunId, number>();

  // 设置事件日志根目录，默认写入仓库本地的 .huaness。
  constructor(input: { baseDir?: string } = {}) {
    this.baseDir = path.resolve(input.baseDir ?? DEFAULT_BASE_DIR);
  }

  // 同一 run 的 append 串行执行，保证 seq 和文件写入顺序稳定。
  async append(event: AgentEventDraft): Promise<AgentEvent> {
    const previousAppend = this.appendQueues.get(event.runId) ?? Promise.resolve();
    const appendPromise = previousAppend.then(() => this.appendUnlocked(event));
    const queueTail = appendPromise.then(
      () => undefined,
      () => undefined
    );

    this.appendQueues.set(event.runId, queueTail);
    void queueTail.finally(() => {
      if (this.appendQueues.get(event.runId) === queueTail) {
        this.appendQueues.delete(event.runId);
      }
    });

    return appendPromise;
  }

  // 按 runId 读取事件，保持文件中的写入顺序。
  async readByRun(runId: RunId): Promise<AgentEvent[]> {
    const eventFilePath = this.eventFilePath(runId);
    let content: string;

    try {
      content = await readFile(eventFilePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw new Error(
        `Failed to read JSONL EventLog events for run "${runId}": ${errorMessage(error)}`,
        { cause: error }
      );
    }

    return parseEventsJsonl(content, runId).filter(
      (event) => event.runId === runId
    );
  }

  // 在 run 专属队列内补齐事件并追加为单行 JSON。
  private async appendUnlocked(event: AgentEventDraft): Promise<AgentEvent> {
    try {
      const eventFilePath = this.eventFilePath(event.runId);
      const seq = await this.nextSeq(event.runId);
      const completed = completeAgentEvent(event, seq);

      await mkdir(path.dirname(eventFilePath), { recursive: true });
      await appendFile(eventFilePath, `${JSON.stringify(completed)}\n`, "utf8");
      this.nextSeqByRun.set(event.runId, seq + 1);

      return completed;
    } catch (error) {
      throw new Error(
        `Failed to append JSONL EventLog event for run "${event.runId}": ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  // 首次写入某个 run 时读取已有最大 seq，支持进程重启后续写。
  private async nextSeq(runId: RunId): Promise<number> {
    const cachedSeq = this.nextSeqByRun.get(runId);

    if (cachedSeq !== undefined) {
      return cachedSeq;
    }

    const maxSeq = await this.maxExistingSeq(runId);
    const nextSeq = maxSeq + 1;
    this.nextSeqByRun.set(runId, nextSeq);

    return nextSeq;
  }

  // 扫描现有 JSONL 文件，找出指定 run 的最大 seq。
  private async maxExistingSeq(runId: RunId): Promise<number> {
    const eventFilePath = this.eventFilePath(runId);
    let content: string;

    try {
      content = await readFile(eventFilePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 0;
      }

      throw error;
    }

    let maxSeq = 0;

    for (const event of parseEventsJsonl(content, runId)) {
      if (event.runId === runId && event.seq > maxSeq) {
        maxSeq = event.seq;
      }
    }

    return maxSeq;
  }

  // 生成某个 run 对应的事件文件路径。
  private eventFilePath(runId: RunId): string {
    const eventFilePath = path.resolve(
      this.baseDir,
      RUNS_DIR,
      encodeRunId(runId),
      EVENTS_FILE_NAME
    );

    this.assertInsideBaseDir(eventFilePath);

    return eventFilePath;
  }

  // 防止事件文件路径逃出 baseDir。
  private assertInsideBaseDir(filePath: string): void {
    const relativePath = path.relative(this.baseDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`JSONL EventLog path escapes baseDir: ${filePath}`);
    }
  }
}

// 逐行解析 JSONL，空行会被忽略。
function parseEventsJsonl(content: string, runId: RunId): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      continue;
    }

    events.push(parseEventLine(trimmedLine, index + 1, runId));
  }

  return events;
}

// 解析单行事件，并把 JSON 语法错误转换成可定位的错误信息。
function parseEventLine(
  line: string,
  lineNumber: number,
  runId: RunId
): AgentEvent {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse JSONL EventLog line ${lineNumber} for run "${runId}": ${errorMessage(error)}`,
      { cause: error }
    );
  }

  assertAgentEventEnvelope(value, lineNumber, runId);

  return value;
}

// 只校验事件 envelope，payload 仍先依赖 TypeScript 类型约束。
function assertAgentEventEnvelope(
  value: unknown,
  lineNumber: number,
  runId: RunId
): asserts value is AgentEvent {
  const record = isRecord(value) ? value : undefined;
  const seq = record?.seq;
  const step = record?.step;
  const toolCallId = record?.toolCallId;
  const parentEventId = record?.parentEventId;

  if (
    record === undefined ||
    record.schemaVersion !== CORE_SCHEMA_VERSION ||
    typeof record.id !== "string" ||
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 1 ||
    (
      step !== undefined &&
      (typeof step !== "number" || !Number.isInteger(step) || step < 0)
    ) ||
    (toolCallId !== undefined && typeof toolCallId !== "string") ||
    (parentEventId !== undefined && typeof parentEventId !== "string") ||
    typeof record.timestamp !== "string" ||
    !isAgentEventType(record.type) ||
    typeof record.runId !== "string" ||
    typeof record.sessionId !== "string" ||
    !isAgentEventSource(record.source) ||
    !isRecord(record.data)
  ) {
    throw new Error(
      `Invalid JSONL EventLog event envelope on line ${lineNumber} for run "${runId}"`
    );
  }
}

// 判断 JSON 中的 type 是否属于当前事件集合。
function isAgentEventType(value: unknown): value is AgentEventType {
  return (
    typeof value === "string" &&
    (AGENT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

// 判断 JSON 中的 source 是否属于当前来源集合。
function isAgentEventSource(value: unknown): value is AgentEventSource {
  return (
    typeof value === "string" &&
    (AGENT_EVENT_SOURCES as readonly string[]).includes(value)
  );
}

// 判断一个 JSON 值是否是普通对象。
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

// 将 runId 转成路径安全的目录名。
function encodeRunId(runId: RunId): string {
  return Buffer.from(runId, "utf8").toString("base64url") || "_";
}

// 提取可读的错误信息。
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 识别带 code 的 Node.js 错误。
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
