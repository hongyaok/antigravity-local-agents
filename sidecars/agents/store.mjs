/**
 * Shared model store, OpenAI-compatible discovery engine, custom_models.json sync,
 * auto harness routing, live stream recording, and Hybrid Orchestrator helpers
 * for agy-local-agents.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAgenticSystemPrompt,
  discoverAntigravityEnvironment,
  executeLocalModelTool,
  getLocalModelToolSchemas,
  parseTextToolCalls,
} from './agentic.mjs';
import {
  DEFAULT_MAX_THINKING_LOOPS,
  HARNESS_CATALOG,
  MAX_MAX_THINKING_LOOPS,
  MIN_MAX_THINKING_LOOPS,
  THINKING_LEVELS,
  applyThinkingToPayload,
  classifyTaskForAutoHarness,
  combineThinkingTrace,
  extractChoiceReasoningAndContent,
  formatVerboseThinkingMarkdown,
  normalizeHarness,
  normalizeMaxThinkingLoops,
  normalizeTaskType,
  normalizeThinkingLevel,
  normalizeUiMode,
  requestChatCompletionWithFallbacks,
  resolveEffectiveAgentConfig,
  runMiniSweAgentLoop,
} from './harnesses.mjs';
import {
  createRunId,
  createStreamRecorder,
  findMatchingStreamRun,
  listRecentStreams,
  readStreamEvents,
  resolveStreamsDir,
} from './streams.mjs';

export {
  DEFAULT_MAX_THINKING_LOOPS,
  MIN_MAX_THINKING_LOOPS,
  MAX_MAX_THINKING_LOOPS,
  HARNESS_CATALOG,
  THINKING_LEVELS,
  normalizeHarness,
  normalizeMaxThinkingLoops,
  normalizeThinkingLevel,
  normalizeUiMode,
  normalizeTaskType,
  classifyTaskForAutoHarness,
  resolveEffectiveAgentConfig,
  applyThinkingToPayload,
  formatVerboseThinkingMarkdown,
  createRunId,
  createStreamRecorder,
  findMatchingStreamRun,
  listRecentStreams,
  readStreamEvents,
  resolveStreamsDir,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = join(__dirname, 'cache', 'config.json');

export const ENDPOINT_PRESETS = [
  {
    id: 'ollama',
    label: 'Ollama',
    category: 'local',
    shortMeta: ':11434 · Local',
    defaultPort: 11434,
    baseUrl: 'http://localhost:11434/v1',
    keyOptional: true,
    hint: 'Local Ollama OpenAI server',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    category: 'local',
    shortMeta: ':1234 · Local',
    defaultPort: 1234,
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyOptional: true,
    hint: 'LM Studio local server',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    category: 'local',
    shortMeta: ':8000 · Local',
    defaultPort: 8000,
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyOptional: true,
    hint: 'vLLM OpenAI server',
  },
  {
    id: 'litert',
    label: 'LiteRT-LM',
    category: 'local',
    shortMeta: ':8080 · Local',
    defaultPort: 8080,
    baseUrl: 'http://127.0.0.1:8080/v1',
    keyOptional: true,
    hint: 'LiteRT / llama.cpp server',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'cloud',
    shortMeta: 'Cloud API',
    defaultPort: null,
    baseUrl: 'https://openrouter.ai/api/v1',
    keyOptional: false,
    hint: 'OpenRouter API (key required)',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    category: 'cloud',
    shortMeta: 'Cloud API',
    defaultPort: null,
    baseUrl: 'https://api.openai.com/v1',
    keyOptional: false,
    hint: 'OpenAI API (key required)',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    category: 'cloud',
    shortMeta: 'Cloud API',
    defaultPort: null,
    baseUrl: 'https://api.deepseek.com/v1',
    keyOptional: false,
    hint: 'DeepSeek API (key required)',
  },
  {
    id: 'groq',
    label: 'Groq',
    category: 'cloud',
    shortMeta: 'Cloud API',
    defaultPort: null,
    baseUrl: 'https://api.groq.com/openai/v1',
    keyOptional: false,
    hint: 'Groq API (key required)',
  },
  {
    id: 'custom',
    label: 'Custom',
    category: 'cloud',
    shortMeta: 'Any URL',
    defaultPort: null,
    baseUrl: '',
    keyOptional: true,
    hint: 'Any OpenAI /v1 URL',
  },
];

const LOCAL_SCAN_TARGETS = [
  { preset: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', port: 11434 },
  { preset: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', port: 1234 },
  { preset: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', port: 8000 },
  { preset: 'litert', label: 'LiteRT / llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', port: 8080 },
  { preset: 'custom', label: 'Local WebUI / Tabby', baseUrl: 'http://127.0.0.1:5000/v1', port: 5000 },
];

const VALID_CUSTOM_MODEL_PROVIDERS = new Set([
  'openai',
  'openrouter',
  'deepseek',
  'groq',
  'ollama',
  'lmstudio',
  'vllm',
  'llamacpp',
  'localai',
  'tabby',
  'textgen',
  'litellm',
  'custom',
]);

const DEFAULT_STATE = {
  activeEndpoint: {
    preset: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
  },
  savedEndpoints: [],
  models: [],
  discovered: {
    baseUrl: '',
    fetchedAt: null,
    models: [],
  },
  directChat: {
    enabled: false,
    modelId: '',
    mode: 'intercept',
  },
  agentSettings: {
    harness: 'auto',
    thinkingLevel: 'auto',
    verbose: true,
    uiMode: 'simple',
    maxThinkingLoops: DEFAULT_MAX_THINKING_LOOPS,
  },
  managedCustomNames: [],
  managedAgentFiles: [],
};

export function resolveConfigPath() {
  return (
    process.env.AGY_LOCAL_AGENTS_CONFIG_PATH ||
    process.env.AGY_ADD_MODELS_CONFIG_PATH ||
    DEFAULT_CONFIG_PATH
  );
}

export function resolveAgentsDir() {
  return (
    process.env.AGY_LOCAL_AGENTS_AGENTS_DIR ||
    process.env.AGY_ADD_MODELS_AGENTS_DIR ||
    join(PLUGIN_ROOT, 'agents')
  );
}

export function resolveSessionsDir() {
  return (
    process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR ||
    process.env.AGY_ADD_MODELS_SESSIONS_DIR ||
    join(dirname(resolveConfigPath()), 'sessions')
  );
}

export function getStreamsDir() {
  return resolveStreamsDir(resolveConfigPath());
}

export function resolveCustomModelsPath() {
  if (process.env.AGY_CUSTOM_MODELS_PATH) {
    return process.env.AGY_CUSTOM_MODELS_PATH;
  }
  const appData =
    process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
  return join(appData, 'custom_models.json');
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

export function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new Error('Base URL must be a string');
  }
  let trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Base URL is required');
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const looksLocal = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(
      trimmed
    );
    trimmed = `${looksLocal ? 'http' : 'https'}://${trimmed}`;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not embed credentials in the URL; use the API Key field instead.');
  }
  let clean = parsed.toString().replace(/\/+$/, '');
  clean = clean.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '');
  return clean.replace(/\/+$/, '');
}

export function inferPresetFromUrl(baseUrl, fallback = 'custom') {
  const lower = String(baseUrl || '').toLowerCase();
  if (lower.includes(':11434') || lower.includes('ollama')) return 'ollama';
  if (lower.includes(':1234') || lower.includes('lmstudio')) return 'lmstudio';
  if (lower.includes(':8000') || lower.includes('vllm')) return 'vllm';
  if (lower.includes('openrouter.ai')) return 'openrouter';
  if (lower.includes('api.openai.com')) return 'openai';
  if (lower.includes('api.deepseek.com')) return 'deepseek';
  if (lower.includes('api.groq.com')) return 'groq';
  if (lower.includes(':8080')) return 'litert';
  return fallback;
}

export function findSavedEndpointKey(state, baseUrl, preset = '') {
  const saved = Array.isArray(state?.savedEndpoints) ? state.savedEndpoints : [];
  if (baseUrl) {
    try {
      const normalized = normalizeBaseUrl(baseUrl);
      const byUrl = saved.find((ep) => ep.baseUrl === normalized && ep.apiKey);
      if (byUrl) return byUrl.apiKey;
    } catch {
      // Ignore malformed URLs during lookup.
    }
  }
  if (preset && preset !== 'custom') {
    const byPreset = saved.find((ep) => ep.preset === preset && ep.apiKey);
    if (byPreset) return byPreset.apiKey;
  }
  return '';
}

export function upsertSavedEndpoint(state, { preset, baseUrl, apiKey }) {
  if (!baseUrl) return;
  let normalized;
  try {
    normalized = normalizeBaseUrl(baseUrl);
  } catch {
    return;
  }
  if (!Array.isArray(state.savedEndpoints)) state.savedEndpoints = [];
  const idx = state.savedEndpoints.findIndex((ep) => ep.baseUrl === normalized);
  const existing = idx >= 0 ? state.savedEndpoints[idx] : null;
  const resolvedPreset = preset || existing?.preset || inferPresetFromUrl(normalized);
  const resolvedKey =
    typeof apiKey === 'string' && apiKey.trim() && apiKey !== '••••••••'
      ? apiKey.trim()
      : existing?.apiKey || '';
  const entry = {
    id: existing?.id || randomUUID().slice(0, 8),
    preset: resolvedPreset,
    baseUrl: normalized,
    apiKey: resolvedKey,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) state.savedEndpoints[idx] = entry;
  else state.savedEndpoints.push(entry);
}

function toAgentSlug(modelId, fallback = 'model') {
  const slug = String(modelId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `local-${slug || fallback}`;
}

function sanitizePositiveInt(value, fallback, min = 1, max = 10_000_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, Math.round(n));
}

function sanitizeModelEntry(raw) {
  const modelId = String(raw?.modelId ?? raw?.id ?? '').trim();
  if (!modelId) return null;
  let baseUrl = '';
  try {
    baseUrl = normalizeBaseUrl(String(raw?.baseUrl ?? ''));
  } catch {
    return null;
  }
  const preset =
    typeof raw?.preset === 'string' && raw.preset.trim()
      ? raw.preset.trim()
      : inferPresetFromUrl(baseUrl);
  const displayName =
    typeof raw?.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.trim()
      : modelId;
  const slugBase = `${preset}-${modelId}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  const id =
    typeof raw?.id === 'string' && raw.id.trim() && raw.id !== modelId
      ? raw.id.trim()
      : `${slugBase || 'model'}-${randomUUID().slice(0, 6)}`;

  return {
    id,
    modelId,
    displayName,
    preset,
    baseUrl,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '',
    ownedBy: typeof raw?.ownedBy === 'string' ? raw.ownedBy.trim() : '',
    parameterSize: typeof raw?.parameterSize === 'string' ? raw.parameterSize.trim() : '',
    quantization: typeof raw?.quantization === 'string' ? raw.quantization.trim() : '',
    contextWindow: sanitizePositiveInt(raw?.contextWindow, 32768, 512, 10_000_000),
    maxOutputTokens: sanitizePositiveInt(raw?.maxOutputTokens, 4096, 128, 1_000_000),
    lightweight: raw?.lightweight !== false,
    enabled: raw?.enabled !== false,
    isDefault: Boolean(raw?.isDefault),
    harness: normalizeHarness(raw?.harness, ''),
    thinkingLevel: normalizeThinkingLevel(raw?.thinkingLevel, ''),
    customModelName:
      typeof raw?.customModelName === 'string' && raw.customModelName.startsWith('models/')
        ? raw.customModelName
        : `models/agy-${slugBase || id}`,
    agentName:
      typeof raw?.agentName === 'string' && raw.agentName.startsWith('local-')
        ? raw.agentName
        : toAgentSlug(modelId),
    addedAt: typeof raw?.addedAt === 'string' ? raw.addedAt : new Date().toISOString(),
  };
}

function sanitizeState(raw) {
  const activeRaw = raw?.activeEndpoint ?? {};
  let activeBaseUrl = DEFAULT_STATE.activeEndpoint.baseUrl;
  if (typeof activeRaw.baseUrl === 'string') {
    if (activeRaw.baseUrl.trim() === '') {
      activeBaseUrl = '';
    } else {
      try {
        activeBaseUrl = normalizeBaseUrl(activeRaw.baseUrl);
      } catch {
        activeBaseUrl = DEFAULT_STATE.activeEndpoint.baseUrl;
      }
    }
  }
  const activePreset =
    typeof activeRaw.preset === 'string' && activeRaw.preset.trim()
      ? activeRaw.preset.trim()
      : inferPresetFromUrl(activeBaseUrl, 'custom');

  const models = [];
  const seenKey = new Set();
  for (const m of Array.isArray(raw?.models) ? raw.models : []) {
    const clean = sanitizeModelEntry(m);
    if (!clean) continue;
    const dedup = `${clean.baseUrl}::${clean.modelId}`;
    if (seenKey.has(dedup)) continue;
    seenKey.add(dedup);
    models.push(clean);
  }

  // Assign collision-free Main Agent dropdown names (`local-<model-slug>`).
  const usedAgentNames = new Set([
    'orchestrator-to-local',
    'local-model-chat',
    'local-model-worker',
    'local-subagent',
  ]);
  for (const m of models) {
    const baseSlug = toAgentSlug(m.modelId || m.displayName || m.id);
    let candidate = baseSlug;
    let suffix = 2;
    while (usedAgentNames.has(candidate)) {
      candidate = `${baseSlug.slice(0, 56)}-${suffix++}`;
    }
    usedAgentNames.add(candidate);
    m.agentName = candidate;
  }

  // Ensure exactly one enabled model is marked default if any enabled model exists.
  const enabledModels = models.filter((m) => m.enabled);
  const currentDefault = enabledModels.find((m) => m.isDefault);
  for (const m of models) {
    m.isDefault = currentDefault ? m === currentDefault : false;
  }
  if (!currentDefault && enabledModels.length > 0) {
    enabledModels[0].isDefault = true;
  }

  const savedEndpoints = [];
  const seenEndpoints = new Set();
  for (const ep of Array.isArray(raw?.savedEndpoints) ? raw.savedEndpoints : []) {
    try {
      const baseUrl = normalizeBaseUrl(ep?.baseUrl);
      if (seenEndpoints.has(baseUrl)) continue;
      seenEndpoints.add(baseUrl);
      savedEndpoints.push({
        id: typeof ep?.id === 'string' && ep.id ? ep.id : randomUUID().slice(0, 8),
        preset:
          typeof ep?.preset === 'string' && ep.preset
            ? ep.preset
            : inferPresetFromUrl(baseUrl),
        baseUrl,
        apiKey: typeof ep?.apiKey === 'string' ? ep.apiKey.trim() : '',
        updatedAt: typeof ep?.updatedAt === 'string' ? ep.updatedAt : new Date().toISOString(),
      });
    } catch {
      // Skip invalid endpoint entries.
    }
  }

  const discRaw = raw?.discovered ?? {};
  const discModels = Array.isArray(discRaw.models)
    ? discRaw.models
        .filter((d) => d && typeof d.id === 'string' && d.id.trim())
        .slice(0, 500)
    : [];

  const dcRaw = raw?.directChat ?? {};
  const dcMode = dcRaw.mode === 'assisted' ? 'assisted' : 'intercept';
  let dcModelId = typeof dcRaw.modelId === 'string' ? dcRaw.modelId.trim() : '';
  if (dcModelId) {
    const matched = enabledModels.find(
      (m) =>
        m.id === dcModelId ||
        m.modelId === dcModelId ||
        m.displayName === dcModelId ||
        m.agentName === dcModelId ||
        m.customModelName === dcModelId
    );
    if (!matched) dcModelId = '';
  }

  const asRaw = raw?.agentSettings ?? {};
  const agentSettings = {
    harness: normalizeHarness(asRaw.harness, 'auto'),
    thinkingLevel: normalizeThinkingLevel(asRaw.thinkingLevel, 'auto'),
    verbose: asRaw.verbose === undefined ? true : Boolean(asRaw.verbose),
    uiMode: normalizeUiMode(asRaw.uiMode, 'simple'),
    maxThinkingLoops: normalizeMaxThinkingLoops(
      asRaw.maxThinkingLoops,
      DEFAULT_MAX_THINKING_LOOPS
    ),
  };

  return {
    activeEndpoint: {
      preset: activePreset,
      baseUrl: activeBaseUrl,
      apiKey: typeof activeRaw.apiKey === 'string' ? activeRaw.apiKey.trim() : '',
    },
    savedEndpoints,
    models,
    discovered: {
      baseUrl: typeof discRaw.baseUrl === 'string' ? discRaw.baseUrl : '',
      fetchedAt: typeof discRaw.fetchedAt === 'string' ? discRaw.fetchedAt : null,
      models: discModels,
    },
    directChat: {
      enabled: Boolean(dcRaw.enabled),
      modelId: dcModelId,
      mode: dcMode,
    },
    agentSettings,
    managedCustomNames: Array.isArray(raw?.managedCustomNames)
      ? raw.managedCustomNames.filter((n) => typeof n === 'string' && n.startsWith('models/'))
      : models.map((m) => m.customModelName),
    managedAgentFiles: Array.isArray(raw?.managedAgentFiles)
      ? raw.managedAgentFiles.filter(
          (f) => typeof f === 'string' && /^(?:local-[a-z0-9._-]+|orchestrator-to-local)\.md$/i.test(f)
        )
      : [],
  };
}

export function readState() {
  const cfgPath = resolveConfigPath();
  if (!existsSync(cfgPath)) {
    return sanitizeState(DEFAULT_STATE);
  }
  try {
    const raw = readFileSync(cfgPath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return sanitizeState(parsed);
  } catch {
    return sanitizeState(DEFAULT_STATE);
  }
}

export function writeState(nextState, { syncCustomModels = true, syncAgents = syncCustomModels } = {}) {
  const clean = sanitizeState(nextState);
  writeJsonAtomic(resolveConfigPath(), clean);
  let metadataUpdated = false;
  if (syncCustomModels) {
    const prevNames = JSON.stringify(clean.managedCustomNames);
    syncToCustomModelsFile(clean);
    if (JSON.stringify(clean.managedCustomNames) !== prevNames) {
      metadataUpdated = true;
    }
  }
  if (syncAgents) {
    const prevAgents = JSON.stringify(clean.managedAgentFiles);
    syncToAgentFiles(clean);
    if (JSON.stringify(clean.managedAgentFiles) !== prevAgents) {
      metadataUpdated = true;
    }
  }
  if (metadataUpdated) {
    writeJsonAtomic(resolveConfigPath(), clean);
  }
  return clean;
}

export function maskModelForClient(model) {
  const { apiKey, ...rest } = model;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? '••••••••' : '',
  };
}

export function redactStateForClient(state) {
  const activeKey = state.activeEndpoint?.apiKey || '';
  return {
    presets: ENDPOINT_PRESETS,
    harnesses: HARNESS_CATALOG,
    thinkingLevels: THINKING_LEVELS,
    activeEndpoint: {
      preset: state.activeEndpoint.preset,
      baseUrl: state.activeEndpoint.baseUrl,
      hasApiKey: Boolean(activeKey),
      apiKeyMasked: activeKey ? '••••••••' : '',
    },
    savedEndpoints: (state.savedEndpoints || []).map((ep) => ({
      id: ep.id,
      preset: ep.preset,
      baseUrl: ep.baseUrl,
      hasApiKey: Boolean(ep.apiKey),
      updatedAt: ep.updatedAt,
    })),
    models: (state.models || []).map(maskModelForClient),
    discovered: state.discovered || { baseUrl: '', fetchedAt: null, models: [] },
    directChat: state.directChat || { enabled: false, modelId: '', mode: 'intercept' },
    agentSettings: state.agentSettings || {
      harness: 'auto',
      thinkingLevel: 'auto',
      verbose: true,
      uiMode: 'simple',
      maxThinkingLoops: DEFAULT_MAX_THINKING_LOOPS,
    },
  };
}

/**
 * Syncs agy-local-agents entries into ~/.gemini/antigravity/custom_models.json while
 * preserving any existing user-defined custom models not managed by agy-local-agents.
 */
export function syncToCustomModelsFile(state) {
  const customModelsPath = resolveCustomModelsPath();
  let existingModels = [];
  let rootShape = 'object';

  if (existsSync(customModelsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(customModelsPath, 'utf-8').replace(/^\uFEFF/, ''));
      if (Array.isArray(parsed)) {
        existingModels = parsed;
        rootShape = 'array';
      } else if (parsed && Array.isArray(parsed.models)) {
        existingModels = parsed.models;
      }
    } catch {
      return { synced: false, path: customModelsPath, reason: 'existing file is not valid JSON' };
    }
  }

  const managedNames = new Set([
    ...(state.managedCustomNames || []),
    ...(state.models || []).map((m) => m.customModelName),
  ]);

  const preserved = existingModels.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const name = String(entry.name || '');
    const desc = String(entry.description || '');
    if (managedNames.has(name)) return false;
    if (desc.includes('[agy-add-models]') || desc.includes('[agy-local-agents]')) return false;
    return true;
  });

  const usedNames = new Set(preserved.map((e) => String(e.name || '')));
  const nextManagedNames = [];

  const syncedEntries = (state.models || []).map((m) => {
    let customName = m.customModelName || `models/agy-${m.id}`;
    if (usedNames.has(customName)) {
      customName = `models/agy-${m.id}-${randomUUID().slice(0, 4)}`;
    }
    usedNames.add(customName);
    nextManagedNames.push(customName);

    const provider = VALID_CUSTOM_MODEL_PROVIDERS.has(m.preset) ? m.preset : 'custom';
    const maxOutput = Math.min(
      m.maxOutputTokens,
      Math.max(128, m.contextWindow - 1)
    );

    return {
      name: customName,
      displayName: m.displayName || m.modelId,
      description: `Added via agy-local-agents (${m.baseUrl}) [agy-local-agents]`,
      provider,
      apiFormat: 'openai',
      apiUrl: m.baseUrl,
      apiKey: m.apiKey || '',
      externalModelName: m.modelId,
      enabled: Boolean(m.enabled),
      contextWindow: m.contextWindow,
      maxOutputTokens: maxOutput,
    };
  });

  state.managedCustomNames = nextManagedNames;
  const finalModels = [...preserved, ...syncedEntries];
  const payload = rootShape === 'array' ? finalModels : { models: finalModels };
  writeJsonAtomic(customModelsPath, payload);
  return { synced: true, path: customModelsPath, count: syncedEntries.length };
}

const MANAGED_AGENT_MARKER = '<!-- [agy-local-agents-managed-agent] -->';
const LEGACY_AGENT_MARKER = '<!-- [agy-add-models-managed-agent] -->';

function writeTextIfChanged(filePath, content) {
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, 'utf-8') === content) return;
    } catch {
      // Fall through and rewrite.
    }
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
}

function buildOrchestratorAgentMarkdown(defaultModel, pluginRootPosix, state = {}) {
  const defaultDesc = defaultModel
    ? `${defaultModel.displayName || defaultModel.modelId} (${defaultModel.modelId} @ ${defaultModel.baseUrl})`
    : 'your configured local OpenAI-compatible models';
  const verboseLine =
    state.agentSettings?.verbose === false
      ? 'Include any returned thinking trace when helpful.'
      : 'When verbose thinking is active (default), surface key `[Thinking]` steps and final tool trace cleanly alongside your synthesized report.';

  return [
    '---',
    'name: orchestrator-to-local',
    'description: "Gemini lead orchestrator that plans work, classifies coding vs. knowledge subtasks, and delegates to local model subagents with live chat streaming."',
    'mainAgent: true',
    'subagent: true',
    '---',
    '',
    '# Gemini Orchestrator to Local Subagents (`orchestrator-to-local`)',
    '',
    `You are the **chosen Gemini model** acting as lead orchestrator over the user's local models (default: **${defaultDesc}**).`,
    '',
    '## Core Rules',
    '',
    '1. **Inspect Available Local Models**: Call `agy_local_list` via `call_mcp_tool(ServerName="agy-local-agents_agy-local-agents", ToolName="agy_local_list", Arguments={})` (or `node "' + pluginRootPosix + '/skills/local-models/scripts/local-model.mjs" list`) if you need to check active local models.',
    '2. **Plan, Classify & Size Every Subtask (`auto` Harness + Thinking Loops)**:',
    '   - **Coding tasks** (implementing, refactoring, debugging, fixing bugs, writing/running tests, editing source files, shell/build tasks): pass **`taskType: "coding"`** (selects `mini-swe-agent` in `auto` mode).',
    '   - **Knowledge work** (research, summarization, Q&A, drafting docs/emails, planning, analysis, non-code explanations): pass **`taskType: "knowledge"`** (selects Antigravity `native` harness in `auto` mode).',
    '   - Only use `mini-swe-agent` for coding-related subtasks!',
    '   - **Determine `maxThinkingLoops` for each subagent**: choose an appropriate loop budget based on subtask complexity (e.g., `2-4` for simple lookups/summaries, `5-10` for multi-file analysis or targeted edits, `10-20` for complex coding/debugging) and pass `maxThinkingLoops` (or `--max-loops <N>` via CLI).',
    '3. **Delegate with Live Monitoring**:',
    '   - **Single subagent**: Call `call_mcp_tool` (`agy-local-agents_agy-local-agents` -> `agy_local_subagent`) with `{ task, taskType: "coding" | "knowledge", maxThinkingLoops: <N>, cwd }`. Its thinking trace streams live directly in the tool status line.',
    '   - **Multiple subagents (> 1)**: Assign sequential `runId` values (`"local-subagent-1"`, `"local-subagent-2"`, ...) on each `agy_local_subagent` (or CLI `--run-id local-subagent-N`) call, and BEFORE/as you launch them, output clickable pills in chat so the user can open the live multi-agent monitor panel anytime:',
    '     `[local-subagent-1](sidecar://agy-local-agents/agents/monitor.html?runId=local-subagent-1)` · `[local-subagent-2](sidecar://agy-local-agents/agents/monitor.html?runId=local-subagent-2)`',
    '   - **CLI (`run_command`) alternative**: Launch `node "' + pluginRootPosix + '/skills/local-models/scripts/local-model.mjs" subagent --run-id "local-subagent-1" --task-type <coding|knowledge> --max-loops <N> --cwd "<workspace>" --task "<subtask>"` with `WaitMsBeforeAsync: 500`, paired with `agy_local_stream_watch` (single) or the `sidecar://` pills (multi).',
    `4. **Verify & Synthesize**: Verify returned code, diffs, or test commands directly when needed. ${verboseLine} Cite which local model, resolved harness (\`mini-swe-agent\` vs \`native\`), and steps ran.`,
    '',
    MANAGED_AGENT_MARKER,
    '',
  ].join('\n');
}

function buildCoreChatAgentMarkdown(defaultModel, pluginRootPosix, state = {}) {
  const defaultDesc = defaultModel
    ? `${defaultModel.displayName || defaultModel.modelId} (${defaultModel.modelId} @ ${defaultModel.baseUrl})`
    : 'your auto-detected or default OpenAI-compatible local model';
  const verboseLine =
    state.agentSettings?.verbose === false
      ? 'If `--verbose` or thinking output is present in the run, include its **Thinking** block before the final answer.'
      : 'Verbose thinking mode is ON by default: ALWAYS display the model\'s thinking/reasoning trace (all `[Thinking]` / `[Thought]` steps) prominently in your chat reply—followed by tool calls, latency, and the final answer.';

  return [
    '---',
    'name: local-model-chat',
    'description: "Directly chat with your default local/custom OpenAI-compatible model configured in agy-local-agents."',
    'mainAgent: true',
    'subagent: true',
    '---',
    '',
    '# Direct Local Model Chat (`agy-local-agents`)',
    '',
    `You are a direct chat interface to **${defaultDesc}** with full access to Antigravity skills, tools, rules, and MCP servers.`,
    '',
    '## How to Handle Every User Turn',
    '',
    '1. Forward the user prompt directly to the local model with live streaming:',
    '   - **Preferred (inline live stream UI in chat)**: Call `call_mcp_tool(ServerName="agy-local-agents_agy-local-agents", ToolName="agy_local_chat", Arguments={ prompt: "<user_message>", sessionId: "<conversationId>", taskType: "coding" | "knowledge", cwd: "<workspace>" })`.',
    '   - **CLI alternative (`run_command`)**: Launch `node "' + pluginRootPosix + '/skills/local-models/scripts/local-model.mjs" chat --run-id "<run_id>" --session "<conversationId>" --task-type <coding|knowledge> --prompt "<user_message>"` with `WaitMsBeforeAsync: 500`, and immediately call `agy_local_stream_watch` with `{ runId: "<run_id>" }` so tokens stream live in chat.',
    '   - Classify `taskType`: use `"coding"` for coding tasks (`mini-swe-agent`) and `"knowledge"` for non-coding knowledge work (`native`).',
    `2. ${verboseLine}`,
    '3. Return the local model response cleanly and faithfully without fabricating or altering its answer. Include the model name, active harness/thinking level, any tools/skills used, and latency.',
    '',
    MANAGED_AGENT_MARKER,
    '',
  ].join('\n');
}

function buildWorkerAgentMarkdown(pluginRootPosix, state = {}) {
  const verboseLine =
    state.agentSettings?.verbose === false
      ? 'Include any returned thinking trace when present.'
      : 'When verbose mode is enabled (default), include the local model\'s `[Thinking]` / `thinkingSteps` / `reasoning` trace visibly in your report so thinking is displayed in chat.';
  return [
    '---',
    'name: local-model-worker',
    'description: "Worker subagent that lists, selects, and executes tasks or hybrid builder/critic verification loops on user-added OpenAI-compatible models via agy-local-agents."',
    'mainAgent: false',
    'subagent: true',
    '---',
    '',
    '# Local / Custom OpenAI Model Worker',
    '',
    'You are a specialized execution worker that routes tasks to the user\'s configured OpenAI-compatible models registered in `agy-local-agents`.',
    '',
    '## Workflow',
    '',
    `1. **Check available added models**: Call \`agy_local_list\` (or run \`node "${pluginRootPosix}/skills/local-models/scripts/local-model.mjs" list\`) first to see which models are added and enabled (and which one is marked \`isDefault\`).`,
    '2. **Execute with Auto Harness Classification & Live Streaming**:',
    '   - Classify `taskType`: pass `taskType: "coding"` ONLY for coding subtasks (`mini-swe-agent`) and `taskType: "knowledge"` for knowledge work (`native`).',
    '   - For autonomous tasks requiring skills, files, commands, or MCP tools, call `agy_local_subagent` (or launch `local-model.mjs subagent --run-id <id> --task-type <coding|knowledge>` + `agy_local_stream_watch`).',
    '   - For direct prompts, call `agy_local_chat` (or `local-model.mjs chat`).',
    '   - For security hardening or multi-candidate code remediation on a file, call `agy_local_hybrid_orchestrate` (or `local-model.mjs hybrid --file <path>`).',
    `3. **Report honestly & verbosely**: Return the model ID used, resolved harness, latency/usage, any tool calls, and the exact model output without altering results. ${verboseLine}`,
    '',
    MANAGED_AGENT_MARKER,
    '',
  ].join('\n');
}

function buildPerModelAgentMarkdown(model, pluginRootPosix, state = {}) {
  const label = model.displayName || model.modelId;
  const description = `Direct chat with local model ${label} (${model.modelId} @ ${model.baseUrl}) via agy-local-agents.`;
  const verboseLine =
    state.agentSettings?.verbose === false
      ? 'If thinking output is returned, include it before the final response.'
      : `Verbose thinking mode is ON by default: ALWAYS display \`${model.modelId}\`'s **Thinking** / reasoning trace visibly in your chat response before the final answer.`;
  return [
    '---',
    `name: ${model.agentName}`,
    `description: ${JSON.stringify(description)}`,
    'mainAgent: true',
    'subagent: true',
    '---',
    '',
    `# Direct Chat: ${label} (\`${model.modelId}\`)`,
    '',
    `You are a direct chat bridge to the OpenAI-compatible model **\`${model.modelId}\`** at **\`${model.baseUrl}\`** with full access to Antigravity skills, tools, rules, and MCP servers.`,
    '',
    '## How to Handle Every User Turn',
    '',
    `1. Forward the user's request to \`${model.modelId}\` with live streaming:`,
    `   - **Preferred (inline live stream UI)**: Call \`call_mcp_tool(ServerName="agy-local-agents_agy-local-agents", ToolName="agy_local_chat", Arguments={ model: "${model.modelId}", sessionId: "<conversationId>", prompt: "<user_message>", taskType: "coding" | "knowledge", cwd: "<workspace>" })\`.`,
    `   - **CLI alternative (\`run_command\`)**: Launch \`node "${pluginRootPosix}/skills/local-models/scripts/local-model.mjs" chat --model "${model.modelId}" --run-id "<run_id>" --session "<conversationId>" --task-type <coding|knowledge> --prompt "<user_message>"\` with \`WaitMsBeforeAsync: 500\` and immediately call \`agy_local_stream_watch\` with \`{ runId: "<run_id>" }\`.`,
    `   - Set \`taskType\` to \`"coding"\` only for coding work (\`mini-swe-agent\`), and \`"knowledge"\` for knowledge work (\`native\`).`,
    `2. ${verboseLine}`,
    `3. Return the exact response from \`${model.modelId}\` (including active harness/thinking level, tools/skills used, and latency) cleanly and faithfully.`,
    '',
    MANAGED_AGENT_MARKER,
    '',
  ].join('\n');
}

/**
 * Syncs agy-local-agents orchestrator/chat/worker agents and one `mainAgent: true`
 * markdown agent per enabled model into `agents/*.md` (and removes `local-subagent.md`).
 */
export function syncToAgentFiles(state) {
  const agentsDir = resolveAgentsDir();
  mkdirSync(agentsDir, { recursive: true });
  const pluginRootPosix = '$HOME/.gemini/config/plugins/agy-local-agents';
  const enabledModels = (state.models || []).filter((m) => m.enabled);
  const defaultModel = enabledModels.find((m) => m.isDefault) || enabledModels[0] || null;

  const expectedFiles = new Map();
  expectedFiles.set(
    'orchestrator-to-local.md',
    buildOrchestratorAgentMarkdown(defaultModel, pluginRootPosix, state)
  );
  expectedFiles.set(
    'local-model-chat.md',
    buildCoreChatAgentMarkdown(defaultModel, pluginRootPosix, state)
  );
  expectedFiles.set(
    'local-model-worker.md',
    buildWorkerAgentMarkdown(pluginRootPosix, state)
  );

  for (const model of enabledModels) {
    if (!model.agentName) continue;
    expectedFiles.set(
      `${model.agentName}.md`,
      buildPerModelAgentMarkdown(model, pluginRootPosix, state)
    );
  }

  for (const [fileName, content] of expectedFiles.entries()) {
    writeTextIfChanged(join(agentsDir, fileName), content);
  }

  const prevManaged = new Set(state.managedAgentFiles || []);
  let existingFiles = [];
  try {
    existingFiles = readdirSync(agentsDir);
  } catch {
    existingFiles = [];
  }

  for (const fileName of existingFiles) {
    if (!fileName.endsWith('.md') || expectedFiles.has(fileName)) continue;
    const fullPath = join(agentsDir, fileName);
    let isManaged = prevManaged.has(fileName) || fileName === 'local-subagent.md';
    if (!isManaged && (fileName.startsWith('local-') || fileName === 'orchestrator-to-local.md')) {
      try {
        const text = readFileSync(fullPath, 'utf-8');
        if (text.includes(MANAGED_AGENT_MARKER) || text.includes(LEGACY_AGENT_MARKER)) {
          isManaged = true;
        }
      } catch {
        // Ignore read error.
      }
    }
    if (isManaged) {
      try {
        unlinkSync(fullPath);
      } catch {
        // Ignore cleanup failure.
      }
    }
  }

  const nextManaged = Array.from(expectedFiles.keys()).sort();
  state.managedAgentFiles = nextManaged;
  return {
    synced: true,
    dir: agentsDir,
    files: nextManaged,
  };
}

function buildAuthHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  if (typeof apiKey === 'string' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

function extractContextLimit(item) {
  const candidates = [
    item?.context_length,
    item?.context_window,
    item?.max_model_len,
    item?.max_context_length,
    item?.top_provider?.context_length,
    item?.limits?.context,
  ];
  for (const val of candidates) {
    const n = Number(val);
    if (Number.isFinite(n) && n >= 512) return Math.round(n);
  }
  return 32768;
}

function extractMaxOutput(item, contextWindow) {
  const candidates = [
    item?.max_output_tokens,
    item?.max_completion_tokens,
    item?.top_provider?.max_completion_tokens,
    item?.limits?.output,
  ];
  for (const val of candidates) {
    const n = Number(val);
    if (Number.isFinite(n) && n >= 128) {
      return Math.min(Math.round(n), Math.max(128, contextWindow - 1));
    }
  }
  return Math.min(4096, Math.max(256, Math.floor(contextWindow / 4)));
}

function normalizeDiscoveredItem(raw, baseUrl, preset, ollamaTagsMap) {
  const id = String(raw?.id ?? raw?.model ?? raw?.name ?? '').trim();
  if (!id) return null;
  const tagMeta = ollamaTagsMap?.get(id) || ollamaTagsMap?.get(`${id}:latest`) || null;
  const contextWindow = extractContextLimit(raw);
  const maxOutputTokens = extractMaxOutput(raw, contextWindow);
  const displayName =
    typeof raw?.name === 'string' && raw.name.trim() && raw.name !== id
      ? raw.name.trim()
      : id;

  return {
    id,
    displayName,
    ownedBy: String(raw?.owned_by ?? tagMeta?.details?.family ?? preset ?? 'openai'),
    parameterSize: String(tagMeta?.details?.parameter_size ?? ''),
    quantization: String(tagMeta?.details?.quantization_level ?? ''),
    contextWindow,
    maxOutputTokens,
    supportsVision: Boolean(
      raw?.architecture?.input_modalities?.includes?.('image') ||
        /vision|vl|4o|gemini|claude-3|claude-sonnet-4|pixtral|llava/i.test(id)
    ),
    baseUrl,
    preset,
  };
}

async function fetchOllamaTags(baseUrl) {
  const map = new Map();
  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return map;
    const data = await res.json();
    for (const item of Array.isArray(data?.models) ? data.models : []) {
      const name = String(item?.name || item?.model || '').trim();
      if (name) map.set(name, item);
    }
  } catch {
    // Non-Ollama servers simply ignore /api/tags.
  }
  return map;
}

function extractModelsArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return [];
}

/**
 * Discovers available models from an OpenAI-compatible base URL with optional API key.
 */
export async function discoverModels({ baseUrl, apiKey = '', preset = '', timeoutMs = 10000 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  const resolvedPreset = preset || inferPresetFromUrl(normalized);
  const headers = buildAuthHeaders(apiKey, { Accept: 'application/json' });

  const candidateBases = [normalized];
  if (!/\/v\d+(?:alpha|beta)?$/i.test(normalized) && !/\/api\/v\d+$/i.test(normalized)) {
    candidateBases.push(`${normalized}/v1`);
  }

  let lastError = null;
  let resolvedBaseUrl = normalized;
  let payload = null;

  for (const candidate of candidateBases) {
    const modelsUrl = `${candidate}/models`;
    try {
      const res = await fetch(modelsUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              detail = parsed?.error?.message || parsed?.message || detail;
            } catch {
              detail = `${detail}: ${text.slice(0, 140)}`;
            }
          }
        } catch {
          // Ignore body parse errors.
        }
        lastError = new Error(`Model discovery failed at ${modelsUrl} (${detail})`);
        if (res.status === 404 && candidate !== candidateBases[candidateBases.length - 1]) {
          continue;
        }
        throw lastError;
      }
      payload = await res.json();
      resolvedBaseUrl = candidate;
      break;
    } catch (err) {
      lastError = err;
      if (candidate === candidateBases[candidateBases.length - 1]) {
        throw err;
      }
    }
  }

  if (!payload) {
    throw lastError || new Error('Failed to fetch models from endpoint');
  }

  const rawItems = extractModelsArray(payload);
  const isOllama =
    resolvedPreset === 'ollama' || resolvedBaseUrl.includes(':11434');
  const ollamaTagsMap = isOllama ? await fetchOllamaTags(resolvedBaseUrl) : new Map();

  const models = [];
  const seen = new Set();
  for (const item of rawItems) {
    const normalizedItem = normalizeDiscoveredItem(
      item,
      resolvedBaseUrl,
      resolvedPreset,
      ollamaTagsMap
    );
    if (!normalizedItem || seen.has(normalizedItem.id)) continue;
    seen.add(normalizedItem.id);
    models.push(normalizedItem);
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  return {
    resolvedBaseUrl,
    preset: resolvedPreset,
    total: models.length,
    fetchedAt: new Date().toISOString(),
    models,
  };
}

/**
 * Scans common localhost ports for running OpenAI-compatible servers.
 */
export async function scanLocalEndpoints() {
  const results = await Promise.all(
    LOCAL_SCAN_TARGETS.map(async (target) => {
      try {
        const res = await fetch(`${target.baseUrl}/models`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          const list = extractModelsArray(json);
          return {
            ...target,
            reachable: true,
            modelCount: list.length,
          };
        }
      } catch {
        // Port not reachable.
      }
      if (target.preset === 'ollama') {
        try {
          const tags = await fetch(`http://127.0.0.1:${target.port}/api/tags`, {
            signal: AbortSignal.timeout(1200),
          });
          if (tags.ok) {
            const json = await tags.json().catch(() => ({}));
            const list = extractModelsArray(json);
            return {
              ...target,
              reachable: true,
              modelCount: list.length,
            };
          }
        } catch {
          // Not reachable.
        }
      }
      return null;
    })
  );
  return results.filter(Boolean);
}

/**
 * Adds one or more models to the Antigravity model list and updates saved endpoints.
 */
export function addModels(items, { endpointOverrides = null } = {}) {
  const list = Array.isArray(items) ? items : [items];
  const state = readState();
  const added = [];
  const updated = [];

  for (const raw of list) {
    const modelId = String(raw?.modelId ?? raw?.id ?? '').trim();
    if (!modelId) continue;

    const baseUrl = normalizeBaseUrl(
      raw?.baseUrl || endpointOverrides?.baseUrl || state.activeEndpoint.baseUrl
    );
    const preset =
      raw?.preset || endpointOverrides?.preset || inferPresetFromUrl(baseUrl);
    const apiKey =
      typeof raw?.apiKey === 'string' && raw.apiKey
        ? raw.apiKey.trim()
        : typeof endpointOverrides?.apiKey === 'string'
          ? endpointOverrides.apiKey.trim()
          : '';

    const existingIdx = state.models.findIndex(
      (m) => m.baseUrl === baseUrl && m.modelId === modelId
    );

    if (existingIdx >= 0) {
      const prev = state.models[existingIdx];
      const next = sanitizeModelEntry({
        ...prev,
        displayName: raw?.displayName || prev.displayName,
        preset,
        apiKey: apiKey || prev.apiKey,
        ownedBy: raw?.ownedBy || prev.ownedBy,
        parameterSize: raw?.parameterSize || prev.parameterSize,
        quantization: raw?.quantization || prev.quantization,
        contextWindow: raw?.contextWindow ?? prev.contextWindow,
        maxOutputTokens: raw?.maxOutputTokens ?? prev.maxOutputTokens,
        lightweight: raw?.lightweight ?? prev.lightweight,
        enabled: raw?.enabled !== undefined ? Boolean(raw.enabled) : true,
        isDefault: raw?.isDefault !== undefined ? Boolean(raw.isDefault) : prev.isDefault,
        harness: raw?.harness !== undefined ? raw.harness : prev.harness,
        thinkingLevel: raw?.thinkingLevel !== undefined ? raw.thinkingLevel : prev.thinkingLevel,
      });
      state.models[existingIdx] = next;
      updated.push(next);
    } else {
      const created = sanitizeModelEntry({
        modelId,
        displayName: raw?.displayName || modelId,
        preset,
        baseUrl,
        apiKey,
        ownedBy: raw?.ownedBy || '',
        parameterSize: raw?.parameterSize || '',
        quantization: raw?.quantization || '',
        contextWindow: raw?.contextWindow ?? 32768,
        maxOutputTokens: raw?.maxOutputTokens ?? 4096,
        lightweight: raw?.lightweight !== false,
        enabled: raw?.enabled !== false,
        isDefault: Boolean(raw?.isDefault) || state.models.length === 0,
        harness: raw?.harness ?? '',
        thinkingLevel: raw?.thinkingLevel ?? '',
      });
      if (created) {
        if (created.isDefault) {
          for (const m of state.models) m.isDefault = false;
        }
        state.models.push(created);
        added.push(created);
      }
    }

    const epIdx = state.savedEndpoints.findIndex((ep) => ep.baseUrl === baseUrl);
    const epEntry = {
      id: epIdx >= 0 ? state.savedEndpoints[epIdx].id : randomUUID().slice(0, 8),
      preset,
      baseUrl,
      apiKey: apiKey || (epIdx >= 0 ? state.savedEndpoints[epIdx].apiKey : ''),
      updatedAt: new Date().toISOString(),
    };
    if (epIdx >= 0) state.savedEndpoints[epIdx] = epEntry;
    else state.savedEndpoints.push(epEntry);
  }

  const nextState = writeState(state);
  return {
    added: added.map(maskModelForClient),
    updated: updated.map(maskModelForClient),
    state: redactStateForClient(nextState),
  };
}

export function updateModel(id, patch = {}) {
  const state = readState();
  const idx = state.models.findIndex((m) => m.id === id || m.modelId === id);
  if (idx < 0) {
    throw new Error(`Model not found: ${id}`);
  }
  const current = state.models[idx];
  const nextBaseUrl = patch.baseUrl ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl;
  const nextApiKey =
    typeof patch.apiKey === 'string' && patch.apiKey !== '••••••••'
      ? patch.apiKey.trim()
      : current.apiKey;

  const updated = sanitizeModelEntry({
    ...current,
    ...patch,
    id: current.id,
    baseUrl: nextBaseUrl,
    apiKey: nextApiKey,
  });

  if (patch.isDefault === true) {
    for (const m of state.models) m.isDefault = false;
    updated.isDefault = true;
    updated.enabled = true;
  }

  state.models[idx] = updated;
  const nextState = writeState(state);
  return {
    model: maskModelForClient(
      nextState.models.find((m) => m.id === updated.id) || updated
    ),
    state: redactStateForClient(nextState),
  };
}

export function removeModel(idOrModelId) {
  const state = readState();
  const target = String(idOrModelId || '').trim();
  const idx = state.models.findIndex(
    (m) =>
      m.id === target ||
      m.modelId === target ||
      m.agentName === target ||
      m.customModelName === target
  );
  if (idx < 0) {
    throw new Error(`Model not found: ${target}`);
  }
  const [removed] = state.models.splice(idx, 1);
  const nextState = writeState(state);
  return {
    removed: maskModelForClient(removed),
    state: redactStateForClient(nextState),
  };
}

export function setDirectChatConfig({ enabled, modelId, mode } = {}) {
  const state = readState();
  const nextDirect = {
    enabled:
      enabled !== undefined ? Boolean(enabled) : Boolean(state.directChat?.enabled),
    modelId:
      typeof modelId === 'string'
        ? modelId.trim()
        : state.directChat?.modelId || '',
    mode:
      mode === 'assisted' || mode === 'intercept'
        ? mode
        : state.directChat?.mode || 'intercept',
  };

  if (nextDirect.modelId) {
    const resolved = resolveConfiguredModel(nextDirect.modelId, { strict: true });
    if (!resolved) {
      throw new Error(`Model not found: ${nextDirect.modelId}`);
    }
    nextDirect.modelId = resolved.modelId;
  }

  state.directChat = nextDirect;
  const nextState = writeState(state, { syncCustomModels: false, syncAgents: true });
  return {
    directChat: nextState.directChat,
    state: redactStateForClient(nextState),
  };
}

/**
 * Updates global default harness, thinkingLevel, verbose flag & uiMode in state.agentSettings.
 */
export function setAgentSettings({ harness, thinkingLevel, verbose, uiMode, maxThinkingLoops } = {}) {
  const state = readState();
  const prev = state.agentSettings || {
    harness: 'auto',
    thinkingLevel: 'auto',
    verbose: true,
    uiMode: 'simple',
    maxThinkingLoops: DEFAULT_MAX_THINKING_LOOPS,
  };

  let nextHarness = prev.harness || 'auto';
  if (harness !== undefined && harness !== null) {
    const trimmed = String(harness).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'inherit') {
      nextHarness = 'auto';
    } else {
      const normalized = normalizeHarness(trimmed, '');
      if (!normalized) {
        const valid = HARNESS_CATALOG.map((h) => h.id).join(', ');
        throw new Error(`Invalid harness "${harness}". Valid options: ${valid}`);
      }
      nextHarness = normalized;
    }
  }

  let nextThinking = prev.thinkingLevel || 'auto';
  if (thinkingLevel !== undefined && thinkingLevel !== null) {
    const trimmed = String(thinkingLevel).trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'inherit') {
      nextThinking = 'auto';
    } else {
      const normalized = normalizeThinkingLevel(trimmed, '');
      if (!normalized) {
        const valid = THINKING_LEVELS.map((t) => t.id).join(', ');
        throw new Error(`Invalid thinkingLevel "${thinkingLevel}". Valid options: ${valid}`);
      }
      nextThinking = normalized;
    }
  }

  const prevVerbose = prev.verbose === undefined ? true : Boolean(prev.verbose);
  let nextVerbose = prevVerbose;
  if (verbose !== undefined && verbose !== null) {
    if (typeof verbose === 'boolean') {
      nextVerbose = verbose;
    } else {
      const lower = String(verbose).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lower)) nextVerbose = true;
      else if (['false', '0', 'no', 'off'].includes(lower)) nextVerbose = false;
      else if (lower === 'inherit' || lower === '') nextVerbose = true;
      else throw new Error(`Invalid verbose value "${verbose}". Use true/false or on/off.`);
    }
  }

  let nextUiMode = normalizeUiMode(prev.uiMode, 'simple');
  if (uiMode !== undefined && uiMode !== null) {
    const trimmed = String(uiMode).trim().toLowerCase();
    if (!trimmed || trimmed === 'inherit') {
      nextUiMode = 'simple';
    } else {
      const normalized = normalizeUiMode(trimmed, '');
      if (!normalized) {
        throw new Error(`Invalid uiMode "${uiMode}". Use simple or advanced.`);
      }
      nextUiMode = normalized;
    }
  }

  let nextMaxThinkingLoops = normalizeMaxThinkingLoops(
    prev.maxThinkingLoops,
    DEFAULT_MAX_THINKING_LOOPS
  );
  if (maxThinkingLoops !== undefined && maxThinkingLoops !== null && maxThinkingLoops !== '') {
    const parsed = Number(maxThinkingLoops);
    if (!Number.isFinite(parsed) || parsed < MIN_MAX_THINKING_LOOPS || parsed > MAX_MAX_THINKING_LOOPS) {
      throw new Error(
        `Invalid maxThinkingLoops "${maxThinkingLoops}". Use an integer between ${MIN_MAX_THINKING_LOOPS} and ${MAX_MAX_THINKING_LOOPS}.`
      );
    }
    nextMaxThinkingLoops = Math.round(parsed);
  }

  state.agentSettings = {
    harness: nextHarness,
    thinkingLevel: nextThinking,
    verbose: nextVerbose,
    uiMode: nextUiMode,
    maxThinkingLoops: nextMaxThinkingLoops,
  };
  const nextState = writeState(state, {
    syncCustomModels: false,
    syncAgents: prevVerbose !== nextVerbose,
  });
  return {
    agentSettings: nextState.agentSettings,
    state: redactStateForClient(nextState),
  };
}

export function resolveConfiguredModel(modelRef, { strict = false } = {}) {
  const state = readState();
  const models = state.models || [];
  if (models.length === 0) return null;

  const enabledModels = models.filter((m) => m.enabled);

  if (modelRef) {
    const target = String(modelRef).trim();
    const matchExact = (m) =>
      m.id === target ||
      m.modelId === target ||
      m.displayName === target ||
      m.agentName === target ||
      m.customModelName === target;
    const foundEnabledExact = enabledModels.find(matchExact);
    if (foundEnabledExact) return foundEnabledExact;
    const foundAnyExact = models.find(matchExact);
    if (foundAnyExact) return foundAnyExact;

    const lower = target.toLowerCase();
    const matchCi = (m) =>
      m.id.toLowerCase() === lower ||
      m.modelId.toLowerCase() === lower ||
      m.displayName.toLowerCase() === lower ||
      (m.agentName && m.agentName.toLowerCase() === lower) ||
      m.customModelName.toLowerCase() === lower;
    const foundEnabledCi = enabledModels.find(matchCi);
    if (foundEnabledCi) return foundEnabledCi;
    const foundAnyCi = models.find(matchCi);
    if (foundAnyCi) return foundAnyCi;
    if (strict) return null;
  }

  return (
    enabledModels.find((m) => m.isDefault) ||
    enabledModels[0] ||
    models[0]
  );
}

const MAX_SESSION_MESSAGES = 24;

function getSessionFilePath(sessionId) {
  const cleanId = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  if (!cleanId) {
    throw new Error('Invalid sessionId');
  }
  return join(resolveSessionsDir(), `${cleanId}.json`);
}

export function readChatSession(sessionId) {
  if (!sessionId) return { sessionId: '', messages: [], updatedAt: null };
  const filePath = getSessionFilePath(sessionId);
  if (!existsSync(filePath)) {
    return { sessionId: String(sessionId), messages: [], updatedAt: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    const msgs = Array.isArray(parsed?.messages)
      ? parsed.messages.filter(
          (m) =>
            m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string'
        )
      : [];
    return {
      sessionId: String(sessionId),
      messages: msgs.slice(-MAX_SESSION_MESSAGES),
      updatedAt: parsed?.updatedAt || null,
    };
  } catch {
    return { sessionId: String(sessionId), messages: [], updatedAt: null };
  }
}

export function clearChatSession(sessionId) {
  if (!sessionId) return { cleared: false, sessionId: '' };
  const filePath = getSessionFilePath(sessionId);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return { cleared: true, sessionId: String(sessionId) };
  }
  return { cleared: false, sessionId: String(sessionId) };
}

function appendChatSessionTurn(sessionId, userContent, assistantContent, modelId) {
  if (!sessionId) return;
  const filePath = getSessionFilePath(sessionId);
  const current = readChatSession(sessionId);
  const nextMessages = [
    ...current.messages,
    { role: 'user', content: userContent },
    { role: 'assistant', content: assistantContent },
  ].slice(-MAX_SESSION_MESSAGES);
  writeJsonAtomic(filePath, {
    sessionId: String(sessionId),
    modelId: modelId || '',
    updatedAt: new Date().toISOString(),
    messages: nextMessages,
  });
}

function buildPromptWithFiles(prompt, files = []) {
  const basePrompt = String(prompt || '').trim() || 'Hello!';
  if (!Array.isArray(files) || files.length === 0) {
    return basePrompt;
  }
  const sections = [];
  for (const rawPath of files) {
    const filePath = String(rawPath || '').trim();
    if (!filePath) continue;
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      throw new Error(`Attached file not found: ${filePath}`);
    }
    const raw = readFileSync(absPath, 'utf-8');
    const maxChars = 128 * 1024;
    const content =
      raw.length > maxChars
        ? `${raw.slice(0, maxChars)}\n... [truncated ${raw.length - maxChars} chars]`
        : raw;
    const ext = extname(absPath).replace(/^\./, '');
    sections.push(`File: ${filePath}\n\`\`\`${ext}\n${content}\n\`\`\``);
  }
  if (sections.length === 0) return basePrompt;
  return `${sections.join('\n\n')}\n\n${basePrompt}`;
}

async function autoDiscoverAndSelectModel(preferredModelRef = '') {
  const state = readState();
  const candidateTargets = [];
  if (state.activeEndpoint?.baseUrl) {
    candidateTargets.push({
      baseUrl: state.activeEndpoint.baseUrl,
      apiKey: state.activeEndpoint.apiKey || '',
      preset: state.activeEndpoint.preset || '',
    });
  }
  const localReachable = await scanLocalEndpoints();
  for (const ep of localReachable) {
    if (!candidateTargets.some((t) => t.baseUrl === ep.baseUrl)) {
      candidateTargets.push({
        baseUrl: ep.baseUrl,
        apiKey: '',
        preset: ep.preset,
      });
    }
  }

  for (const target of candidateTargets) {
    try {
      const disc = await discoverModels({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        preset: target.preset,
        timeoutMs: 3000,
      });
      if (disc.models.length === 0) continue;
      const wanted = String(preferredModelRef || '').trim().toLowerCase();
      const chosen =
        (wanted &&
          disc.models.find(
            (m) =>
              m.id.toLowerCase() === wanted ||
              (m.displayName && m.displayName.toLowerCase() === wanted) ||
              toAgentSlug(m.id) === wanted
          )) ||
        disc.models[0];
      addModels(
        [{ ...chosen, isDefault: true }],
        {
          endpointOverrides: {
            baseUrl: disc.resolvedBaseUrl,
            apiKey: target.apiKey,
            preset: disc.preset,
          },
        }
      );
      return resolveConfiguredModel(chosen.id, { strict: true }) || resolveConfiguredModel();
    } catch {
      // Try next candidate endpoint.
    }
  }

  return null;
}

function accumulateUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const base = total || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: base.prompt_tokens + (Number(usage.prompt_tokens) || 0),
    completion_tokens: base.completion_tokens + (Number(usage.completion_tokens) || 0),
    total_tokens: base.total_tokens + (Number(usage.total_tokens) || 0),
  };
}

/**
 * Executes an OpenAI chat/completions call (single-shot or multi-step agentic tool loop)
 * against a configured or inline model, with Auto harness routing & live stream recording.
 */
export async function chatWithModel({
  modelId,
  baseUrl,
  apiKey = '',
  messages,
  prompt,
  systemPrompt,
  files,
  sessionId,
  resetSession = false,
  autoDiscover = false,
  enableTools,
  cwd = process.cwd(),
  maxSteps,
  maxThinkingLoops,
  allowWrite = true,
  temperature = 0.2,
  maxTokens,
  timeoutMs = 90000,
  harness,
  taskType,
  thinkingLevel,
  verbose,
  stream,
  runId,
  recordStream = true,
  _runKind = 'chat',
  _taskLabel = '',
  onEvent = null,
} = {}) {
  let targetModel = modelId
    ? resolveConfiguredModel(modelId, { strict: !baseUrl })
    : null;
  let autoDiscovered = false;

  if (!baseUrl && !targetModel && !modelId) {
    targetModel = resolveConfiguredModel();
  }
  if (!baseUrl && !targetModel && autoDiscover) {
    targetModel = await autoDiscoverAndSelectModel(modelId);
    if (targetModel) autoDiscovered = true;
  }
  if (!baseUrl && !targetModel) {
    if (modelId) {
      const state = readState();
      const available = (state.models || []).map((m) => m.modelId).join(', ');
      throw new Error(
        available
          ? `Model "${modelId}" not found in agy-local-agents. Configured models: ${available}`
          : 'No added OpenAI-compatible model found. Discover and add a model first.'
      );
    }
    throw new Error(
      'No added OpenAI-compatible model found. Discover and add a model first.'
    );
  }

  const currentState = readState();
  const effective = resolveEffectiveAgentConfig(currentState, targetModel, {
    harness,
    thinkingLevel,
    verbose,
    taskType,
    maxThinkingLoops,
    maxSteps,
  });
  const effectiveMaxLoops = effective.maxThinkingLoops;

  const useExplicitMessages = Array.isArray(messages) && messages.length > 0;
  const userContent = useExplicitMessages ? '' : buildPromptWithFiles(prompt, files);
  const latestUserMsg = useExplicitMessages
    ? [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    : '';
  const classificationText = String(prompt || userContent || latestUserMsg || '');

  const configuredHarness = effective.harness;
  let execHarness = configuredHarness;
  let harnessAutoReason = '';

  if (configuredHarness === 'auto') {
    if (enableTools === false) {
      execHarness = 'native';
      harnessAutoReason = 'tools-disabled';
    } else {
      const classified = classifyTaskForAutoHarness({
        text: classificationText,
        files,
        taskType: effective.taskType || taskType,
      });
      execHarness = classified.harness;
      harnessAutoReason = classified.reason;
    }
  }

  const explicitDisableTools = enableTools === false;
  const toolsEnabled =
    enableTools === true ||
    (!explicitDisableTools && execHarness === 'mini-swe-agent');

  const resolvedBaseUrl = normalizeBaseUrl(baseUrl || targetModel.baseUrl);
  const resolvedModelId = modelId && baseUrl ? modelId : targetModel?.modelId || modelId;
  const resolvedApiKey =
    typeof apiKey === 'string' && apiKey.trim()
      ? apiKey.trim()
      : targetModel?.apiKey || '';

  if (resetSession && sessionId) {
    clearChatSession(sessionId);
  }

  const historyMessages =
    !useExplicitMessages && sessionId ? readChatSession(sessionId).messages : [];

  const endpoint = `${resolvedBaseUrl}/chat/completions`;
  const reqHeaders = buildAuthHeaders(resolvedApiKey, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  const resolvedMaxTokens =
    Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
      ? Math.round(Number(maxTokens))
      : targetModel?.maxOutputTokens;

  const shouldRecord = Boolean(recordStream && (enableTools !== false || runId));
  const activeRunId = shouldRecord
    ? runId || createRunId(_runKind === 'subagent' ? 'sub' : 'chat')
    : runId || null;

  const resolvedTaskType =
    effective.taskType || (execHarness === 'mini-swe-agent' ? 'coding' : 'knowledge');

  const recorder = shouldRecord
    ? createStreamRecorder({
        streamsDir: getStreamsDir(),
        runId: activeRunId,
        kind: _runKind,
        taskType: resolvedTaskType,
        maxThinkingLoops: effectiveMaxLoops,
        model: resolvedModelId,
        displayName: targetModel?.displayName || resolvedModelId,
        task: _taskLabel || prompt || latestUserMsg || 'Local agent task',
        cwd,
        configuredHarness,
        harness: execHarness,
        harnessAutoReason,
        thinkingLevel: effective.thinkingLevel,
      })
    : null;

  const userOnEvent = typeof onEvent === 'function' ? onEvent : null;
  const dispatchEvent =
    recorder || userOnEvent
      ? (ev) => {
          recorder?.emit(ev);
          userOnEvent?.(ev);
        }
      : null;

  if (harnessAutoReason && dispatchEvent) {
    dispatchEvent({
      type: 'harness_resolved',
      configuredHarness,
      harness: execHarness,
      reason: harnessAutoReason,
      runId: activeRunId,
    });
  }

  const shouldStream =
    stream === undefined
      ? Boolean(recorder || userOnEvent)
      : Boolean(stream && dispatchEvent);

  try {
    if (execHarness === 'mini-swe-agent' && toolsEnabled) {
      const env = discoverAntigravityEnvironment({ cwd });
      const toolSchemas = getLocalModelToolSchemas({ allowWrite });
      const miniResult = await runMiniSweAgentLoop({
        endpoint,
        headers: reqHeaders,
        modelId: resolvedModelId,
        configuredModelId: targetModel?.modelId || resolvedModelId,
        displayName: targetModel?.displayName || resolvedModelId,
        agentName: targetModel?.agentName || '',
        baseUrl: resolvedBaseUrl,
        autoDiscovered,
        configuredHarness,
        harnessAutoReason,
        runId: activeRunId,
        messages: useExplicitMessages ? messages : undefined,
        userContent,
        systemPrompt,
        historyMessages,
        cwd,
        env,
        allowWrite,
        maxSteps: effectiveMaxLoops,
        temperature,
        maxTokens: resolvedMaxTokens,
        timeoutMs,
        thinkingLevel: effective.thinkingLevel,
        sessionId,
        toolSchemas,
        stream: shouldStream,
        onEvent: dispatchEvent,
      });
      if (!useExplicitMessages && sessionId) {
        appendChatSessionTurn(sessionId, userContent, miniResult.reply, resolvedModelId);
      }
      const out = {
        ...miniResult,
        taskType: resolvedTaskType,
        maxThinkingLoops: effectiveMaxLoops,
        verbose: effective.verbose,
      };
      recorder?.finish(out);
      return out;
    }

    const env = toolsEnabled ? discoverAntigravityEnvironment({ cwd }) : null;
    const baseSystemPrompt = toolsEnabled
      ? buildAgenticSystemPrompt({ cwd, env, systemPrompt, allowWrite })
      : systemPrompt || '';
    const thinkingApplied = applyThinkingToPayload(
      {},
      baseSystemPrompt,
      effective.thinkingLevel
    );
    const effectiveSystemPrompt = thinkingApplied.systemPrompt;
    const initialReasoningEffort = thinkingApplied.reasoningEffort;

    const conversation = useExplicitMessages
      ? messages[0]?.role === 'system'
        ? [
            {
              ...messages[0],
              content: applyThinkingToPayload(
                {},
                messages[0].content,
                effective.thinkingLevel
              ).systemPrompt,
            },
            ...messages.slice(1),
          ]
        : [...messages]
      : [
          ...(effectiveSystemPrompt ? [{ role: 'system', content: effectiveSystemPrompt }] : []),
          ...historyMessages,
          { role: 'user', content: userContent },
        ];

    const toolSchemas = toolsEnabled ? getLocalModelToolSchemas({ allowWrite }) : null;
    const totalStepBudget = toolsEnabled ? effectiveMaxLoops : 1;
    let sendToolsSchema = Boolean(toolsEnabled && toolSchemas?.length);
    let sendReasoningEffort = Boolean(initialReasoningEffort);

    const toolTrace = [];
    const thinkingSteps = [];
    let totalLatencyMs = 0;
    let totalUsage = null;
    let stepsUsed = 0;
    let lastModel = resolvedModelId;
    let lastFinishReason = null;
    let replyText = '';

    for (let step = 1; step <= totalStepBudget; step += 1) {
      const isLastStep = toolsEnabled && step === totalStepBudget;
      dispatchEvent?.({
        type: 'step_start',
        step,
        maxSteps: totalStepBudget,
        harness: execHarness,
        configuredHarness,
        ...(harnessAutoReason ? { harnessAutoReason } : {}),
        ...(activeRunId ? { runId: activeRunId } : {}),
      });
      const payload = {
        model: resolvedModelId,
        messages: conversation,
        temperature,
        stream: false,
      };
      if (sendToolsSchema && !isLastStep) {
        payload.tools = toolSchemas;
        payload.tool_choice = 'auto';
      }
      if (resolvedMaxTokens) {
        payload.max_tokens = resolvedMaxTokens;
      }
      if (sendReasoningEffort && initialReasoningEffort) {
        payload.reasoning_effort = initialReasoningEffort;
      }

      const reqOutcome = await requestChatCompletionWithFallbacks({
        endpoint,
        headers: reqHeaders,
        payload,
        timeoutMs,
        allowToolsFallback: sendToolsSchema && !isLastStep,
        allowReasoningFallback: sendReasoningEffort,
        stream: Boolean(shouldStream && dispatchEvent),
        onToken: dispatchEvent
          ? (tok) =>
              dispatchEvent({
                type: tok.kind === 'thinking' ? 'thinking_delta' : 'content_delta',
                step,
                text: tok.text,
              })
          : null,
      });

      totalLatencyMs += reqOutcome.latencyMs;
      if (reqOutcome.reasoningEffortRejected) sendReasoningEffort = false;
      if (reqOutcome.toolsRejected) sendToolsSchema = false;

      stepsUsed += 1;
      const json = reqOutcome.json;
      if (json?.model) lastModel = json.model;
      totalUsage = accumulateUsage(totalUsage, json?.usage);

      const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
      lastFinishReason = choice?.finish_reason || null;
      const parsedChoice = extractChoiceReasoningAndContent(choice);
      const rawContent = parsedChoice.content || parsedChoice.rawContent;
      const reasoning = parsedChoice.reasoning;

      const nativeCalls =
        toolsEnabled && Array.isArray(choice?.message?.tool_calls)
          ? choice.message.tool_calls
          : [];
      const textCalls =
        toolsEnabled && nativeCalls.length === 0 && !isLastStep
          ? parseTextToolCalls(rawContent)
          : [];

      if (toolsEnabled && !isLastStep && (nativeCalls.length > 0 || textCalls.length > 0)) {
        const stepNote =
          nativeCalls.length > 0
            ? parsedChoice.content
            : rawContent
                .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
                .replace(/```(?:tool_call|json)\s*\r?\n[\s\S]*?\r?\n```/gi, '')
                .trim();
        if (stepNote && stepNote !== reasoning) {
          dispatchEvent?.({ type: 'assistant_note', step, text: stepNote });
        }
        const stepTools = [];
        if (nativeCalls.length > 0) {
          conversation.push({
            role: 'assistant',
            content: parsedChoice.rawContent,
            tool_calls: nativeCalls,
          });
          for (const tc of nativeCalls) {
            const tcName = tc?.function?.name || tc?.name || '';
            const tcArgs = tc?.function?.arguments ?? tc?.arguments ?? {};
            stepTools.push(tcName);
            dispatchEvent?.({ type: 'tool_start', step, tool: tcName, args: tcArgs });
            const t0 = Date.now();
            const result = await executeLocalModelTool(tcName, tcArgs, {
              cwd,
              allowWrite,
              env,
            });
            const durationMs = Date.now() - t0;
            const serialized =
              typeof result === 'string' ? result : JSON.stringify(result);
            const traceEntry = {
              step,
              tool: tcName,
              args: tcArgs,
              ok: !result?.error,
              durationMs,
              preview: serialized.slice(0, 220),
            };
            toolTrace.push(traceEntry);
            dispatchEvent?.({ type: 'tool_end', ...traceEntry });
            conversation.push({
              role: 'tool',
              tool_call_id: tc.id || `call_${step}_${toolTrace.length}`,
              name: tcName,
              content: serialized,
            });
          }
        } else {
          conversation.push({ role: 'assistant', content: parsedChoice.rawContent });
          const resultBlocks = [];
          for (const tc of textCalls) {
            stepTools.push(tc.name);
            dispatchEvent?.({ type: 'tool_start', step, tool: tc.name, args: tc.arguments });
            const t0 = Date.now();
            const result = await executeLocalModelTool(tc.name, tc.arguments, {
              cwd,
              allowWrite,
              env,
            });
            const durationMs = Date.now() - t0;
            const serialized =
              typeof result === 'string' ? result : JSON.stringify(result);
            const traceEntry = {
              step,
              tool: tc.name,
              args: tc.arguments,
              ok: !result?.error,
              durationMs,
              preview: serialized.slice(0, 220),
            };
            toolTrace.push(traceEntry);
            dispatchEvent?.({ type: 'tool_end', ...traceEntry });
            resultBlocks.push(
              `<tool_result name="${tc.name}">\n${serialized}\n</tool_result>`
            );
          }
          conversation.push({
            role: 'user',
            content: resultBlocks.join('\n\n'),
          });
        }
        thinkingSteps.push({
          step,
          ...(reasoning ? { reasoning } : {}),
          ...(stepNote ? { note: stepNote } : {}),
          tools: stepTools,
          latencyMs: reqOutcome.latencyMs,
        });
        continue;
      }

      thinkingSteps.push({
        step,
        ...(reasoning ? { reasoning } : {}),
        tools: [],
        latencyMs: reqOutcome.latencyMs,
      });
      replyText = parsedChoice.content || reasoning || '';
      break;
    }

    const combinedReasoning = combineThinkingTrace(thinkingSteps);

    if (!useExplicitMessages && sessionId) {
      appendChatSessionTurn(sessionId, userContent, replyText, resolvedModelId);
    }

    const output = {
      ok: true,
      ...(activeRunId ? { runId: activeRunId } : {}),
      model: lastModel || resolvedModelId,
      configuredModelId: targetModel?.modelId || resolvedModelId,
      displayName: targetModel?.displayName || resolvedModelId,
      agentName: targetModel?.agentName || '',
      baseUrl: resolvedBaseUrl,
      configuredHarness,
      harness: execHarness,
      ...(harnessAutoReason ? { harnessAutoReason } : {}),
      taskType: resolvedTaskType,
      maxThinkingLoops: effectiveMaxLoops,
      thinkingLevel: effective.thinkingLevel,
      verbose: effective.verbose,
      latencyMs: totalLatencyMs,
      reply: replyText,
      ...(combinedReasoning ? { reasoning: combinedReasoning } : {}),
      ...(thinkingSteps.length > 0 ? { thinkingSteps } : {}),
      finishReason: lastFinishReason,
      usage: totalUsage,
      sessionId: sessionId || null,
      autoDiscovered,
      ...(toolsEnabled
        ? {
            stepsUsed,
            maxThinkingLoops: effectiveMaxLoops,
            toolTrace,
            skillsAvailable: env.skills.length,
            mcpServersAvailable: env.mcpServers.length,
          }
        : {}),
    };
    recorder?.finish(output);
    return output;
  } catch (err) {
    recorder?.fail(err);
    throw err;
  }
}

/**
 * Runs an autonomous local subagent task using the user's configured local model
 * with full Antigravity skills, tools, rules, and MCP server access.
 */
export async function runLocalSubagent({
  task,
  modelId,
  cwd = process.cwd(),
  files,
  systemPrompt,
  maxSteps,
  maxThinkingLoops,
  allowWrite = true,
  sessionId,
  timeoutMs = 120000,
  harness,
  taskType,
  thinkingLevel,
  verbose,
  stream,
  runId,
  recordStream = true,
  onEvent = null,
} = {}) {
  const goal = String(task || '').trim();
  if (!goal) {
    throw new Error('A task description is required to run a local subagent.');
  }
  const subagentPrompt = [
    'You are running as an autonomous Antigravity local subagent.',
    'Use your workspace tools, Antigravity skills (activate_skill), rules, and MCP servers (list_mcp_tools / call_mcp_tool) to inspect files, run commands, verify facts, and complete the assigned task.',
    'Report concise, verified findings based strictly on tool output.',
    systemPrompt ? String(systemPrompt).trim() : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return await chatWithModel({
    modelId,
    prompt: goal,
    systemPrompt: subagentPrompt,
    files,
    sessionId,
    autoDiscover: true,
    enableTools: true,
    cwd,
    maxSteps,
    maxThinkingLoops,
    allowWrite,
    timeoutMs,
    harness,
    taskType,
    thinkingLevel,
    verbose,
    stream,
    runId,
    recordStream,
    _runKind: 'subagent',
    _taskLabel: goal,
    onEvent,
  });
}

export async function testModel({
  id,
  modelId,
  baseUrl,
  apiKey,
  prompt,
  harness,
  taskType,
  thinkingLevel,
  verbose,
  stream = false,
  runId = null,
  onEvent = null,
} = {}) {
  const configured = id ? resolveConfiguredModel(id) : modelId ? resolveConfiguredModel(modelId) : null;
  return chatWithModel({
    modelId: configured ? configured.modelId : modelId,
    baseUrl: baseUrl || configured?.baseUrl,
    apiKey: apiKey !== undefined ? apiKey : configured?.apiKey,
    systemPrompt: 'You are a concise verification assistant.',
    prompt: prompt || 'Reply with "OK" and your model name in one short sentence.',
    enableTools: false,
    temperature: 0.1,
    maxTokens: 256,
    timeoutMs: 30000,
    harness,
    taskType,
    thinkingLevel,
    verbose,
    stream,
    runId,
    recordStream: Boolean(runId),
    onEvent,
  });
}

/**
 * Extracts a zero-body public skeleton (imports + class/function signatures)
 * matching the AST-skeleton pattern from google-gemma/cookbook/apps/antigravity-hybrid-orchestrator.
 */
export function extractPublicSkeleton(sourceCode, fileName = 'module.py') {
  const lines = String(sourceCode || '').split(/\r?\n/);
  const imports = [];
  const globals = [];
  const defs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    if (/^(?:import |from .+ import )/.test(trimmed)) {
      imports.push(trimmed);
    } else if (/^(?:export\s+)?(?:async\s+)?(?:def |class |function )/.test(trimmed)) {
      defs.push(trimmed.replace(/[:{]\s*$/, ''));
    } else if (/^[A-Za-z_][A-Za-z0-9_]*\s*(?::[^=]+)?=\s*/.test(line)) {
      const varName = line.split(/[=:]/)[0].trim();
      if (varName) globals.push(varName);
    }
  }

  return {
    file: fileName,
    skeleton: `${fileName}: imports=[${imports.join('; ')}] globals=[${globals.join(', ')}] defs=[${defs.join('; ')}]`,
    imports,
    globals,
    defs,
  };
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

/**
 * Runs the Hybrid Orchestrator pattern (AST skeleton + minimal vs. defensive Builders + Blind Critic)
 * against any added OpenAI-compatible model.
 */
export async function runHybridOrchestration({
  modelId,
  fileName = 'snippet.py',
  sourceCode,
  task,
} = {}) {
  const configured = resolveConfiguredModel(modelId, { strict: Boolean(modelId) });
  if (!configured) {
    throw new Error('No added OpenAI-compatible model configured. Add a model first.');
  }

  const code = String(sourceCode || '').trim();
  if (!code) {
    throw new Error('sourceCode is required for hybrid orchestration');
  }
  const goal = String(task || 'Fix defects or security flaws while preserving the public API.');
  const { skeleton } = extractPublicSkeleton(code, fileName);

  const builderPrompts = [
    {
      name: 'minimal',
      instruction:
        'Builder (minimal): Make the smallest possible change that satisfies the task. Preserve all public signatures and globals. Return ONLY the updated code.',
    },
    {
      name: 'defensive',
      instruction:
        'Builder (defensive): Fix the issue and harden input validation and concurrency/error handling while preserving public signatures. Return ONLY the updated code.',
    },
  ];

  let localTokens = 0;
  const candidates = [];

  for (const builder of builderPrompts) {
    const prompt =
      `${builder.instruction}\n\n` +
      `Architectural Blueprint Skeleton:\n${skeleton}\n\n` +
      `Task: ${goal}\n\n` +
      `File ${fileName}:\n\`\`\`\n${code}\n\`\`\``;
    const res = await chatWithModel({
      modelId: configured.modelId,
      baseUrl: configured.baseUrl,
      apiKey: configured.apiKey,
      systemPrompt: 'You are a terse senior engineer. Output only clean code without extra commentary.',
      prompt,
      enableTools: false,
      recordStream: false,
      temperature: 0.2,
    });
    localTokens +=
      res.usage?.total_tokens || estimateTokens(prompt) + estimateTokens(res.reply);
    candidates.push({
      builder: builder.name,
      latencyMs: res.latencyMs,
      code: res.reply.trim(),
    });
  }

  const criticPrompt =
    `Two candidate rewrites of ${fileName} for task: ${goal}\n` +
    `Public Skeleton Invariant: ${skeleton}\n\n` +
    `Candidate 1 (${candidates[0].builder}):\n${candidates[0].code}\n\n` +
    `Candidate 2 (${candidates[1].builder}):\n${candidates[1].code}\n\n` +
    `Judge correctness, API preservation, and minimal risk. Reply with "1" or "2", then a dash, then under 15 words of justification.`;

  const criticRes = await chatWithModel({
    modelId: configured.modelId,
    baseUrl: configured.baseUrl,
    apiKey: configured.apiKey,
    systemPrompt: 'You are a strict blind code critic.',
    prompt: criticPrompt,
    enableTools: false,
    recordStream: false,
    temperature: 0.1,
    maxTokens: 160,
  });
  localTokens +=
    criticRes.usage?.total_tokens ||
    estimateTokens(criticPrompt) + estimateTokens(criticRes.reply);

  const match = criticRes.reply.match(/(?:^|\b)([12])(?:\b|$)/);
  const pickedIndex = match ? Number(match[1]) - 1 : 0;
  const winner = candidates[pickedIndex] || candidates[0];

  return {
    model: configured.modelId,
    baseUrl: configured.baseUrl,
    fileName,
    skeleton,
    cloudSkeletonTokens: estimateTokens(skeleton),
    localTokens,
    candidates,
    criticVerdict: criticRes.reply.trim(),
    winner,
  };
}

/**
 * Generates ready-to-run Google Antigravity Python SDK snippets for LocalOpenAIAgentConfig
 * and the Hybrid Orchestrator pattern.
 */
export function generateSdkSnippets(model, proxyBaseUrl = 'http://127.0.0.1:PORT/v1') {
  const m = model || {
    modelId: 'gemma4:26b',
    baseUrl: 'http://localhost:11434/v1',
    hasApiKey: false,
  };
  const needsProxy = Boolean(m.hasApiKey || m.apiKey);
  const effectiveUrl = needsProxy ? proxyBaseUrl : m.baseUrl;

  const basic = [
    'import asyncio',
    'from google.antigravity import Agent, LocalOpenAIAgentConfig',
    '',
    'async def main():',
    needsProxy
      ? `    # Routed via agy-local-agents sidecar proxy so your API key is injected cleanly`
      : `    # Direct OpenAI-compatible connection (https://antigravity.google/docs/sdk/local-models/)`,
    '    config = LocalOpenAIAgentConfig(',
    `        model="${m.modelId}",`,
    `        base_url="${effectiveUrl}",`,
    '    ).lightweight()',
    '',
    '    async with Agent(config=config) as agent:',
    '        response = await agent.chat("Inspect the workspace and summarize key files.")',
    '        async for token in response:',
    '            print(token, end="", flush=True)',
    '        print()',
    '',
    'if __name__ == "__main__":',
    '    asyncio.run(main())',
  ].join('\n');

  const hybrid = [
    '# Hybrid Architect (Cloud) + Local/Custom OpenAI Builders & Critic',
    '# Pattern: google-gemma/cookbook/apps/antigravity-hybrid-orchestrator',
    'import asyncio',
    'from google.antigravity import Agent, LocalAgentConfig, LocalOpenAIAgentConfig',
    '',
    `LOCAL_MODEL = "${m.modelId}"`,
    `LOCAL_BASE_URL = "${effectiveUrl}"`,
    '',
    'async def run_hybrid(skeleton_prompt: str, file_content: str):',
    '    architect_cfg = LocalAgentConfig(system_instructions="Emit a terse JSON fix blueprint.")',
    '    builder_cfg = LocalOpenAIAgentConfig(',
    '        model=LOCAL_MODEL,',
    '        base_url=LOCAL_BASE_URL,',
    '    ).lightweight()',
    '',
    '    async with Agent(architect_cfg) as architect:',
    '        blueprint = await (await architect.chat(skeleton_prompt)).text()',
    '',
    '    async with Agent(builder_cfg) as worker:',
    '        worker.conversation.clear_history()',
    '        patch = await (await worker.chat(f"Blueprint:\\n{blueprint}\\n\\nCode:\\n{file_content}")).text()',
    '        return patch',
  ].join('\n');

  return {
    modelId: m.modelId,
    baseUrl: m.baseUrl,
    effectiveUrl,
    usesAuthProxy: needsProxy,
    basic,
    hybrid,
  };
}
