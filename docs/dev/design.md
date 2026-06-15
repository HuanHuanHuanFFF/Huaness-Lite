# Huaness Lite 设计想法

## 整体目标

Huaness Lite 的目标是做一个轻量化的 openclaw-like 通用型 agent / harness，而不是某个单一场景的垂直 agent。

重点学习和实现的是 agent run/session 管理、agent loop、tool gateway、权限策略、sandbox/workspace 控制、trace/event 记录，以及后续的 replay/eval 能力。

## Coding Agent Auto Review

后续重点学习 Codex / Claude Code 这类 coding agent 的 auto review 能力。

基础、低风险、可预测的工具调用应该先进入白名单，例如读取 workspace 内文件、列目录、查看 git diff、运行明确安全的只读命令等，避免 agent 被频繁打断。

危险或越界操作才进入 auto review，例如写入敏感路径、删除文件、联网、读取密钥、执行未知 shell 命令、修改权限、安装依赖、访问 workspace 外部路径等。

主 agent 不应该自己决定危险操作是否安全，而是把这类操作包装成结构化审批请求，交给独立 reviewer agent 判断是否符合用户意图，以及是否存在数据外泄、凭据探测、破坏性修改或权限扩大风险。真正的执行权限仍然由 sandbox、path guard、policy engine 和 tool executor 控制。
