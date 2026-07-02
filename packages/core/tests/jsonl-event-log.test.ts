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
  getDefaultRuntimeConfig,
  JsonlEventLog,
  ToolGateway,
  resolveRuntimeConfig,
  echoTool
} from "../src/index.js";
import type {
  AgentEvent,
  AgentEventDraft,
  RunId,
  SessionId
} from "../src/index.js";

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
  test("appends complete JSON lines from drafts and reads one run in append order", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runA: RunId = "run_a";
    const runB: RunId = "run_b";
    const sessionId: SessionId = "session_01";

    const first = await eventLog.append(
      createDraft({ runId: runA, sessionId, type: "run.created" })
    );
    const otherRun = await eventLog.append(
      createDraft({ runId: runB, sessionId, type: "run.created" })
    );
    const second = await eventLog.append({
      type: "run.completed",
      runId: runA,
      sessionId,
      source: "agent_loop",
      data: { finalAnswer: "done" }
    });

    expect(await eventLog.readRunEvents(runA)).toEqual([first, second]);
    expect(await eventLog.readRunEvents(runB)).toEqual([otherRun]);
    expect(first).toMatchObject({
      schemaVersion: CORE_SCHEMA_VERSION,
      seq: 1,
      type: "run.created",
      runId: runA,
      sessionId,
      source: "agent_loop"
    });
    expect(first.id).toEqual(expect.any(String));
    expect(first.timestamp).toEqual(expect.any(String));
    expect(second.seq).toBe(2);
    expect(otherRun.seq).toBe(1);

    const eventFiles = await findEventsFiles(baseDir);
    expect(eventFiles).toHaveLength(2);

    const runAFile = await findFileContaining(eventFiles, '"runId":"run_a"');
    const rawLines = await readJsonLines(runAFile);

    expect(rawLines).toHaveLength(2);
    expect(rawLines.map((line) => JSON.parse(line))).toEqual([first, second]);
  });

  test("queues concurrent appends for the same run in call order", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runId: RunId = "run_concurrent";
    const sessionId: SessionId = "session_concurrent";

    const completed = await Promise.all([
      eventLog.append(createDraft({ runId, sessionId, type: "run.created" })),
      eventLog.append({
        type: "model.requested",
        runId,
        sessionId,
        source: "agent_loop",
        data: { step: 0 }
      }),
      eventLog.append({
        type: "run.completed",
        runId,
        sessionId,
        source: "agent_loop",
        data: { finalAnswer: "done" }
      })
    ]);

    expect(completed.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((await eventLog.readRunEvents(runId)).map((event) => event.seq)).toEqual([
      1,
      2,
      3
    ]);
  });

  test("continues seq after a new instance appends to an existing run file", async () => {
    const runId: RunId = "run_restart";
    const sessionId: SessionId = "session_restart";
    const firstEventLog = new JsonlEventLog({ baseDir });

    await firstEventLog.append(createDraft({ runId, sessionId, type: "run.created" }));
    await firstEventLog.append({
      type: "model.requested",
      runId,
      sessionId,
      source: "agent_loop",
      data: { step: 0 }
    });

    const restartedEventLog = new JsonlEventLog({ baseDir });
    const completed = await restartedEventLog.append({
      type: "run.completed",
      runId,
      sessionId,
      source: "agent_loop",
      data: { finalAnswer: "after restart" }
    });

    expect(completed.seq).toBe(3);
    expect(
      (await restartedEventLog.readRunEvents(runId)).map((event) => event.seq)
    ).toEqual([1, 2, 3]);
  });

  test("returns an empty array when the run file does not exist", async () => {
    const eventLog = new JsonlEventLog({ baseDir });

    expect(await eventLog.readRunEvents("missing_run")).toEqual([]);
  });

  test("uses runtimeConfig.eventLog defaults when constructor fields are omitted", async () => {
    const defaults = getDefaultRuntimeConfig();
    const configuredBaseDir = path.join(tempRoot, "runtime-config-events");
    const runtimeConfig = resolveRuntimeConfig({
      eventLog: {
        baseDir: configuredBaseDir,
        nextSeqCacheSize: 3
      }
    });
    const eventLog = new JsonlEventLog({ runtimeConfig });

    await eventLog.append(
      createDraft({
        runId: "run_runtime_config",
        sessionId: "session_runtime_config",
        type: "run.created"
      })
    );

    const eventFiles = await findEventsFiles(configuredBaseDir);

    expect(eventFiles).toHaveLength(1);
    expect(runtimeConfig.eventLog.nextSeqCacheSize).not.toBe(
      defaults.eventLog.nextSeqCacheSize
    );
  });

  test("skips blank lines while reading", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const event = await eventLog.append(
      createDraft({
        runId: "run_blank_lines",
        sessionId: "session_blank_lines",
        type: "run.created"
      })
    );

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, "\n  \n", "utf8");

    expect(await eventLog.readRunEvents("run_blank_lines")).toEqual([event]);
  });

  test("throws a clear error when a JSONL line is invalid", async () => {
    const eventLog = new JsonlEventLog({ baseDir });

    await eventLog.append(
      createDraft({
        runId: "run_bad_json",
        sessionId: "session_bad_json",
        type: "run.created"
      })
    );

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, "{bad json}\n", "utf8");

    await expect(eventLog.readRunEvents("run_bad_json")).rejects.toThrow(
      /Failed to parse JSONL EventLog line 2 for run "run_bad_json"/
    );
  });

  test("throws a clear error when a JSONL event envelope is invalid", async () => {
    const eventLog = new JsonlEventLog({ baseDir });

    await eventLog.append(
      createDraft({
        runId: "run_bad_envelope",
        sessionId: "session_bad_envelope",
        type: "run.created"
      })
    );

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, '{"runId":"run_bad_envelope"}\n', "utf8");

    await expect(eventLog.readRunEvents("run_bad_envelope")).rejects.toThrow(
      /Invalid JSONL EventLog event envelope on line 2 for run "run_bad_envelope"/
    );
  });

  test("filters out events in the file that belong to another run", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runEvent = await eventLog.append(
      createDraft({
        runId: "run_current",
        sessionId: "session_current",
        type: "run.created"
      })
    );
    const strayEvent = createCompleteEvent({
      runId: "run_stray",
      sessionId: "session_stray",
      type: "run.created",
      seq: 99
    });

    const [eventFile] = await findEventsFiles(baseDir);
    await appendFile(eventFile, `${JSON.stringify(strayEvent)}\n`, "utf8");

    expect(await eventLog.readRunEvents("run_current")).toEqual([runEvent]);
  });

  test("keeps path-like run ids inside the configured base directory", async () => {
    const eventLog = new JsonlEventLog({ baseDir });
    const runId = "../escape\\..\\run";
    const event = await eventLog.append(
      createDraft({
        runId,
        sessionId: "session_path_guard",
        type: "run.created"
      })
    );

    expect(await eventLog.readRunEvents(runId)).toEqual([event]);

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
        createDraft({
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

    const runEvents = await eventLog.readRunEvents("run_jsonl_mock_01");

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
    expect(runEvents.map((event) => event.seq)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11
    ]);
    expect(runEvents.map((event) => event.source)).toEqual([
      "agent_loop",
      "agent_loop",
      "agent_loop",
      "agent_loop",
      "tool_gateway",
      "tool_gateway",
      "tool_gateway",
      "agent_loop",
      "agent_loop",
      "agent_loop",
      "agent_loop"
    ]);
    expect(runEvents[2]).toMatchObject({ step: 0 });
    expect(runEvents[3]).toMatchObject({ step: 0 });
    expect(runEvents[4]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01"
    });
    expect(runEvents[5]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01"
    });
    expect(runEvents[6]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01"
    });
    expect(runEvents[6]?.id).toEqual(expect.any(String));
    expect(runEvents[7]).toMatchObject({
      step: 0,
      toolCallId: "call_echo_01",
      parentEventId: runEvents[6]?.id
    });
    expect(runEvents[8]).toMatchObject({ step: 1 });
    expect(runEvents[9]).toMatchObject({ step: 1 });
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

function createDraft(input: {
  runId: RunId;
  sessionId: SessionId;
  type: "run.created";
}): AgentEventDraft {
  return {
    type: input.type,
    runId: input.runId,
    sessionId: input.sessionId,
    source: "agent_loop",
    data: { userMessage: "start" }
  };
}

function createCompleteEvent(input: {
  runId: RunId;
  sessionId: SessionId;
  type: "run.created";
  seq: number;
}): AgentEvent {
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    id: `event_${input.seq}`,
    seq: input.seq,
    timestamp: "2026-06-16T00:00:00.000Z",
    type: input.type,
    runId: input.runId,
    sessionId: input.sessionId,
    source: "agent_loop",
    data: { userMessage: "stray" }
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
