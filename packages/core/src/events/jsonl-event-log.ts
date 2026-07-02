import {appendFile, mkdir, readFile} from "node:fs/promises";
import path from "node:path";

import {completeAgentEvent} from "./create-agent-event.js";
import {getEventFilePath} from "./event-file-paths.js";
import {parseEventsJsonl, serializeEvent} from "./event-json-codec.js";
import {errorMessage, isNodeError} from "../shared/errors.js";
import {resolveRuntimeConfig} from "../runtime/runtime-config.js";
import {SimpleLruMap} from "../shared/simple-lru-map.js";
import type {
    AgentEvent,
    AgentEventDraft,
} from "./types.js";
import type {EventLog} from "./event-log.js";
import type {RunId} from "../shared/ids.js";
import type {RuntimeConfigInput} from "../runtime/runtime-config.js";

// 按 run 把事件追加到单个 JSONL 文件，并按顺序读回。
export class JsonlEventLog implements EventLog {
    private readonly baseDir: string;
    private readonly appendQueues = new Map<RunId, Promise<void>>();
    private readonly nextSeqByRun: SimpleLruMap<RunId, number>;

    // 解析 baseDir，并初始化每个 run 的 seq 缓存。
    constructor(input: {
        baseDir?: string;
        nextSeqCacheSize?: number;
        runtimeConfig?: RuntimeConfigInput;
    } = {}) {
        const eventLogConfig = resolveRuntimeConfig(input.runtimeConfig).eventLog;

        this.baseDir = path.resolve(input.baseDir ?? eventLogConfig.baseDir);
        this.nextSeqByRun = new SimpleLruMap(
            input.nextSeqCacheSize ?? eventLogConfig.nextSeqCacheSize
        );
    }

    // 用 Promise 尾链串行化同一 run 的追加写入。
    async append(event: AgentEventDraft): Promise<AgentEvent> {
        const runId = event.runId;
        const previousTail = this.appendQueues.get(runId) ?? Promise.resolve();
        const appendPromise = previousTail.then(() => this.appendQueuedEvent(event));
        const tailPromise: Promise<void> = appendPromise.then(
            () => undefined,
            () => undefined
        );

        this.appendQueues.set(runId, tailPromise);
        void tailPromise.finally(() => {
            if (this.appendQueues.get(runId) === tailPromise) {
                this.appendQueues.delete(runId);
            }
        });

        return appendPromise;
    }

    // 读取某个 run 的 JSONL 文件，并只返回该 run 的事件。
    async readRunEvents(runId: RunId): Promise<AgentEvent[]> {
        const eventFilePath = this.resolveEventFilePath(runId);
        let content: string;

        try {
            content = await readFile(eventFilePath, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return [];
            }

            throw new Error(
                `Failed to read JSONL EventLog events for run "${runId}": ${errorMessage(error)}`,
                {cause: error}
            );
        }

        return parseEventsJsonl(content, runId).filter(
            (event) => event.runId === runId
        );
    }

    // 补全事件草稿，并把它追加成一行 JSONL。
    private async appendQueuedEvent(event: AgentEventDraft): Promise<AgentEvent> {
        try {
            const eventFilePath = this.resolveEventFilePath(event.runId);
            const seq = await this.nextSeq(event.runId);
            const completed = completeAgentEvent(event, seq);

            await mkdir(path.dirname(eventFilePath), {recursive: true});
            await appendFile(eventFilePath, `${serializeEvent(completed)}\n`, "utf8");
            this.nextSeqByRun.set(event.runId, seq + 1);

            return completed;
        } catch (error) {
            throw new Error(
                `Failed to append JSONL EventLog event for run "${event.runId}": ${errorMessage(error)}`,
                {cause: error}
            );
        }
    }

    // 返回某个 run 的下一个 seq，命中缓存时直接复用。
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

    // 缓存未命中时，扫描现有 JSONL 文件恢复最大 seq。
    private async maxExistingSeq(runId: RunId): Promise<number> {
        const eventFilePath = this.resolveEventFilePath(runId);
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

    // 解析指定 run 的 JSONL 绝对路径。
    private resolveEventFilePath(runId: RunId): string {
        return getEventFilePath(this.baseDir, runId);
    }
}
