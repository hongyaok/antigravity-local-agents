---
name: local-models
description: >-
  Call upon, chat with, or delegate coding, review, and knowledge tasks directly
  to local or custom OpenAI-compatible models configured in agy-local-agents. Use
  whenever the user asks to use, call, ask, chat with, or run a task on a local
  model.
---

# Call Local & Custom Models (`local-models`)

Use this skill whenever the user wants to call, ask, chat with, or delegate a task to a local or OpenAI-compatible model configured in `agy-local-agents`.

Local models receive full Antigravity environment access (`read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `run_command`, `bash`, `list_skills`, `activate_skill`, `list_mcp_tools`, `call_mcp_tool`, and active rules).

## Auto Harness Rule (`auto` Default)

- **`coding`** tasks (editing code, debugging, tests, refactoring, build/shell) -> **`mini-swe-agent`**.
- **`knowledge`** tasks (summarization, writing, research, Q&A, planning, non-code analysis) -> **`native`**.
- Always pass `--task-type coding|knowledge` (CLI) or `taskType: "coding" | "knowledge"` (MCP) when delegating in `auto` mode.

## Option A: MCP Tools with Inline Live Streaming (Recommended)

- `agy_local_chat`: Send `prompt`, optional `model`, `taskType` (`"coding"` | `"knowledge"`), `harness` (`"auto"` | `"native"` | `"mini-swe-agent"`), `thinkingLevel`, `cwd`, `files`, `sessionId`. Renders live token/thinking/tool streaming inline in chat.
- `agy_local_subagent`: Autonomous local subagent with inline live streaming (`task`, `taskType`, `model`, `cwd`, `files`, `maxSteps`, `allowWrite`, `sessionId`).
- `agy_local_stream_watch`: Attach the inline live stream viewer to background `node local-model.mjs --run-id ...` runs.
- `agy_local_list` / `agy_local_discover` / `agy_local_add` / `agy_local_agent_settings` / `agy_local_hybrid_orchestrate` / `agy_local_direct_chat`.

## Option B: Zero-Dependency CLI (`local-model.mjs`) + Live Stream Watch

When invoking via `node` (`run_command`), pass `--run-id "<id>"` and `--task-type coding|knowledge` with `WaitMsBeforeAsync: 500`, then immediately call `agy_local_stream_watch({ runId: "<id>" })` so chat displays live streaming instead of `"working"`:

```powershell
node "$HOME/.gemini/config/plugins/agy-local-agents/skills/local-models/scripts/local-model.mjs" chat --run-id "chat-1" --task-type knowledge --cwd "<workspace_path>" --prompt "<user prompt>"
```

### Common Subcommands & Flags

- `subagent --task "<task>" --task-type <coding|knowledge> --run-id "<id>" --cwd "<dir>"`
- `stream [list|tail <runId>]`: Inspect or tail recorded local agent streams.
- `--harness <auto|native|mini-swe-agent>` and `--thinking <auto|off|minimal|low|medium|high|xhigh>`
- `harness [list|set <auto|native|mini-swe-agent>]`
- `thinking [list|set <level>]`
- `agent-settings [status|set] [--harness <id>] [--thinking <level>] [--verbose true|false] [--ui-mode simple|advanced]`
- `list` / `scan` / `discover --url ... --add-all` / `add` / `default` / `env` / `hybrid` / `direct-chat [status|on|off]`

## Agents & Sidecar UI

- **Main Agent dropdown**: `orchestrator-to-local`, `local-model-chat`, and `local-<model-slug>` (e.g. `local-coder-iq1-m`).
- **Sidecar**: [Open Antigravity Local Agents](sidecar://agy-local-agents/agents/) (Simple & Advanced modes).
- **Reporting**: Display `[Thinking]` trace (when verbose is on), active model, resolved harness, tool calls, and latency faithfully.
