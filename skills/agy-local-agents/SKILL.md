---
name: agy-local-agents
description: >-
  Manage and run local or OpenAI-compatible models as Antigravity agents and
  subagents with Auto harness routing (mini-SWE for coding, Native for knowledge
  work), Gemini-to-local orchestration, live chat streaming, and the Local Agents
  sidecar panel.
---

# Antigravity Local Agents (`agy-local-agents`)

## Calling & Orchestrating Local Models

- **Live Streaming in Chat (Preferred)**: Invoke local models via the `agy-local-agents` MCP tools (`agy_local_chat`, `agy_local_subagent`) so tokens, `[Thinking]`, and tool calls stream inline in chat instead of showing only a `"working"` spinner.
- **When Running via `node` (`run_command`)**: Pass `--run-id "<unique-id>"` and `--task-type <coding|knowledge>` to `skills/local-models/scripts/local-model.mjs`, launch with `WaitMsBeforeAsync: 500`, and immediately call `agy_local_stream_watch` with `{ runId }` (or `{ runIds: [...] }`) to stream live output in chat.
- **Auto Harness Rule (`auto` default)**:
  - **`coding`** tasks (implementing, refactoring, debugging, fixing bugs, tests, source edits, shell/build tasks) -> **`mini-swe-agent`**.
  - **`knowledge`** tasks (research, summarization, Q&A, drafting docs/emails, planning, non-code analysis) -> **Antigravity Native (`native`)**.
  - Only use `mini-swe-agent` when the task or subtask is coding-related.
- **Gemini-to-Local Orchestration**: Use [`orchestrator-to-local`](../orchestrator-to-local/SKILL.md) (or `Main Agent > orchestrator-to-local`) to let the chosen Gemini model plan, split work, classify each subtask, and call local subagents in parallel.
- **Full Antigravity Environment Access**: Local agents and subagents have access to `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `run_command`, `bash`, `list_skills`, `activate_skill`, `list_mcp_tools`, `call_mcp_tool`, and active `GEMINI.md` / `AGENTS.md` / plugin rules.

## Agents & Chat Triggers

Enabled models sync as `mainAgent: true` agents under **`Model Selection -> Main Agent >`**:
- `orchestrator-to-local` (Gemini orchestrator calling local subagents)
- `local-model-chat` (direct chat with default local model)
- `local-<model-slug>` (direct chat with a specific enabled model, e.g. `local-coder-iq1-m`)

*(`local-subagent` is intentionally omitted from the Agents dropdown; use the `/local-subagent` skill, `agy_local_subagent` MCP tool, or `orchestrator-to-local` instead.)*

- **Direct Chat Hook (`hooks.json`)**: Prefix any prompt with `@local`, `/local`, `@local-subagent`, `/local-subagent`, `@mini-swe`, `/mini-swe`, or `@<model>` (bypass Direct Chat for one turn with `@cloud` or `/orchestrator-to-local`).

## Sidecar Panel (`Simple` & `Advanced` Modes)

[Open Antigravity Local Agents](sidecar://agy-local-agents/agents/) · [Open Local Subagents Monitor](sidecar://agy-local-agents/agents/monitor.html)

- Toggle between **Simple** (Models / Agent / Add tabs) and **Advanced** (full provider catalog, per-model overrides, SDK snippets, quotas) in the header.
- Configure global defaults (`Auto` / `Native` / `mini-SWE` harness, thinking level, `Stream Thinking`, `Max Thinking Loops` for direct calls), test models, and manage endpoints.
- When 2 or more local subagents run in parallel, assign sequential `runId`s (`local-subagent-1`, `local-subagent-2`, ...) and emit `[local-subagent-N](sidecar://agy-local-agents/agents/monitor.html?runId=local-subagent-N)` pills in chat.

## Bundled MCP Tools (`agy-local-agents`)

- `agy_local_list`: List added models, default selection, `agentSettings`, `harnesses`, `thinkingLevels`, and `recentStreams`.
- `agy_local_discover` / `agy_local_add` / `agy_local_remove`: Discover and manage OpenAI-compatible models.
- `agy_local_chat`: Chat with a local model with inline live streaming and `taskType` auto-routing.
- `agy_local_subagent`: Run an autonomous local subagent with inline live streaming and `taskType` auto-routing.
- `agy_local_stream_watch`: Attach the inline live stream viewer to one or more background `node local-model.mjs --run-id ...` executions.
- `agy_local_agent_settings`: Inspect or update `harness` (`auto` | `native` | `mini-swe-agent`), `thinkingLevel`, `verbose`, `maxThinkingLoops` (`1-50`), and `uiMode` (`simple` | `advanced`).
- `agy_local_hybrid_orchestrate`: Run AST-skeleton + dual builders + blind critic workflow.
- `agy_local_direct_chat`: Enable/disable Direct Local Chat mode.
