/**
 * Antigravity `PreInvocation` lifecycle hook for `agy-local-agents`.
 *
 * Routes user prompts directly to a configured local/custom OpenAI-compatible
 * model when:
 *   1. The user message starts with `@local`, `/local`, `@local-subagent`,
 *      `/local-subagent`, `@mini-swe`, `/mini-swe`, or `@<model-or-agentName>`
 *   2. Global Direct Local Chat mode (`state.directChat.enabled`) is active
 *      (unless bypassed for one turn with `@cloud`, `/cloud`,
 *       `@orchestrator-to-local`, or `/orchestrator-to-local`).
 *
 * Outputs `{}` immediately when not triggered so normal Antigravity turns have
 * near-zero overhead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  chatWithModel,
  formatVerboseThinkingMarkdown,
  readState,
  resolveConfiguredModel,
  resolveEffectiveAgentConfig,
  resolveSessionsDir,
  runLocalSubagent,
} from '../sidecars/agents/store.mjs';

function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function writeHookResult(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function parseTrigger(rawInput, state) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  // Explicit single-turn cloud or orchestrator bypass.
  if (/^(?:@|\/)(?:cloud|orchestrator-to-local)(?:\s|$)/i.test(trimmed)) {
    return null;
  }

  // Explicit `@mini-swe` or `/mini-swe` prefix (forces mini-swe-agent harness).
  const miniSweMatch = trimmed.match(/^(?:@|\/)mini-swe(?:-agent)?(?:\s+([\s\S]*))?$/i);
  if (miniSweMatch) {
    return {
      explicit: true,
      isSubagent: true,
      modelRef: state.directChat?.modelId || '',
      prompt: (miniSweMatch[1] || '').trim() || 'Inspect the workspace and summarize what you find.',
      mode: 'intercept',
      harness: 'mini-swe-agent',
    };
  }

  // Explicit `@local-subagent` or `/local-subagent` prefix.
  const subagentMatch = trimmed.match(/^(?:@|\/)local-subagent(?:\s+([\s\S]*))?$/i);
  if (subagentMatch) {
    return {
      explicit: true,
      isSubagent: true,
      modelRef: state.directChat?.modelId || '',
      prompt: (subagentMatch[1] || '').trim() || 'Inspect the workspace and summarize what you find.',
      mode: 'intercept',
    };
  }

  // Explicit `@local` or `/local` prefix.
  const localMatch = trimmed.match(/^(?:@|\/)local(?:\s+([\s\S]*))?$/i);
  if (localMatch) {
    return {
      explicit: true,
      isSubagent: false,
      modelRef: state.directChat?.modelId || '',
      prompt: (localMatch[1] || '').trim() || 'Hello!',
      mode: 'intercept',
    };
  }

  // Explicit `@<modelId|agentName|displayName>` prefix for any added model.
  if (trimmed.startsWith('@')) {
    const spaceIdx = trimmed.search(/\s/);
    const token = (spaceIdx >= 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).trim();
    if (token) {
      const matched = resolveConfiguredModel(token, { strict: true });
      if (matched) {
        const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
        return {
          explicit: true,
          modelRef: matched.modelId,
          prompt: rest || 'Hello!',
          mode: 'intercept',
        };
      }
    }
  }

  // Global Direct Local Chat mode toggle.
  if (state.directChat?.enabled) {
    return {
      explicit: false,
      modelRef: state.directChat.modelId || '',
      prompt: trimmed,
      mode: state.directChat.mode === 'assisted' ? 'assisted' : 'intercept',
    };
  }

  return null;
}

function getAssistedTurnMarkerPath(conversationId) {
  const cleanId = String(conversationId || 'default')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  return join(resolveSessionsDir(), `hook-assisted-${cleanId || 'default'}.json`);
}

function alreadyHandledAssistedTurn(payload, rawInput) {
  const markerPath = getAssistedTurnMarkerPath(payload?.conversationId);
  if (!existsSync(markerPath)) return false;
  try {
    const cached = JSON.parse(readFileSync(markerPath, 'utf-8'));
    return (
      cached.initialNumSteps === payload?.initialNumSteps &&
      cached.lastUserInput === rawInput
    );
  } catch {
    return false;
  }
}

function markAssistedTurnHandled(payload, rawInput) {
  try {
    const markerPath = getAssistedTurnMarkerPath(payload?.conversationId);
    mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      markerPath,
      JSON.stringify({
        initialNumSteps: payload?.initialNumSteps ?? null,
        lastUserInput: rawInput,
        updatedAt: new Date().toISOString(),
      }),
      { encoding: 'utf-8', mode: 0o600 }
    );
  } catch {
    // Non-fatal.
  }
}

async function main() {
  const rawStdin = readStdinSync().trim();
  if (!rawStdin) {
    writeHookResult({});
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawStdin);
  } catch {
    writeHookResult({});
    return;
  }

  const rawInput = String(payload?.lastUserInput || '').trim();
  if (!rawInput) {
    writeHookResult({});
    return;
  }

  const state = readState();
  const trigger = parseTrigger(rawInput, state);
  if (!trigger) {
    writeHookResult({});
    return;
  }

  if (trigger.mode === 'assisted') {
    if (alreadyHandledAssistedTurn(payload, rawInput)) {
      writeHookResult({});
      return;
    }
    markAssistedTurnHandled(payload, rawInput);
  }

  const sessionId = payload?.conversationId
    ? `hook-${payload.conversationId}`
    : 'hook-default';
  const cwd =
    payload?.cwd ||
    (Array.isArray(payload?.workspacePaths) && payload.workspacePaths[0]) ||
    process.cwd();

  const targetModel = trigger.modelRef
    ? resolveConfiguredModel(trigger.modelRef, { strict: false })
    : resolveConfiguredModel();
  const effective = resolveEffectiveAgentConfig(state, targetModel, {
    harness: trigger.harness,
    thinkingLevel: trigger.thinkingLevel,
  });

  try {
    const res = trigger.isSubagent
      ? await runLocalSubagent({
          task: trigger.prompt,
          modelId: trigger.modelRef || undefined,
          cwd,
          sessionId,
          maxSteps: 10,
          timeoutMs: 60000,
          harness: effective.harness,
          thinkingLevel: effective.thinkingLevel,
        })
      : await chatWithModel({
          modelId: trigger.modelRef || undefined,
          prompt: trigger.prompt,
          sessionId,
          autoDiscover: true,
          enableTools: true,
          cwd,
          maxSteps: 10,
          timeoutMs: 60000,
          harness: effective.harness,
          thinkingLevel: effective.thinkingLevel,
        });

    const label = res.displayName || res.model;
    const harnessLabel =
      res.configuredHarness === 'auto' && res.harness
        ? `${res.harness} (auto)`
        : res.harness || effective.harness;
    const thinkingLabel = res.thinkingLevel || effective.thinkingLevel;
    const verboseOn = res.verbose !== undefined ? Boolean(res.verbose) : effective.verbose;
    const header = `**\`${label}\`** *(${trigger.isSubagent ? 'local-subagent · ' : ''}${res.baseUrl} · ${res.latencyMs}ms${trigger.mode === 'assisted' ? ' · assisted' : ''})* [${harnessLabel} · ${thinkingLabel}]`;

    const traceBlock = formatVerboseThinkingMarkdown(res, {
      open: verboseOn,
      includeTools: true,
    });

    if (trigger.mode === 'assisted') {
      const assistedReasoning = res.reasoning
        ? `\n\n[Thinking]:\n${res.reasoning}`
        : '';
      writeHookResult({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: `[Local Model Response from ${res.model} (${res.baseUrl}, ${res.latencyMs}ms)]:${assistedReasoning}\n\n${res.reply}\n\nIncorporate or act on this local model response as needed for the user.`,
              metadata: {
                user_markdown: `${header}${traceBlock}\n\n${res.reply}`,
              },
            },
          },
        ],
        terminationBehavior: '',
      });
      return;
    }

    writeHookResult({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: `[Direct Local Model Response from ${res.model}]:\n${res.reply}`,
            metadata: {
              user_markdown: `${header}${traceBlock}\n\n${res.reply}`,
            },
          },
        },
      ],
      terminationBehavior: 'terminate',
    });
  } catch (err) {
    const notice = `**Local model error** (\`agy-local-agents\`): ${err.message}\n\nMake sure your local inference server is running, or disable Direct Chat (\`direct-chat off\`) / prefix your message with \`@cloud \`.`;
    writeHookResult({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: `[Direct Local Model Error]: ${err.message}`,
            metadata: {
              user_markdown: notice,
            },
          },
        },
      ],
      terminationBehavior: trigger.mode === 'intercept' ? 'terminate' : '',
    });
  }
}

main().catch((err) => {
  process.stderr.write(`[agy-local-agents hook] ${err.message}\n`);
  writeHookResult({});
});
