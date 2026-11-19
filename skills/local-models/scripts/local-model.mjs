#!/usr/bin/env node
/**
 * Zero-dependency CLI helper for `agy-local-agents`.
 *
 * Lets Antigravity agents, subagents, or users call local/custom OpenAI-compatible
 * models directly with Auto harness routing and live stream recording.
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { discoverAntigravityEnvironment } from '../../../sidecars/agents/agentic.mjs';
import {
  HARNESS_CATALOG,
  THINKING_LEVELS,
  addModels,
  chatWithModel,
  createRunId,
  discoverModels,
  getStreamsDir,
  listRecentStreams,
  maskModelForClient,
  normalizeHarness,
  normalizeTaskType,
  normalizeThinkingLevel,
  normalizeUiMode,
  readState,
  readStreamEvents,
  resolveConfiguredModel,
  resolveEffectiveAgentConfig,
  runHybridOrchestration,
  runLocalSubagent,
  scanLocalEndpoints,
  setAgentSettings,
  setDirectChatConfig,
  syncToAgentFiles,
  syncToCustomModelsFile,
  updateModel,
  writeState,
} from '../../../sidecars/agents/store.mjs';

const SUBCOMMANDS = new Set([
  'chat',
  'subagent',
  'stream',
  'env',
  'list',
  'scan',
  'discover',
  'add',
  'default',
  'hybrid',
  'direct-chat',
  'harness',
  'thinking',
  'agent-settings',
  'sync',
  'help',
]);

function parseArgs(argv) {
  const positionals = [];
  const flags = {
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }

    if (token === '-h' || token === '--help') {
      flags.help = true;
      continue;
    }

    let key = token.slice(2);
    let value;
    const eqIdx = key.indexOf('=');
    if (eqIdx >= 0) {
      value = key.slice(eqIdx + 1);
      key = key.slice(0, eqIdx);
    } else if (
      key === 'json' ||
      key === 'reset' ||
      key === 'add-all' ||
      key === 'default' ||
      key === 'no-auto-discover' ||
      key === 'no-tools' ||
      key === 'read-only' ||
      key === 'quiet' ||
      key === 'no-verbose' ||
      key === 'no-stream' ||
      key === 'verbose'
    ) {
      if (key === 'verbose' && i + 1 < argv.length && /^(true|false|on|off|1|0)$/i.test(argv[i + 1])) {
        value = argv[++i];
      } else {
        value = true;
      }
    } else if (i + 1 < argv.length) {
      value = argv[++i];
    } else {
      throw new Error(`Missing value for flag --${key}`);
    }

    if (key === 'file') {
      flags.files.push(String(value));
    } else {
      flags[key] = value;
    }
  }

  return { positionals, flags };
}

function readStdinIfPiped() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf-8').trim();
  } catch {
    return '';
  }
}

function printHelp() {
  console.log(
    [
      'agy-local-agents CLI',
      '',
      'Usage:',
      '  node local-model.mjs chat --prompt "<text>" [--model <id>] [--harness <auto|native|mini-swe-agent>] [--task-type <coding|knowledge>] [--run-id <id>] [--thinking <level>] [--verbose|--quiet] [--no-stream] [--cwd <dir>] [--file <path>] [--session <id>] [--reset] [--system <text>] [--max-steps <n>] [--read-only] [--no-tools] [--temperature <n>] [--max-tokens <n>] [--json]',
      '  node local-model.mjs subagent --task "<text>" [--model <id>] [--harness <auto|native|mini-swe-agent>] [--task-type <coding|knowledge>] [--run-id <id>] [--thinking <level>] [--verbose|--quiet] [--no-stream] [--cwd <dir>] [--file <path>] [--session <id>] [--max-steps <n>] [--read-only] [--json]',
      '  node local-model.mjs stream [list|tail <runId>] [--json]',
      '  node local-model.mjs harness [list|set <auto|native|mini-swe-agent>] [--json]',
      '  node local-model.mjs thinking [list|set <level>] [--json]',
      '  node local-model.mjs agent-settings [status|set] [--harness <id>] [--thinking <level>] [--verbose true|false] [--ui-mode simple|advanced] [--json]',
      '  node local-model.mjs env [--cwd <dir>] [--json]',
      '  node local-model.mjs list [--json]',
      '  node local-model.mjs scan [--json]',
      '  node local-model.mjs discover [--url <baseUrl>] [--key <apiKey>] [--preset <id>] [--add-all] [--json]',
      '  node local-model.mjs add --model <modelId> [--url <baseUrl>] [--name <displayName>] [--key <apiKey>] [--preset <id>] [--default] [--json]',
      '  node local-model.mjs default <modelId> [--json]',
      '  node local-model.mjs hybrid --file <path> [--task "<text>"] [--model <id>] [--json]',
      '  node local-model.mjs direct-chat [status|on|off] [--model <id>] [--mode intercept|assisted] [--json]',
      '  node local-model.mjs sync [--json]',
    ].join('\n')
  );
}

function parseHarnessFlag(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'inherit') return undefined;
  const normalized = normalizeHarness(trimmed, '');
  if (!normalized) {
    const valid = HARNESS_CATALOG.map((h) => h.id).join(', ');
    throw new Error(`Invalid --harness "${raw}". Valid options: ${valid}`);
  }
  return normalized;
}

function parseThinkingFlag(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'inherit') return undefined;
  const normalized = normalizeThinkingLevel(trimmed, '');
  if (!normalized) {
    const valid = THINKING_LEVELS.map((t) => t.id).join(', ');
    throw new Error(`Invalid --thinking "${raw}". Valid options: ${valid}`);
  }
  return normalized;
}

function parseTaskTypeFlag(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') return undefined;
  const normalized = normalizeTaskType(trimmed);
  if (!normalized) {
    throw new Error(`Invalid --task-type "${raw}". Valid options: coding, knowledge`);
  }
  return normalized;
}

function printToolTrace(toolTrace) {
  if (!Array.isArray(toolTrace) || toolTrace.length === 0) return;
  for (const t of toolTrace) {
    const argsStr = typeof t.args === 'string' ? t.args : JSON.stringify(t.args || {});
    console.log(
      `[Step ${t.step}] ${t.tool}(${argsStr.slice(0, 120)}) -> ${t.ok ? 'ok' : 'error'} (${t.durationMs}ms)`
    );
  }
  console.log('');
}

function parseVerboseFlag(flags, fallbackVerbose = true) {
  if (flags.quiet || flags['no-verbose']) return false;
  if (flags.verbose === undefined) return fallbackVerbose;
  if (typeof flags.verbose === 'boolean') return flags.verbose;
  const lower = String(flags.verbose).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(lower)) return false;
  return true;
}

function createVerboseCliReporter(enabled, modeLabel = 'local-model', runId = '') {
  if (!enabled) {
    return { onEvent: null, printResult: null };
  }
  let started = false;
  let thinkingOpen = false;
  let responseOpen = false;
  let lastCharNewline = true;
  let currentStep = 0;
  let streamedStep = 0;
  let streamedContentThisStep = false;

  const closeOpenSection = () => {
    if (thinkingOpen || responseOpen) {
      if (!lastCharNewline) process.stdout.write('\n');
      thinkingOpen = false;
      responseOpen = false;
      lastCharNewline = true;
    }
  };

  const ensureHeader = (meta) => {
    if (started) return;
    started = true;
    const parts = [modeLabel];
    if (runId || meta.runId) parts.push(`runId=${runId || meta.runId}`);
    const hLabel = meta.harnessAutoReason
      ? `${meta.harness} (${meta.harnessAutoReason})`
      : meta.harness;
    parts.push(`harness=${hLabel}`);
    parts.push('verbose=on');
    process.stdout.write(`[${parts.join(' | ')}]\n`);
  };

  const onEvent = (ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'harness_resolved') {
      ensureHeader(ev);
      return;
    }
    if (ev.type === 'step_start') {
      ensureHeader(ev);
      closeOpenSection();
      currentStep = Number(ev.step) || currentStep + 1;
      streamedContentThisStep = false;
      process.stdout.write(`\n--- Step ${ev.step}/${ev.maxSteps} ---\n`);
      return;
    }
    if (ev.type === 'thinking_delta' && ev.text) {
      if (responseOpen) closeOpenSection();
      if (!thinkingOpen) {
        process.stdout.write('[Thinking]\n');
        thinkingOpen = true;
      }
      process.stdout.write(ev.text);
      lastCharNewline = ev.text.endsWith('\n');
      return;
    }
    if (ev.type === 'content_delta' && ev.text) {
      if (thinkingOpen) closeOpenSection();
      if (!responseOpen) {
        process.stdout.write('[Response]\n');
        responseOpen = true;
      }
      process.stdout.write(ev.text);
      lastCharNewline = ev.text.endsWith('\n');
      streamedContentThisStep = true;
      streamedStep = Number(ev.step) || currentStep;
      return;
    }
    if (ev.type === 'assistant_note' && ev.text) {
      closeOpenSection();
      if (!streamedContentThisStep) {
        process.stdout.write(`[Thought]\n${ev.text}\n`);
      }
      return;
    }
    if (ev.type === 'tool_start') {
      closeOpenSection();
      streamedContentThisStep = false;
      const argsStr = typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args || {});
      process.stdout.write(`-> Tool: ${ev.tool}(${argsStr.slice(0, 140)})\n`);
      return;
    }
    if (ev.type === 'tool_end') {
      closeOpenSection();
      streamedContentThisStep = false;
      const preview = ev.preview ? ` | ${String(ev.preview).replace(/\s+/g, ' ').slice(0, 140)}` : '';
      process.stdout.write(
        `<- Result (${ev.ok ? 'ok' : 'error'}, ${ev.durationMs}ms)${preview}\n`
      );
    }
  };

  const printResult = (out, metaParts) => {
    closeOpenSection();
    const alreadyStreamedFinal =
      streamedContentThisStep && streamedStep === (out.stepsUsed || currentStep);
    if (!alreadyStreamedFinal) {
      process.stdout.write(`\n=== Answer ===\n${out.reply || ''}\n`);
    } else {
      process.stdout.write(`\n=== Answer ===\n(streamed above)\n`);
    }
    const hSuffix = out.harnessAutoReason ? ` (${out.harnessAutoReason})` : '';
    process.stdout.write(
      `\n[${metaParts.join(' · ')}] [harness=${out.harness || 'native'}${hSuffix}, thinking=${out.thinkingLevel || 'auto'}, verbose=on]\n`
    );
  };

  return { onEvent, printResult };
}

function printOutput(data, asJson, formatter) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    formatter(data);
  }
}

async function run() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positionals[0] === 'help') {
    printHelp();
    return;
  }

  let cmd = flags.task ? 'subagent' : 'chat';
  let restPositionals = positionals;
  if (positionals.length > 0 && SUBCOMMANDS.has(positionals[0])) {
    cmd = positionals[0];
    restPositionals = positionals.slice(1);
  } else if (positionals.length === 0 && !flags.prompt && !flags.task) {
    printHelp();
    return;
  }

  const asJson = Boolean(flags.json);

  switch (cmd) {
    case 'list': {
      const state = readState();
      const models = (state.models || []).map(maskModelForClient);
      const agentSettings = state.agentSettings || {
        harness: 'auto',
        thinkingLevel: 'auto',
        verbose: true,
        uiMode: 'simple',
      };
      const result = {
        activeEndpoint: {
          preset: state.activeEndpoint.preset,
          baseUrl: state.activeEndpoint.baseUrl,
          hasApiKey: Boolean(state.activeEndpoint.apiKey),
        },
        directChat: state.directChat,
        agentSettings,
        harnesses: HARNESS_CATALOG,
        thinkingLevels: THINKING_LEVELS,
        total: models.length,
        models,
      };
      printOutput(result, asJson, (out) => {
        console.log(
          `Direct Chat: ${out.directChat.enabled ? `ON (${out.directChat.mode}${out.directChat.modelId ? ` · ${out.directChat.modelId}` : ' · default'})` : 'OFF'}`
        );
        console.log(
          `Agent Settings: [harness=${out.agentSettings.harness}, thinking=${out.agentSettings.thinkingLevel}, uiMode=${out.agentSettings.uiMode || 'simple'}]`
        );
        if (out.models.length === 0) {
          console.log('No added models configured yet. Run `scan` or `discover --url ... --add-all`.');
          return;
        }
        for (const m of out.models) {
          const eff = resolveEffectiveAgentConfig(state, m);
          const tags = [
            m.isDefault ? 'default' : null,
            m.enabled ? 'enabled' : 'disabled',
            m.agentName ? `Main Agent > ${m.agentName}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          console.log(
            `- ${m.displayName || m.modelId} (${m.modelId}) @ ${m.baseUrl} [${tags}] [harness=${eff.harness}, thinking=${eff.thinkingLevel}]`
          );
        }
      });
      return;
    }

    case 'stream': {
      const subAction = (restPositionals[0] || 'list').toLowerCase();
      const streamsDir = getStreamsDir();
      if (subAction === 'tail') {
        const targetId = restPositionals[1] || flags['run-id'] || flags.runId;
        if (!targetId) throw new Error('Run ID is required for `stream tail <runId>`.');
        let cursor = 0;
        const start = Date.now();
        while (Date.now() - start < 300000) {
          const res = readStreamEvents({ streamsDir, runId: targetId, cursor });
          cursor = res.nextCursor;
          for (const ev of res.events) {
            if (asJson) {
              console.log(JSON.stringify(ev));
            } else if (ev.type === 'thinking_delta' || ev.type === 'content_delta') {
              process.stdout.write(ev.text || '');
            } else if (ev.type === 'tool_start') {
              console.log(`\n-> Tool: ${ev.tool}`);
            } else if (ev.type === 'tool_end') {
              console.log(`<- Result (${ev.ok ? 'ok' : 'err'}, ${ev.durationMs}ms)`);
            } else if (ev.type === 'step_start') {
              console.log(`\n--- Step ${ev.step}/${ev.maxSteps} ---`);
            }
          }
          if (res.status === 'done' || res.status === 'error' || res.status === 'stale') {
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return;
      }

      const runs = listRecentStreams({ streamsDir, limit: 15 });
      printOutput({ runs }, asJson, ({ runs: list }) => {
        if (!list.length) {
          console.log('No recorded local agent streams yet.');
          return;
        }
        for (const r of list) {
          console.log(
            `- ${r.runId} [${r.status}] ${r.displayName || r.model} (${r.harness}) · ${r.task?.slice(0, 60) || ''}`
          );
        }
      });
      return;
    }

    case 'scan': {
      const endpoints = await scanLocalEndpoints();
      printOutput({ endpoints }, asJson, ({ endpoints: eps }) => {
        if (!eps.length) {
          console.log('No reachable local OpenAI-compatible servers found on ports 11434, 1234, 8000, 8080, 5000.');
          return;
        }
        for (const ep of eps) {
          console.log(`- ${ep.label} (${ep.preset}): ${ep.baseUrl} (${ep.modelCount} models)`);
        }
      });
      return;
    }

    case 'discover': {
      const state = readState();
      const baseUrl = flags.url || state.activeEndpoint.baseUrl;
      const apiKey = flags.key ?? state.activeEndpoint.apiKey ?? '';
      const preset = flags.preset || state.activeEndpoint.preset || '';
      const disc = await discoverModels({ baseUrl, apiKey, preset });

      let addedSummary = null;
      if (flags['add-all'] && disc.models.length > 0) {
        const res = addModels(disc.models, {
          endpointOverrides: {
            baseUrl: disc.resolvedBaseUrl,
            apiKey,
            preset: disc.preset,
          },
        });
        addedSummary = {
          added: res.added.length,
          updated: res.updated.length,
          total: res.state.models.length,
        };
      }

      printOutput({ ...disc, addedSummary }, asJson, (out) => {
        console.log(`Discovered ${out.total} model(s) at ${out.resolvedBaseUrl} (${out.preset}):`);
        for (const m of out.models) {
          console.log(`- ${m.id}${m.parameterSize ? ` (${m.parameterSize})` : ''}`);
        }
        if (out.addedSummary) {
          console.log(
            `Synced to Antigravity: ${out.addedSummary.added} added, ${out.addedSummary.updated} updated (${out.addedSummary.total} total).`
          );
        }
      });
      return;
    }

    case 'add': {
      const modelId = flags.model || restPositionals[0];
      if (!modelId) {
        throw new Error('Model ID is required. Example: add --model llama3.2 --url http://localhost:11434/v1');
      }
      const res = addModels([
        {
          modelId,
          displayName: flags.name || modelId,
          baseUrl: flags.url,
          apiKey: flags.key,
          preset: flags.preset,
          isDefault: Boolean(flags.default),
        },
      ]);
      printOutput(res, asJson, (out) => {
        const item = out.added[0] || out.updated[0];
        console.log(
          `${out.added.length ? 'Added' : 'Updated'} ${item.displayName || item.modelId} (${item.modelId}) @ ${item.baseUrl} -> Main Agent > ${item.agentName}`
        );
      });
      return;
    }

    case 'default': {
      const target = flags.model || restPositionals[0];
      if (!target) {
        throw new Error('Model ID or name is required for `default`.');
      }
      const resolved = resolveConfiguredModel(target, { strict: true });
      if (!resolved) {
        throw new Error(`Model not found: ${target}`);
      }
      const res = updateModel(resolved.id, { isDefault: true });
      printOutput(res, asJson, (out) => {
        console.log(
          `Default model set to ${out.model.displayName || out.model.modelId} (${out.model.modelId}) -> Main Agent > ${out.model.agentName}`
        );
      });
      return;
    }

    case 'hybrid': {
      const targetFile = flags.file || flags.files[0] || restPositionals[0];
      if (!targetFile) {
        throw new Error('Target file is required. Example: hybrid --file path/to/file.py --task "Fix bug"');
      }
      const absFile = resolve(targetFile);
      const sourceCode = readFileSync(absFile, 'utf-8');
      const res = await runHybridOrchestration({
        modelId: flags.model,
        fileName: basename(absFile),
        sourceCode,
        task: flags.task,
      });
      printOutput(res, asJson, (out) => {
        console.log(`[Hybrid Orchestrator · ${out.model} · ${out.localTokens} local tokens]`);
        console.log(`Skeleton: ${out.skeleton}`);
        console.log(`Blind Critic Verdict: ${out.criticVerdict}`);
        console.log(`\n--- Winner (${out.winner.builder}) ---\n${out.winner.code}`);
      });
      return;
    }

    case 'direct-chat': {
      const action = (restPositionals[0] || 'status').toLowerCase();
      if (!['status', 'on', 'off'].includes(action)) {
        throw new Error(`Invalid direct-chat action "${action}". Use status, on, or off.`);
      }
      let res;
      if (action === 'status' && !flags.model && !flags.mode) {
        const state = readState();
        res = { directChat: state.directChat, models: state.models.map(maskModelForClient) };
      } else {
        const enabled = action === 'on' ? true : action === 'off' ? false : undefined;
        res = setDirectChatConfig({
          enabled,
          modelId: flags.model,
          mode: flags.mode,
        });
      }
      printOutput(res, asJson, (out) => {
        const dc = out.directChat;
        console.log(
          `Direct Local Chat: ${dc.enabled ? 'ENABLED' : 'DISABLED'} (mode=${dc.mode}, model=${dc.modelId || 'default'})`
        );
      });
      return;
    }

    case 'harness': {
      const subAction = restPositionals[0] ? restPositionals[0].toLowerCase() : '';
      const explicitValue =
        subAction === 'set'
          ? restPositionals[1] ?? flags.harness
          : subAction && subAction !== 'list' && subAction !== 'status'
            ? restPositionals[0]
            : flags.harness;

      if (subAction === 'set' && (explicitValue === undefined || explicitValue === true)) {
        const valid = HARNESS_CATALOG.map((h) => h.id).join(', ');
        throw new Error(`Harness id is required for \`harness set\`. Valid options: ${valid}`);
      }

      if (explicitValue !== undefined && explicitValue !== true) {
        const res = setAgentSettings({ harness: explicitValue });
        const output = {
          agentSettings: res.agentSettings,
          harnesses: HARNESS_CATALOG,
        };
        printOutput(output, asJson, (out) => {
          console.log(
            `Default harness set to ${out.agentSettings.harness} [harness=${out.agentSettings.harness}, thinking=${out.agentSettings.thinkingLevel}]`
          );
        });
        return;
      }

      const state = readState();
      const agentSettings = state.agentSettings || { harness: 'auto', thinkingLevel: 'auto' };
      const output = {
        agentSettings,
        harnesses: HARNESS_CATALOG,
      };
      printOutput(output, asJson, (out) => {
        console.log(
          `Active Harness: ${out.agentSettings.harness} [harness=${out.agentSettings.harness}, thinking=${out.agentSettings.thinkingLevel}]`
        );
        for (const h of out.harnesses) {
          const marker = h.id === out.agentSettings.harness ? '*' : ' ';
          console.log(`  ${marker} ${h.id} (${h.label}): ${h.description}`);
        }
      });
      return;
    }

    case 'thinking': {
      const subAction = restPositionals[0] ? restPositionals[0].toLowerCase() : '';
      const flagVal = flags.thinking ?? flags['thinking-level'];
      const explicitValue =
        subAction === 'set'
          ? restPositionals[1] ?? flagVal
          : subAction && subAction !== 'list' && subAction !== 'status'
            ? restPositionals[0]
            : flagVal;

      if (subAction === 'set' && (explicitValue === undefined || explicitValue === true)) {
        const valid = THINKING_LEVELS.map((t) => t.id).join(', ');
        throw new Error(`Thinking level is required for \`thinking set\`. Valid options: ${valid}`);
      }

      if (explicitValue !== undefined && explicitValue !== true) {
        const res = setAgentSettings({ thinkingLevel: explicitValue });
        const output = {
          agentSettings: res.agentSettings,
          thinkingLevels: THINKING_LEVELS,
        };
        printOutput(output, asJson, (out) => {
          console.log(
            `Default thinking level set to ${out.agentSettings.thinkingLevel} [harness=${out.agentSettings.harness}, thinking=${out.agentSettings.thinkingLevel}]`
          );
        });
        return;
      }

      const state = readState();
      const agentSettings = state.agentSettings || { harness: 'auto', thinkingLevel: 'auto' };
      const output = {
        agentSettings,
        thinkingLevels: THINKING_LEVELS,
      };
      printOutput(output, asJson, (out) => {
        console.log(
          `Active Thinking Level: ${out.agentSettings.thinkingLevel} [harness=${out.agentSettings.harness}, thinking=${out.agentSettings.thinkingLevel}]`
        );
        for (const lvl of out.thinkingLevels) {
          const marker = lvl.id === out.agentSettings.thinkingLevel ? '*' : ' ';
          console.log(`  ${marker} ${lvl.id} (${lvl.label}): ${lvl.description}`);
        }
      });
      return;
    }

    case 'agent-settings': {
      const subAction = (restPositionals[0] || 'status').toLowerCase();
      if (!['status', 'list', 'set'].includes(subAction)) {
        throw new Error(`Invalid agent-settings action "${subAction}". Use status or set.`);
      }
      const nextHarness = flags.harness;
      const nextThinking = flags.thinking ?? flags['thinking-level'];
      const nextVerbose = flags.quiet || flags['no-verbose'] ? false : flags.verbose;
      const nextUiMode = flags['ui-mode'] ?? flags.uiMode;
      const nextMaxLoops = flags['max-thinking-loops'] ?? flags['max-loops'] ?? flags.maxThinkingLoops;
      const hasUpdate =
        subAction === 'set' ||
        nextHarness !== undefined ||
        nextThinking !== undefined ||
        nextVerbose !== undefined ||
        nextUiMode !== undefined ||
        nextMaxLoops !== undefined;

      if (
        hasUpdate &&
        nextHarness === undefined &&
        nextThinking === undefined &&
        nextVerbose === undefined &&
        nextUiMode === undefined &&
        nextMaxLoops === undefined
      ) {
        throw new Error(
          'Provide --harness <id>, --thinking <level>, --verbose <true|false>, --max-loops <1-50>, and/or --ui-mode <simple|advanced> with `agent-settings set`.'
        );
      }

      const agentSettings = hasUpdate
        ? setAgentSettings({
            harness: nextHarness,
            thinkingLevel: nextThinking,
            verbose: nextVerbose,
            uiMode: nextUiMode !== undefined ? normalizeUiMode(String(nextUiMode), String(nextUiMode)) : undefined,
            maxThinkingLoops: nextMaxLoops !== undefined ? Number(nextMaxLoops) : undefined,
          }).agentSettings
        : readState().agentSettings || {
            harness: 'auto',
            thinkingLevel: 'auto',
            verbose: true,
            uiMode: 'simple',
            maxThinkingLoops: 10,
          };

      const output = {
        agentSettings,
        harnesses: HARNESS_CATALOG,
        thinkingLevels: THINKING_LEVELS,
      };
      printOutput(output, asJson, (out) => {
        console.log(
          `Agent Settings: [harness=${out.agentSettings.harness}, thinking=${out.agentSettings.thinkingLevel}, verbose=${out.agentSettings.verbose === false ? 'off' : 'on'}, maxThinkingLoops=${out.agentSettings.maxThinkingLoops || 10}, uiMode=${out.agentSettings.uiMode || 'simple'}]`
        );
      });
      return;
    }

    case 'sync': {
      const state = readState();
      const customSync = syncToCustomModelsFile(state);
      const agentSync = syncToAgentFiles(state);
      writeState(state, { syncCustomModels: false, syncAgents: false });
      const result = { customModels: customSync, agents: agentSync };
      printOutput(result, asJson, (out) => {
        console.log(`Synced custom_models.json: ${out.customModels.count ?? 0} model(s) -> ${out.customModels.path}`);
        console.log(`Synced Main Agent files (${out.agents.files.length}): ${out.agents.files.join(', ')}`);
      });
      return;
    }

    case 'env': {
      const env = discoverAntigravityEnvironment({ cwd: flags.cwd || process.cwd() });
      printOutput(env, asJson, (out) => {
        console.log(`Workspace cwd: ${out.cwd}`);
        console.log(`Skills (${out.skills.length}): ${out.skills.map((s) => s.name).join(', ')}`);
        console.log(`Rules (${out.rules.length}): ${out.rules.map((r) => r.path).join(', ') || 'none'}`);
        console.log(
          `MCP Servers (${out.mcpServers.length}): ${out.mcpServers.map((m) => m.name).join(', ') || 'none'}`
        );
      });
      return;
    }

    case 'subagent': {
      let task = flags.task || flags.prompt;
      if (task === '-') {
        task = readStdinIfPiped();
      } else if (!task && restPositionals.length > 0) {
        task = restPositionals.join(' ');
      } else if (!task) {
        task = readStdinIfPiped();
      }
      if (!task) {
        throw new Error('A task is required. Example: subagent --task "Inspect tests and summarize"');
      }

      const harness = parseHarnessFlag(flags.harness);
      const taskType = parseTaskTypeFlag(flags['task-type'] ?? flags.taskType);
      const thinkingLevel = parseThinkingFlag(flags.thinking ?? flags['thinking-level']);
      const runId = flags['run-id'] ?? flags.runId ?? createRunId('sub');
      const curState = readState();
      const targetModel = flags.model ? resolveConfiguredModel(flags.model) : resolveConfiguredModel();
      const effCfg = resolveEffectiveAgentConfig(curState, targetModel, { harness, thinkingLevel });
      const verbose = parseVerboseFlag(flags, effCfg.verbose);
      const reporter = createVerboseCliReporter(!asJson && verbose, 'local-subagent', runId);

      const rawSubLoops = flags['max-thinking-loops'] ?? flags['max-loops'] ?? flags['max-steps'];
      const res = await runLocalSubagent({
        task,
        modelId: flags.model,
        cwd: flags.cwd || process.cwd(),
        files: flags.files,
        systemPrompt: flags.system,
        maxThinkingLoops: rawSubLoops !== undefined ? Number(rawSubLoops) : undefined,
        allowWrite: !flags['read-only'],
        sessionId: flags.session,
        harness,
        taskType,
        thinkingLevel,
        verbose,
        runId,
        stream: flags['no-stream'] ? false : true,
        onEvent: reporter.onEvent,
      });

      printOutput(res, asJson, (out) => {
        const metaParts = [
          `local-subagent`,
          out.model,
          `${out.latencyMs}ms`,
          `${out.stepsUsed || 1} step(s)`,
          out.toolTrace?.length ? `${out.toolTrace.length} tool call(s)` : null,
          out.sessionId ? `session=${out.sessionId}` : null,
          out.runId ? `runId=${out.runId}` : null,
        ].filter(Boolean);
        if (reporter.printResult) {
          reporter.printResult(out, metaParts);
          return;
        }
        console.log(
          `[${metaParts.join(' · ')}] [harness=${out.harness || 'native'}${out.harnessAutoReason ? ` (${out.harnessAutoReason})` : ''}, thinking=${out.thinkingLevel || 'auto'}]\n`
        );
        printToolTrace(out.toolTrace);
        console.log(out.reply);
      });
      return;
    }

    case 'chat':
    default: {
      let prompt = flags.prompt;
      if (prompt === '-') {
        prompt = readStdinIfPiped();
      } else if (!prompt && restPositionals.length > 0) {
        prompt = restPositionals.join(' ');
      } else if (!prompt) {
        prompt = readStdinIfPiped();
      }
      if (!prompt) {
        throw new Error('A prompt is required. Example: chat --prompt "Explain this function"');
      }

      const harness = parseHarnessFlag(flags.harness);
      const taskType = parseTaskTypeFlag(flags['task-type'] ?? flags.taskType);
      const thinkingLevel = parseThinkingFlag(flags.thinking ?? flags['thinking-level']);
      const runId = flags['run-id'] ?? flags.runId ?? createRunId('chat');
      const curState = readState();
      const targetModel = flags.model ? resolveConfiguredModel(flags.model) : resolveConfiguredModel();
      const effCfg = resolveEffectiveAgentConfig(curState, targetModel, { harness, thinkingLevel });
      const verbose = parseVerboseFlag(flags, effCfg.verbose);
      const reporter = createVerboseCliReporter(!asJson && verbose, 'local-model', runId);

      const rawChatLoops = flags['max-thinking-loops'] ?? flags['max-loops'] ?? flags['max-steps'];
      const res = await chatWithModel({
        modelId: flags.model,
        baseUrl: flags.url,
        apiKey: flags.key,
        prompt,
        systemPrompt: flags.system,
        files: flags.files,
        sessionId: flags.session,
        resetSession: Boolean(flags.reset),
        autoDiscover: !flags['no-auto-discover'],
        enableTools: !flags['no-tools'],
        cwd: flags.cwd || process.cwd(),
        maxThinkingLoops: rawChatLoops !== undefined ? Number(rawChatLoops) : undefined,
        allowWrite: !flags['read-only'],
        temperature: flags.temperature !== undefined ? Number(flags.temperature) : 0.2,
        maxTokens: flags['max-tokens'] !== undefined ? Number(flags['max-tokens']) : undefined,
        harness,
        taskType,
        thinkingLevel,
        verbose,
        runId,
        stream: flags['no-stream'] ? false : true,
        onEvent: reporter.onEvent,
      });

      printOutput(res, asJson, (out) => {
        const metaParts = [
          out.model,
          `${out.latencyMs}ms`,
          out.stepsUsed > 1 ? `${out.stepsUsed} steps` : null,
          out.toolTrace?.length ? `${out.toolTrace.length} tool call(s)` : null,
          out.autoDiscovered ? 'auto-discovered' : null,
          out.sessionId ? `session=${out.sessionId}` : null,
          out.runId ? `runId=${out.runId}` : null,
        ].filter(Boolean);
        if (reporter.printResult) {
          reporter.printResult(out, metaParts);
          return;
        }
        console.log(
          `[${metaParts.join(' · ')}] [harness=${out.harness || 'native'}${out.harnessAutoReason ? ` (${out.harnessAutoReason})` : ''}, thinking=${out.thinkingLevel || 'auto'}]\n`
        );
        printToolTrace(out.toolTrace);
        console.log(out.reply);
      });
      return;
    }
  }
}

run().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
