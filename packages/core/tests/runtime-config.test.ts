import {describe, expect, test} from "vitest";

import {getDefaultRuntimeConfig, resolveRuntimeConfig} from "../src/index.js";

describe("runtime config", () => {
    test("fills omitted fields from runtime defaults", () => {
        const defaults = getDefaultRuntimeConfig();

        expect(
            resolveRuntimeConfig({
                eventLog: {
                    baseDir: "custom-events"
                },
                logging: {
                    level: "debug"
                }
            })
        ).toEqual({
            eventLog: {
                baseDir: "custom-events",
                nextSeqCacheSize: defaults.eventLog.nextSeqCacheSize
            },
            agent: {
                defaultMaxSteps: defaults.agent.defaultMaxSteps
            },
            logging: {
                level: "debug"
            }
        });
    });

    test("returns a fresh default config snapshot on each call", () => {
        const first = getDefaultRuntimeConfig();
        const second = getDefaultRuntimeConfig();

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first.eventLog).not.toBe(second.eventLog);
        expect(first.agent).not.toBe(second.agent);
        expect(first.logging).not.toBe(second.logging);
    });

    test("does not let callers mutate future default resolutions", () => {
        const mutableDefaults = getDefaultRuntimeConfig() as {
            eventLog: {baseDir: string; nextSeqCacheSize: number};
            agent: {defaultMaxSteps: number};
            logging: {level: "debug" | "info" | "warn" | "error"};
        };

        mutableDefaults.eventLog.baseDir = "mutated-base-dir";
        mutableDefaults.eventLog.nextSeqCacheSize = 1;
        mutableDefaults.agent.defaultMaxSteps = 1;
        mutableDefaults.logging.level = "error";

        expect(resolveRuntimeConfig()).toEqual({
            eventLog: {
                baseDir: ".huaness",
                nextSeqCacheSize: 256
            },
            agent: {
                defaultMaxSteps: 8
            },
            logging: {
                level: "info"
            }
        });
    });
});
