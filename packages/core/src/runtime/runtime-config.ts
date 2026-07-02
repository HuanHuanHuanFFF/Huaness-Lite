import type {RuntimeLogLevel} from "../logging/types.js";

export type RuntimeConfig = {
    readonly eventLog: {
        readonly baseDir: string;
        readonly nextSeqCacheSize: number;
    };
    readonly agent: {
        readonly defaultMaxSteps: number;
    };
    readonly logging: {
        readonly level: RuntimeLogLevel;
    };
};

export type RuntimeConfigInput = {
    readonly eventLog?: Partial<RuntimeConfig["eventLog"]>;
    readonly agent?: Partial<RuntimeConfig["agent"]>;
    readonly logging?: Partial<RuntimeConfig["logging"]>;
};

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = freezeRuntimeConfig({
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

// 返回一份新的默认配置快照，避免调用方持有共享可变引用。
export function getDefaultRuntimeConfig(): RuntimeConfig {
    return cloneRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
}

// 把调用方传入的局部覆盖合并到模块内部冻结的默认值上。
export function resolveRuntimeConfig(
    input: RuntimeConfigInput = {}
): RuntimeConfig {
    return {
        eventLog: {
            baseDir:
                input.eventLog?.baseDir ??
                DEFAULT_RUNTIME_CONFIG.eventLog.baseDir,
            nextSeqCacheSize:
                input.eventLog?.nextSeqCacheSize ??
                DEFAULT_RUNTIME_CONFIG.eventLog.nextSeqCacheSize
        },
        agent: {
            defaultMaxSteps:
                input.agent?.defaultMaxSteps ??
                DEFAULT_RUNTIME_CONFIG.agent.defaultMaxSteps
        },
        logging: {
            level:
                input.logging?.level ??
                DEFAULT_RUNTIME_CONFIG.logging.level
        }
    };
}

function cloneRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
    return {
        eventLog: {
            baseDir: config.eventLog.baseDir,
            nextSeqCacheSize: config.eventLog.nextSeqCacheSize
        },
        agent: {
            defaultMaxSteps: config.agent.defaultMaxSteps
        },
        logging: {
            level: config.logging.level
        }
    };
}

// 默认值只在模块内部保留一份冻结实例，防止嵌套字段被意外改写。
function freezeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
    Object.freeze(config.eventLog);
    Object.freeze(config.agent);
    Object.freeze(config.logging);

    return Object.freeze(config);
}
