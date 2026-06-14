# Repository Guidelines

## Project Structure & Module Organization

This repository is currently a lightweight agent-runtime study and design workspace.

- `docs/` contains architecture notes, reference analysis, and learning summaries.
- `references/` contains Git submodules for external agent projects. Treat these as read-only references unless explicitly updating the submodule pointer.
- `README.md` and `LICENSE` come from the main repository root.

Source code has not been established yet. When implementation starts, prefer a simple structure such as `huaness_lite/` for runtime code and `tests/` for tests, then update this file with the actual commands and conventions.

## Build, Test, and Development Commands

There is no build system yet. Current useful commands:

```powershell
git status
git submodule status
git submodule update --init --recursive
```

Use `git submodule update --init --recursive` after cloning so `references/*` resolves to the recorded commits.

## Coding Style & Naming Conventions

Keep changes small and easy to review. Follow existing file naming:

- Markdown docs use numbered prefixes when they are part of the learning sequence, for example `docs/06-mini-swe-agent-learning-summary.md`.
- Use clear English file names for shared project docs.
- Prefer concise explanations over long speculative design rules.

When code is added, match the chosen language formatter and add the exact format command here.

## Testing Guidelines

No test framework is configured yet. Once runtime code begins, add focused tests for the agent loop, tool registry, configuration loading, and trace/event logging.

Use descriptive test names that state behavior, not implementation details.

## Commit & Pull Request Guidelines

Current history uses short imperative commit messages, for example:

```text
Add project docs and reference submodules
```

For future commits, keep the subject direct and scoped. Pull requests should include:

- What changed.
- Why it changed.
- How it was checked.

## Agent-Specific Instructions

Before editing, inspect the relevant files and follow the current repository shape. For non-trivial work, make a short plan first. After changes, run whatever verification exists; if no verification exists yet, state that clearly.

Do not expand project boundaries prematurely. This repository is still defining its runtime architecture through small, testable steps.
