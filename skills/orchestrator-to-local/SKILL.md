---
name: orchestrator-to-local
description: >-
  Orchestrate multi-step or parallel work using the chosen Gemini model as lead
  orchestrator calling local model subagents with automatic harness selection
  (mini-swe-agent for coding subtasks, Antigravity native for knowledge work)
  and live streaming in chat. Triggered by /orchestrator-to-local or when asked
  to orchestrate local subagents.
---

# Gemini Orchestrator to Local Subagents (`/orchestrator-to-local`)

Use the active Gemini model as **orchestrator** to plan, decompose, delegate to local OpenAI-compatible subagents, and verify results.

## Workflow

1. **Check available local models** (optional if known):
   Call `agy_local_list` via `call_mcp_tool(ServerName="agy-local-agents_agy-local-agents", ToolName="agy_local_list", Arguments={})` (or `node "$HOME/.gemini/config/plugins/agy-local-agents/skills/local-models/scripts/local-model.mjs" list`).

2. **Plan, Classify & Size Each Subtask (`auto` Harness + Thinking Loops)**:
   Split the request into clear subtasks and classify each one before calling the local subagent:
   - **Coding subtasks** (writing/editing code, debugging, refactoring, running tests, build/shell work) -> pass **`taskType: "coding"`** (uses `mini-swe-agent` in `auto` mode).
   - **Knowledge work subtasks** (research, summarization, drafting docs/notes/copy, planning, analysis, Q&A) -> pass **`taskType: "knowledge"`** (uses Antigravity `native` harness in `auto` mode).
   - **Never** force `mini-swe-agent` on non-coding knowledge work.
   - **Determine `maxThinkingLoops` for each subagent**: choose a loop budget based on subtask complexity (e.g. `2-4` for simple lookups/summaries, `5-10` for multi-file analysis or targeted edits, `10-20` for complex coding/debugging) and pass `maxThinkingLoops` (or `--max-loops <N>` via CLI).

3. **Delegate with Live Monitoring & Subagent Pills**:
   - **Single subagent (1 call only)**:
     Call `call_mcp_tool` (`agy-local-agents_agy-local-agents` -> `agy_local_subagent`) with `{ task, taskType: "coding" | "knowledge", maxThinkingLoops: <N>, cwd }`. Its thinking process streams live in the tool status header (without a progress bar).
   - **Multiple subagents (> 1 calls, parallel or multi-step)**:
     1. Name each subagent sequentially with `runId`: **`"local-subagent-1"`**, **`"local-subagent-2"`**, **`"local-subagent-3"`**, ...
     2. In the chat turn when you invoke them, output clickable `sidecar://` pills so the user can click any pill to open the **Local Subagents Monitor** sidecar UI showing live progress, loop count (`Loop X / Max`), agent type (`Coding` vs `Knowledge`), model, harness, and thinking trace for every subagent:
        `[local-subagent-1](sidecar://agy-local-agents/agents/monitor.html?runId=local-subagent-1)` · `[local-subagent-2](sidecar://agy-local-agents/agents/monitor.html?runId=local-subagent-2)`
     3. Invoke `agy_local_subagent` in parallel with those sequential `runId` values:
        ```json
        {
          "ServerName": "agy-local-agents_agy-local-agents",
          "ToolName": "agy_local_subagent",
          "Arguments": {
            "runId": "local-subagent-1",
            "task": "<clear subtask instructions>",
            "taskType": "coding",
            "maxThinkingLoops": 8,
            "cwd": "<workspace_path>"
          }
        }
        ```
   - **If invoking via `node` (`run_command`)**:
     Launch `node "$HOME/.gemini/config/plugins/agy-local-agents/skills/local-models/scripts/local-model.mjs" subagent --run-id "local-subagent-1" --task-type coding --max-loops 8 --cwd "<workspace_path>" --task "<subtask>"` (`WaitMsBeforeAsync: 500`), paired with `agy_local_stream_watch` (single) or the `sidecar://` pills (multi).

4. **Verify & Synthesize**:
   - Check diffs, files, or test outputs produced by local subagents.
   - Present a unified final report attributing each subtask's model, resolved harness (`mini-swe-agent` vs `native`), and verified findings.
