// 验证控制台 demo 会把 mock run 事件持久化到当前工作目录。

import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runMockAgentDemo } from "../src/demos/mock-agent-run.js";

const originalCwd = process.cwd();
const originalInitCwd = process.env.INIT_CWD;
let tempRoot: string;
let packageDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "huaness-demo-run-"));
  packageDir = path.join(tempRoot, "packages", "core");
  await mkdir(packageDir, { recursive: true });
  process.env.INIT_CWD = tempRoot;
  process.chdir(packageDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalInitCwd === undefined) {
    delete process.env.INIT_CWD;
  } else {
    process.env.INIT_CWD = originalInitCwd;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

describe("mock agent run demo", () => {
  test("writes the event timeline under INIT_CWD .huaness", async () => {
    const logs: string[] = [];

    await runMockAgentDemo({ log: (line) => logs.push(line) });

    const eventFiles = await findEventsFiles(path.join(tempRoot, ".huaness"));

    expect(eventFiles).toHaveLength(1);
    expect(await exists(path.join(packageDir, ".huaness"))).toBe(false);
    expect(logs.at(-1)).toBe(`eventLog: ${eventFiles[0]}`);

    const content = await readFile(eventFiles[0], "utf8");
    const events = content
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string });

    expect(events.map((event) => event.type)).toEqual([
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
  });
});

async function findEventsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
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
