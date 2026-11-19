/**
 * Bundled MCP stdio server for agy-local-agents.
 *
 * Exposes tools for Antigravity agents & subagents to list, discover, add,
 * remove, chat with, watch live streams, and run hybrid orchestration on
 * user-configured OpenAI-compatible models, plus an inline MCP App (`ui://`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_CATALOG,
  THINKING_LEVELS,
  addModels,
  chatWithModel,
  createRunId,
  discoverModels,
  findMatchingStreamRun,
  getStreamsDir,
  listRecentStreams,
  maskModelForClient,
  readState,
  readStreamEvents,
  removeModel,
  runHybridOrchestration,
  runLocalSubagent,
  scanLocalEndpoints,
  setAgentSettings,
  setDirectChatConfig,
} from '../sidecars/agents/store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STREAM_APP_HTML_PATH = join(__dirname, 'stream-app.html');
const STREAM_APP_URI = 'ui://agy-local-agents/stream.html';
const STREAM_APP_MIME = 'text/html;profile=mcp-app';

const SERVER_INFO = {
  name: 'agy-local-agents',
  version: '0.2.0',
};

const STREAM_UI_META = {
  ui: { resourceUri: STREAM_APP_URI },
  'ui/resourceUri': STREAM_APP_URI,
};

const TOOLS = [
  {
    name: 'agy_local_list',
    description:
      'List all OpenAI-compatible models added to Antigravity via agy-local-agents, including active endpoint, default model, agentSettings, harnesses, and recent streams.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: {
          type: 'boolean',
          description: 'Include disabled models in the result (default true).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_discover',
    description:
      'Query an OpenAI-compatible base URL (with optional Bearer API key) for available models via /models, or scan local ports when scanLocal is true.',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: {
          type: 'string',
          description: 'OpenAI-compatible base URL (e.g. http://localhost:11434/v1).',
        },
        apiKey: {
          type: 'string',
          description: 'Optional Bearer API key.',
        },
        preset: {
          type: 'string',
          description: 'Optional preset id (ollama, lmstudio, vllm, openrouter, openai, custom).',
        },
        scanLocal: {
          type: 'boolean',
          description: 'If true, scan common localhost OpenAI ports before/instead of querying.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_add',
    description:
      'Add one or more OpenAI-compatible models to the Antigravity model list and sync to custom_models.json.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: {
          type: 'string',
          description: 'Exact model identifier on the upstream OpenAI-compatible endpoint.',
        },
        displayName: {
          type: 'string',
          description: 'Optional human-friendly label.',
        },
        baseUrl: {
          type: 'string',
          description: 'OpenAI-compatible base URL. Defaults to active endpoint URL.',
        },
        apiKey: {
          type: 'string',
          description: 'Optional API key for this model/endpoint.',
        },
        preset: {
          type: 'string',
          description: 'Optional provider preset (ollama, lmstudio, vllm, openrouter, openai, custom).',
        },
        contextWindow: {
          type: 'integer',
          description: 'Context window size in tokens (default 32768).',
        },
        maxOutputTokens: {
          type: 'integer',
          description: 'Max output tokens (default 4096).',
        },
        isDefault: {
          type: 'boolean',
          description: 'Set as the default added model.',
        },
      },
      required: ['modelId'],
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_remove',
    description:
      'Remove an added model from the Antigravity model list by id, modelId, or customModelName.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Model id, modelId, or customModelName to remove.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_chat',
    description:
      'Send a prompt or task to an added OpenAI-compatible model with inline live streaming in chat. Supports Auto harness routing via taskType ("coding" -> mini-SWE, "knowledge" -> Native).',
    _meta: STREAM_UI_META,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Task or prompt to send to the model.',
        },
        model: {
          type: 'string',
          description: 'Added model id, modelId, agentName, or displayName. Omit to use default model.',
        },
        taskType: {
          type: 'string',
          enum: ['coding', 'knowledge'],
          description: 'Task classification for Auto harness routing ("coding" uses mini-SWE, "knowledge" uses Native).',
        },
        runId: {
          type: 'string',
          description: 'Optional stable run identifier (e.g. "local-subagent-1", "local-subagent-2" for multi-agent monitor & live stream tracking).',
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system instruction.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional local/workspace file paths to attach as context.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to preserve multi-turn conversation history.',
        },
        resetSession: {
          type: 'boolean',
          description: 'If true, clears any existing history for sessionId before sending.',
        },
        autoDiscover: {
          type: 'boolean',
          description: 'If true (default), automatically scans local ports when no models are configured yet.',
        },
        enableTools: {
          type: 'boolean',
          description: 'If true (default), grants the local model workspace file/command tools, Antigravity skills, rules, and MCP servers.',
        },
        cwd: {
          type: 'string',
          description: 'Workspace working directory for tool execution and skill/rule discovery.',
        },
        maxSteps: {
          type: 'integer',
          description: 'Alias for maxThinkingLoops. Omit on direct calls to follow agentSettings.maxThinkingLoops.',
        },
        maxThinkingLoops: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max thinking/tool loops (1-50). Omit on direct calls to follow agentSettings.maxThinkingLoops.',
        },
        allowWrite: {
          type: 'boolean',
          description: 'Allow write_file, edit_file, and run_command (default true).',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature (default 0.2).',
        },
        maxTokens: {
          type: 'integer',
          description: 'Maximum tokens to generate.',
        },
        harness: {
          type: 'string',
          enum: HARNESS_CATALOG.map((h) => h.id),
          description: 'Optional harness override ("auto", "native", or "mini-swe-agent").',
        },
        thinkingLevel: {
          type: 'string',
          enum: THINKING_LEVELS.map((t) => t.id),
          description: 'Optional reasoning/thinking level override.',
        },
        verbose: {
          type: 'boolean',
          description: 'Include full per-step thinking trace in output (default true).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_subagent',
    description:
      'Run an autonomous local subagent task with inline live streaming in chat and full access to Antigravity skills, workspace tools, rules, and MCP servers. Pass taskType ("coding" or "knowledge") for Auto harness routing.',
    _meta: STREAM_UI_META,
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Autonomous task or goal for the local subagent.',
        },
        model: {
          type: 'string',
          description: 'Added model id, modelId, agentName, or displayName (defaults to default added model).',
        },
        taskType: {
          type: 'string',
          enum: ['coding', 'knowledge'],
          description: 'Subtask classification for Auto harness routing ("coding" -> mini-SWE, "knowledge" -> Native).',
        },
        runId: {
          type: 'string',
          description: 'Optional stable run identifier (e.g. "local-subagent-1", "local-subagent-2" for multi-agent monitor & live stream tracking).',
        },
        cwd: {
          type: 'string',
          description: 'Workspace working directory for tool execution and skill/rule discovery.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional files to attach to the initial subagent prompt.',
        },
        maxSteps: {
          type: 'integer',
          description: 'Alias for maxThinkingLoops.',
        },
        maxThinkingLoops: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max thinking/tool loops (1-50). When called by an orchestrator, set based on task complexity (e.g. 2-4 simple lookup, 5-10 moderate, 10-20 complex coding). When omitted (direct call), follows agentSettings.maxThinkingLoops.',
        },
        allowWrite: {
          type: 'boolean',
          description: 'Allow write_file, edit_file, and run_command (default true).',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier to preserve multi-turn subagent memory.',
        },
        harness: {
          type: 'string',
          enum: HARNESS_CATALOG.map((h) => h.id),
          description: 'Optional harness override ("auto", "native", or "mini-swe-agent").',
        },
        thinkingLevel: {
          type: 'string',
          enum: THINKING_LEVELS.map((t) => t.id),
          description: 'Optional thinking level override.',
        },
        verbose: {
          type: 'boolean',
          description: 'Include full per-step thinking trace in output (default true).',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_stream_watch',
    description:
      'Attach the live-streaming chat viewer to one or more background local-model CLI runs (`node local-model.mjs --run-id ...`) so tokens, thinking, and tools stream live inline in chat.',
    _meta: STREAM_UI_META,
    inputSchema: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'Single run ID passed via `--run-id` to local-model.mjs.',
        },
        runIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple run IDs for watching parallel local subagents in one view.',
        },
        title: {
          type: 'string',
          description: 'Optional label for the watched run(s).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_agent_settings',
    description:
      'Inspect or update global defaults: harness ("auto", "native", "mini-swe-agent"), thinkingLevel, verbose thinking, maxThinkingLoops (1-50 for direct calls), and uiMode ("simple" | "advanced").',
    inputSchema: {
      type: 'object',
      properties: {
        harness: {
          type: 'string',
          enum: HARNESS_CATALOG.map((h) => h.id),
          description: 'Global default harness ("auto", "native", or "mini-swe-agent").',
        },
        thinkingLevel: {
          type: 'string',
          enum: THINKING_LEVELS.map((t) => t.id),
          description: 'Global default thinking level.',
        },
        verbose: {
          type: 'boolean',
          description: 'Display full per-step thinking in chat and CLI (default true).',
        },
        maxThinkingLoops: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max thinking/tool loops (1-50) used when a local model or subagent is called directly without an orchestrator override.',
        },
        uiMode: {
          type: 'string',
          enum: ['simple', 'advanced'],
          description: 'Sidecar UI mode ("simple" or "advanced").',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_hybrid_orchestrate',
    description:
      'Run the Hybrid Orchestrator workflow (zero-body AST public skeleton + minimal vs. defensive dual builders + blind critic verdict) using an added OpenAI-compatible model.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceCode: {
          type: 'string',
          description: 'Source code snippet or file contents to audit/remediate.',
        },
        fileName: {
          type: 'string',
          description: 'Filename for skeleton extraction (e.g. billing.py).',
        },
        task: {
          type: 'string',
          description: 'Remediation or refactoring goal.',
        },
        model: {
          type: 'string',
          description: 'Added model id or modelId (defaults to default added model).',
        },
      },
      required: ['sourceCode'],
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_direct_chat',
    description:
      'Enable or disable Direct Local Chat mode (routes user chat messages directly to the selected local model via PreInvocation hook) or change target local model.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Whether Direct Local Chat mode is enabled.',
        },
        model: {
          type: 'string',
          description: 'Target added model id, modelId, agentName, or displayName (empty string uses default model).',
        },
        mode: {
          type: 'string',
          enum: ['intercept', 'assisted'],
          description: '"intercept" responds directly without calling a cloud LLM; "assisted" passes the local response to the active agent.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_local_stream_poll',
    description: 'Internal app-only tool used by the live-streaming chat viewer to poll NDJSON events.',
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        runIds: { type: 'array', items: { type: 'string' } },
        task: { type: 'string' },
        prompt: { type: 'string' },
        cursors: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
];

const LEGACY_TOOL_ALIASES = new Map([
  ['agy_models_list', 'agy_local_list'],
  ['agy_models_discover', 'agy_local_discover'],
  ['agy_models_add', 'agy_local_add'],
  ['agy_models_remove', 'agy_local_remove'],
  ['agy_models_chat', 'agy_local_chat'],
  ['agy_models_subagent', 'agy_local_subagent'],
  ['agy_models_agent_settings', 'agy_local_agent_settings'],
  ['agy_models_hybrid_orchestrate', 'agy_local_hybrid_orchestrate'],
  ['agy_models_direct_chat', 'agy_local_direct_chat'],
]);

const STREAM_UI_TOOLS = new Set([
  'agy_local_chat',
  'agy_local_subagent',
  'agy_local_stream_watch',
  'agy_local_stream_poll',
]);

let useContentLengthFraming = false;

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const bytes = Buffer.byteLength(json, 'utf-8');
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

function sendResult(id, result) {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendNotification(method, params) {
  writeMessage({ jsonrpc: '2.0', method, params });
}

function createProgressForwarder(progressToken) {
  if (progressToken === undefined || progressToken === null) return null;
  let seq = 0;
  let lastEmitMs = 0;
  let lastMessage = '';
  let thinkingTail = '';
  let contentTail = '';
  let activeKind = '';
  let flushTimer = null;

  const formatTail = (raw, prefix = '') => {
    const clean = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const maxBody = Math.max(40, 210 - prefix.length);
    const body = clean.length > maxBody ? `…${clean.slice(-(maxBody - 1))}` : clean;
    return `${prefix}${body}`;
  };

  const emitMessage = (message) => {
    const text = String(message || '').trim().slice(0, 220);
    if (!text || text === lastMessage) return;
    lastMessage = text;
    lastEmitMs = Date.now();
    seq += 1;
    // Omit `total` intentionally so Antigravity streams thinking text in chat without a progress bar.
    sendNotification('notifications/progress', {
      progressToken,
      progress: seq,
      message: text,
    });
  };

  const flushStreamBuffer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (activeKind === 'thinking' && thinkingTail) {
      emitMessage(formatTail(thinkingTail, 'Thinking: '));
    } else if (activeKind === 'content' && contentTail) {
      emitMessage(formatTail(contentTail, ''));
    }
  };

  const scheduleFlush = () => {
    const elapsed = Date.now() - lastEmitMs;
    if (elapsed >= 90) {
      flushStreamBuffer();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushStreamBuffer, Math.max(20, 90 - elapsed));
    }
  };

  return {
    onEvent(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'step_start') {
        thinkingTail = '';
        contentTail = '';
        activeKind = '';
        if ((Number(ev.step) || 1) === 1) {
          emitMessage('Thinking…');
        }
        return;
      }
      if (ev.type === 'thinking_delta') {
        activeKind = 'thinking';
        thinkingTail = (thinkingTail + String(ev.text || '')).slice(-480);
        scheduleFlush();
        return;
      }
      if (ev.type === 'content_delta') {
        activeKind = 'content';
        contentTail = (contentTail + String(ev.text || '')).slice(-480);
        scheduleFlush();
        return;
      }
      if (ev.type === 'tool_start') {
        flushStreamBuffer();
        emitMessage(`→ ${ev.tool}`);
        return;
      }
      if (ev.type === 'tool_end') {
        emitMessage(`${ev.ok ? '✓' : '✗'} ${ev.tool}`);
      }
    },
    stop() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  };
}

function collectPollRuns(args = {}) {
  const streamsDir = getStreamsDir();
  const cursors = args.cursors && typeof args.cursors === 'object' ? args.cursors : {};
  const ids = [];

  if (Array.isArray(args.runIds) && args.runIds.length > 0) {
    for (const id of args.runIds) {
      if (id && !ids.includes(String(id))) ids.push(String(id));
    }
  } else if (args.runId) {
    ids.push(String(args.runId));
  } else {
    const matched = findMatchingStreamRun({
      streamsDir,
      task: args.task,
      prompt: args.prompt,
    });
    if (matched) ids.push(matched);
  }

  return ids.map((id) =>
    readStreamEvents({
      streamsDir,
      runId: id,
      cursor: Number(cursors[id]) || 0,
    })
  );
}

function boundStructuredContent(obj) {
  const json = JSON.stringify(obj);
  if (Buffer.byteLength(json, 'utf-8') <= 380_000) return obj;
  if (obj && typeof obj === 'object') {
    const copy = { ...obj };
    if (typeof copy.reply === 'string' && copy.reply.length > 40000) {
      copy.reply = `${copy.reply.slice(0, 40000)}\n... [truncated]`;
    }
    if (typeof copy.reasoning === 'string' && copy.reasoning.length > 40000) {
      copy.reasoning = `${copy.reasoning.slice(0, 40000)}\n... [truncated]`;
    }
    return copy;
  }
  return obj;
}

async function handleToolCall(rawName, args = {}, { progressToken } = {}) {
  const name = LEGACY_TOOL_ALIASES.get(rawName) || rawName;
  const progressForwarder = createProgressForwarder(progressToken);
  const onProgress = progressForwarder ? (ev) => progressForwarder.onEvent(ev) : null;

  try {
    switch (name) {
    case 'agy_local_list': {
      const state = readState();
      const includeDisabled = args.includeDisabled !== false;
      const models = (state.models || [])
        .filter((m) => includeDisabled || m.enabled)
        .map(maskModelForClient);
      return {
        activeEndpoint: {
          preset: state.activeEndpoint.preset,
          baseUrl: state.activeEndpoint.baseUrl,
          hasApiKey: Boolean(state.activeEndpoint.apiKey),
        },
        directChat: state.directChat,
        agentSettings: state.agentSettings || {
          harness: 'auto',
          thinkingLevel: 'auto',
          verbose: true,
          uiMode: 'simple',
          maxThinkingLoops: 10,
        },
        harnesses: HARNESS_CATALOG,
        thinkingLevels: THINKING_LEVELS,
        recentStreams: listRecentStreams({ streamsDir: getStreamsDir(), limit: 8 }),
        total: models.length,
        models,
      };
    }

    case 'agy_local_discover': {
      if (args.scanLocal) {
        const localEndpoints = await scanLocalEndpoints();
        if (!args.baseUrl) {
          return { localEndpoints };
        }
      }
      if (!args.baseUrl) {
        const current = readState();
        args.baseUrl = current.activeEndpoint.baseUrl;
        args.apiKey = args.apiKey ?? current.activeEndpoint.apiKey;
        args.preset = args.preset ?? current.activeEndpoint.preset;
      }
      return await discoverModels({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey || '',
        preset: args.preset || '',
      });
    }

    case 'agy_local_add': {
      const res = addModels([
        {
          modelId: args.modelId,
          displayName: args.displayName,
          baseUrl: args.baseUrl,
          apiKey: args.apiKey,
          preset: args.preset,
          contextWindow: args.contextWindow,
          maxOutputTokens: args.maxOutputTokens,
          isDefault: args.isDefault,
        },
      ]);
      return {
        added: res.added,
        updated: res.updated,
        totalModels: res.state.models.length,
      };
    }

    case 'agy_local_remove': {
      const res = removeModel(args.id);
      return {
        removed: res.removed,
        remainingModels: res.state.models.length,
      };
    }

    case 'agy_local_chat': {
      const runId = args.runId || createRunId('chat');
      return await chatWithModel({
        modelId: args.model,
        prompt: args.prompt,
        systemPrompt: args.systemPrompt,
        files: args.files,
        sessionId: args.sessionId,
        resetSession: Boolean(args.resetSession),
        autoDiscover: args.autoDiscover !== false,
        enableTools: args.enableTools !== false,
        cwd: args.cwd || process.cwd(),
        maxSteps: args.maxSteps,
        maxThinkingLoops: args.maxThinkingLoops,
        allowWrite: args.allowWrite !== false,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        harness: args.harness,
        taskType: args.taskType,
        thinkingLevel: args.thinkingLevel,
        verbose: args.verbose,
        runId,
        stream: true,
        onEvent: onProgress,
      });
    }

    case 'agy_local_subagent': {
      const runId = args.runId || createRunId('sub');
      return await runLocalSubagent({
        task: args.task,
        modelId: args.model,
        cwd: args.cwd || process.cwd(),
        files: args.files,
        maxSteps: args.maxSteps,
        maxThinkingLoops: args.maxThinkingLoops,
        allowWrite: args.allowWrite !== false,
        sessionId: args.sessionId,
        harness: args.harness,
        taskType: args.taskType,
        thinkingLevel: args.thinkingLevel,
        verbose: args.verbose,
        runId,
        stream: true,
        onEvent: onProgress,
      });
    }

    case 'agy_local_stream_watch': {
      const runs = collectPollRuns({
        runId: args.runId,
        runIds: args.runIds,
        task: args.title,
      });
      return {
        ok: true,
        watching: true,
        title: args.title || '',
        runs,
      };
    }

    case 'agy_local_stream_poll': {
      return {
        runs: collectPollRuns(args),
      };
    }

    case 'agy_local_agent_settings': {
      const hasUpdate =
        args.harness !== undefined ||
        args.thinkingLevel !== undefined ||
        args.verbose !== undefined ||
        args.maxThinkingLoops !== undefined ||
        args.uiMode !== undefined;
      const agentSettings = hasUpdate
        ? setAgentSettings({
            harness: args.harness,
            thinkingLevel: args.thinkingLevel,
            verbose: args.verbose,
            maxThinkingLoops: args.maxThinkingLoops,
            uiMode: args.uiMode,
          }).agentSettings
        : readState().agentSettings || {
            harness: 'auto',
            thinkingLevel: 'auto',
            verbose: true,
            uiMode: 'simple',
            maxThinkingLoops: 10,
          };
      return {
        agentSettings,
        harnesses: HARNESS_CATALOG,
        thinkingLevels: THINKING_LEVELS,
      };
    }

    case 'agy_local_hybrid_orchestrate': {
      return await runHybridOrchestration({
        modelId: args.model,
        fileName: args.fileName,
        sourceCode: args.sourceCode,
        task: args.task,
      });
    }

    case 'agy_local_direct_chat': {
      const res = setDirectChatConfig({
        enabled: args.enabled,
        modelId: args.model,
        mode: args.mode,
      });
      return {
        directChat: res.directChat,
        totalModels: res.state.models.length,
      };
    }

    default:
      throw new Error(`Unknown tool: ${rawName}`);
    }
  } finally {
    progressForwarder?.stop();
  }
}

async function handleRequest(msg) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    const clientVersion = params?.protocolVersion;
    return sendResult(id, {
      protocolVersion: typeof clientVersion === 'string' && clientVersion ? clientVersion : '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},
        logging: {},
      },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }

  if (method === 'ping') {
    return sendResult(id, {});
  }

  if (method === 'tools/list') {
    return sendResult(id, { tools: TOOLS });
  }

  if (method === 'resources/list') {
    return sendResult(id, {
      resources: [
        {
          uri: STREAM_APP_URI,
          name: 'Local Agent Live Stream',
          description: 'Live token, thinking, and tool call streaming UI for agy-local-agents.',
          mimeType: STREAM_APP_MIME,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    });
  }

  if (method === 'resources/read') {
    const uri = params?.uri;
    if (uri !== STREAM_APP_URI) {
      return sendError(id, -32602, `Resource not found: ${uri}`);
    }
    if (!existsSync(STREAM_APP_HTML_PATH)) {
      return sendError(id, -32603, 'stream-app.html not built');
    }
    const html = readFileSync(STREAM_APP_HTML_PATH, 'utf-8');
    return sendResult(id, {
      contents: [
        {
          uri: STREAM_APP_URI,
          mimeType: STREAM_APP_MIME,
          text: html,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    const progressToken = params?._meta?.progressToken;
    const canonicalName = LEGACY_TOOL_ALIASES.get(toolName) || toolName;
    try {
      const output = await handleToolCall(toolName, toolArgs, { progressToken });
      const result = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
      if (STREAM_UI_TOOLS.has(canonicalName)) {
        result.structuredContent = boundStructuredContent(output);
      }
      return sendResult(id, result);
    } catch (err) {
      return sendResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error running ${toolName}: ${err.message}`,
          },
        ],
      });
    }
  }

  if (id !== undefined && id !== null) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = Buffer.alloc(0);

function processBuffer() {
  while (buffer.length > 0) {
    const strPreview = buffer.toString('utf-8', 0, Math.min(buffer.length, 64));
    if (/^\s*Content-Length:/i.test(strPreview)) {
      useContentLengthFraming = true;
      const headerEnd = buffer.indexOf('\r\n\r\n');
      const altHeaderEnd = headerEnd >= 0 ? headerEnd : buffer.indexOf('\n\n');
      const sepLen = headerEnd >= 0 ? 4 : 2;
      if (altHeaderEnd < 0) return;

      const headerStr = buffer.subarray(0, altHeaderEnd).toString('utf-8');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(altHeaderEnd + sepLen);
        continue;
      }
      const len = Number.parseInt(match[1], 10);
      const bodyStart = altHeaderEnd + sepLen;
      if (buffer.length < bodyStart + len) return;

      const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf-8');
      buffer = buffer.subarray(bodyStart + len);
      dispatchJson(body);
    } else {
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx < 0) return;
      const line = buffer.subarray(0, nlIdx).toString('utf-8').trim();
      buffer = buffer.subarray(nlIdx + 1);
      if (!line) continue;
      dispatchJson(line);
    }
  }
}

function dispatchJson(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[agy-local-agents mcp] invalid JSON: ${err.message}\n`);
    return;
  }
  Promise.resolve(handleRequest(msg)).catch((err) => {
    process.stderr.write(`[agy-local-agents mcp] request error: ${err.message}\n`);
    if (msg?.id !== undefined) {
      sendError(msg.id, -32603, err.message);
    }
  });
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  if (buffer.length > 0 && !useContentLengthFraming) {
    const tail = buffer.toString('utf-8').trim();
    buffer = Buffer.alloc(0);
    if (tail) dispatchJson(tail);
  }
});
