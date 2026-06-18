// 验证 JSONL EventLog 的文件写入、读取和 mock run 持久化行为。

import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  AgentLoop,
  AllowPolicyEngine,
  CORE_SCHEMA_VERSION,
  FakeModelClient,
  JsonlEventLog,
  ToolGateway,
  echoTool
} from "../src/index.js";
import type { AgentEvent, RunId, SessionId } from "../src/index.js";

let tempRoot: string;
let baseDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "huaness-jsonl-event-log-"));
  baseDir = path.join(tempRoot, ".huaness");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("JsonlEventLog", () => {
  test("appends complete JSON lines and reads one run in append order", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runA: RunId = "run_a";
    const runB: RunId = "run_b";
    const sessionId: SessionId = "session_01";
    const first = createEvent({ runId: runA, sessionId, type: "run.created" });
    const otherRun = createEvent({ runId: runB, sessionId, type: "run.created" });
    const second = createEvent({
      runId: runA,
      sessionId,
      type: "run.completed"
    });

    await eventLog.append(first);
    await eventLog.append(otherRun);
    await eventLog.append(second);

    expect(await eventLog.readByRun(runA)).toEqual([first, second]);
    expect(await eventLog.readByRun(runB)).toEqual([otherRun]);

    const eventFiles = await findEventsFiles(baseDir);
    expect(eventFiles).toHaveLength(2);

    const runAFile = await findFileContaining(eventFiles, '"runId":"run_a"');
    const rawLines = await readJsonLines(runAFile);

    expect(rawLines).toHaveLength(2);
    expect(rawLines.map((line) => JSON.parse(line))).toEqual([first, second]);
  });

  test("returns an empty array when the run file does not exist", async () => {
    const eventLog = new JsonlEventLog({ baseDir });

    expect(await eventLog.readByRun("missing_run")).toEqual([]);
  });

  test("skips blank lines while reading", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const event = createEvent({
      runId: "run_blank_lines",
      sessionId: "session_blank_lines",
      type: "run.created"
    });

    await eventLog.append(event);

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, "\n  \n", "utf8");

    expect(await eventLog.readByRun("run_blank_lines")).toEqual([event]);
  });

  test("throws a clear error when a JSONL line is invalid", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const event = createEvent({
      runId: "run_bad_json",
      sessionId: "session_bad_json",
      type: "run.created"
    });

    await eventLog.append(event);

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, "{bad json}\n", "utf8");

    await expect(eventLog.readByRun("run_bad_json")).rejects.toThrow(
      /Failed to parse JSONL EventLog line 2 for run "run_bad_json"/
    );
  });

  test("filters out events in the file that belong to another run", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runEvent = createEvent({
      runId: "run_current",
      sessionId: "session_current",
      type: "run.created"
    });
    const strayEvent = createEvent({
      runId: "run_stray",
      sessionId: "session_stray",
      type: "run.created"
    });

    await eventLog.append(runEvent);

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, `${JSON.stringify(strayEvent)}\n`, "utf8");

    expect(await eventLog.readByRun("run_current")).toEqual([runEvent]);
  });

  test("keeps path-like run ids inside the configured base directory", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runId = "../escape\\..\\run";
    const event = createEvent({
      runId,
      sessionId: "session_path_guard",
      type: "run.created"
    });

    await eventLog.append(event);

    expect(await eventLog.readByRun(runId)).toEqual([event]);

    const [eventFile] = await findEventsFiles(baseDir);
    const relativePath = path.relative(path.resolve(baseDir), eventFile);

    expect(relativePath.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relativePath)).toBe(false);
    expect(path.basename(path.dirname(eventFile))).not.toContain("..");
    expect(await exists(path.join(tempRoot, "escape"))).toBe(false);
  });

  test("throws a clear error when appending fails", async () => {
    const fileBaseDir = path.join(tempRoot, "not-a-directory");
    await writeFile(fileBaseDir, "blocks directory creation", "utf8");
    const eventLog = new JsonlEventLog({ baseDir: fileBaseDir });

    await expect(
      eventLog.append(
        createEvent({
          runId: "run_write_failure",
          sessionId: "session_write_failure",
          type: "run.created"
        })
      )
    ).rejects.toThrow(/Failed to append JSONL EventLog event for run "run_write_failure"/);
  });

  test("records a fake AgentLoop run and reads the timeline back from JSONL", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const toolGateway = new ToolGateway({
      eventWriter: eventLog,
      policyEngine: new AllowPolicyEngine(),
      tools: [echoTool]
    });
    const loop = new AgentLoop({
      eventWriter: eventLog,
      modelClient: new FakeModelClient(),
      toolGateway
    });

    const result = await loop.run({
      runId: "run_jsonl_mock_01",
      sessionId: "session_jsonl_mock_01",
      userMessage: "Echo the fake input"
    });

    const runEvents = await eventLog.readByRun("run_jsonl_mock_01");

    expect(result.finalAnswer).toBe("Final answer: hello from fake model");
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.created",
      "context.built",
      "model.requested",
      "model.responded",
      "tool.requested",
      "policy.decided",
      "tool.completed",
      "observation.appended",
      "model.requested",
      "model.responded",
      "run.completed"
    ]);
    expect(runEvents.at(0)?.data).toEqual({
      userMessage: "Echo the fake input"
    });
    expect(runEvents.at(6)?.data).toMatchObject({
      result: {
        callId: "call_echo_01",
        toolName: "echo",
        output: "hello from fake model"
      }
    });
    expect(runEvents.at(7)?.data).toMatchObject({
      toolCallId: "call_echo_01",
      toolName: "echo",
      message: {
        role: "tool",
        content: "hello from fake model",
        toolCallId: "call_echo_01",
        toolName: "echo"
      }
    });
    expect(runEvents.at(-1)?.data).toEqual({
      finalAnswer: "Final answer: hello from fake model"
    });
  });
});

function createEvent(input: {
  runId: RunId;
  sessionId: SessionId;
  type: string;
}): AgentEvent {
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    type: input.type,
    runId: input.runId,
    sessionId: input.sessionId,
    timestamp: "2026-06-16T00:00:00.000Z"
  };
}

async function readJsonLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");

  return content.split("\n").filter((line) => line.length > 0);
}

async function findFileContaining(
  filePaths: string[],
  expectedContent: string
): Promise<string> {
  for (const filePath of filePaths) {
    const content = await readFile(filePath, "utf8");

    if (content.includes(expectedContent)) {
      return filePath;
    }
  }

  throw new Error(`No events file contained ${expectedContent}`);
}

async function findEventsFiles(root: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findEventsFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name === "events.jsonl") {
      files.push(entryPath);
    }
  }

  return files;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
