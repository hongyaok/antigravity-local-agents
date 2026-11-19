---
name: local-subagent
description: >-
  Delegate an autonomous subtask to your local OpenAI-compatible model with full
  access to Antigravity skills, workspace tools, rules, MCP servers, Auto harness
  routing (mini-SWE for coding, Native for knowledge work), and live chat
  streaming. Triggered by /local-subagent or when asked to run a local subagent.
---

# Local Model Subagent (`/local-subagent`)

Use this skill when the user invokes `/local-subagent` or asks to delegate an autonomous task to a local model subagent.

## Auto Harness Rule (`auto` Default)

- Pass `taskType: "coding"` (MCP) or `--task-type coding` (CLI) **only** for coding-related subtasks -> routes to **`mini-swe-agent`**.
- Pass `taskType: "knowledge"` (MCP) or `--task-type knowledge` (CLI) for research, docs, summarization, planning, or general knowledge work -> routes to **Antigravity `native`**.

## Running with Live Streaming in Chat

### Option A: `agy_local_subagent` MCP Tool (Recommended)

Call `call_mcp_tool` on `agy-local-agents_agy-local-agents` -> `agy_local_subagent` with `task`, `taskType` (`"coding"` | `"knowledge"`), `cwd`, optional `model`, `harness`, `thinkingLevel`, `files`, `allowWrite`, `sessionId`.
- **Direct calls**: omit `maxThinkingLoops` so the subagent follows the user's configured **Max Thinking Loops** setting in Agent Defaults (`agentSettings.maxThinkingLoops`).
- **Orchestrated calls**: the orchestrator passes `maxThinkingLoops` (`1-50`) based on subtask complexity.
- Thinking streams live directly in chat (no progress bar).

### Option B: CLI `local-model.mjs subagent` + `agy_local_stream_watch`

Start with `--run-id` and `WaitMsBeforeAsync: 500`, then immediately call `agy_local_stream_watch({ runId })`:

```powershell
node "$HOME/.gemini/config/plugins/agy-local-agents/skills/local-models/scripts/local-model.mjs" subagent --run-id "sub-1" --task-type coding --cwd "<workspace_path>" --task "<user task>"
```

- Use `--read-only` to disable writes/commands, `--file <path>` to attach files, `--max-loops <n>` (omit on direct calls to follow `agentSettings.maxThinkingLoops`), `--quiet` to suppress `[Thinking]`, or `--json` for structured output.
- For multi-agent orchestration by Gemini, prefer [`/orchestrator-to-local`](../orchestrator-to-local/SKILL.md).

## Reporting Results

Report the exact model used, resolved harness (`mini-swe-agent` vs `native`) and thinking level, latency, tool/skill calls from `toolTrace`, and the local subagent's output faithfully. When verbose mode is active (default), display the `[Thinking]` trace visibly in chat.
