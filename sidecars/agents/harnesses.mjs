/**
 * Extensible local-model harness registry, auto-routing classifier,
 * thinking-level resolver, and mini-SWE-agent control loop for agy-local-agents.
 */
import { basename, extname, resolve } from 'node:path';
import {
  discoverAntigravityEnvironment,
  executeLocalModelTool,
  getLocalModelToolSchemas,
  parseTextToolCalls,
} from './agentic.mjs';

export const MINI_SWE_MAX_OBSERVATION_CHARS = 10000;
export const MINI_SWE_HEAD_CHARS = 5000;
export const MINI_SWE_TAIL_CHARS = 5000;
export const MINI_SWE_SUBMISSION_MARKER = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT';
export const DEFAULT_MAX_THINKING_LOOPS = 10;
export const MIN_MAX_THINKING_LOOPS = 1;
export const MAX_MAX_THINKING_LOOPS = 50;

export const HARNESS_CATALOG = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Coding → mini-SWE · Knowledge → Native',
  },
  {
    id: 'native',
    label: 'Native',
    description: 'Antigravity tools, skills & MCP',
  },
  {
    id: 'mini-swe-agent',
    label: 'mini-SWE',
    description: 'Bash/SWE loop for coding tasks',
  },
];

export const THINKING_LEVELS = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Server default',
  },
  {
    id: 'off',
    label: 'Off',
    description: 'Disabled',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Minimal',
  },
  {
    id: 'low',
    label: 'Low',
    description: 'Low',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'Balanced',
  },
  {
    id: 'high',
    label: 'High',
    description: 'High',
  },
  {
    id: 'xhigh',
    label: 'Extra High',
    description: 'Maximum',
  },
];

const HARNESS_ALIASES = new Map([
  ['auto', 'auto'],
  ['automatic', 'auto'],
  ['smart', 'auto'],
  ['default', 'auto'],
  ['native', 'native'],
  ['antigravity', 'native'],
  ['antigravity-native', 'native'],
  ['agy-native', 'native'],
  ['mini-swe-agent', 'mini-swe-agent'],
  ['mini_swe_agent', 'mini-swe-agent'],
  ['minisweagent', 'mini-swe-agent'],
  ['mini-swe', 'mini-swe-agent'],
  ['mini_swe', 'mini-swe-agent'],
  ['mini', 'mini-swe-agent'],
  ['swe-agent', 'mini-swe-agent'],
  ['sweagent', 'mini-swe-agent'],
  ['mswea', 'mini-swe-agent'],
]);

const THINKING_ALIASES = new Map([
  ['auto', 'auto'],
  ['default', 'auto'],
  ['off', 'off'],
  ['none', 'off'],
  ['disable', 'off'],
  ['disabled', 'off'],
  ['minimal', 'minimal'],
  ['min', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['med', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['x-high', 'xhigh'],
  ['extra-high', 'xhigh'],
  ['extra_high', 'xhigh'],
  ['extra high', 'xhigh'],
  ['ultra', 'xhigh'],
  ['ultra-high', 'xhigh'],
  ['max', 'xhigh'],
]);

const THINKING_SYSTEM_HINTS = {
  off: 'Thinking mode: OFF. Respond directly and concisely without step-by-step internal chain-of-thought.',
  minimal: 'Thinking effort: minimal. Keep reasoning very brief and give a direct answer.',
  low: 'Thinking effort: low. Apply light reasoning before responding.',
  medium: 'Thinking effort: medium. Reason carefully through key steps before responding.',
  high: 'Thinking effort: high. Think thoroughly, verify edge cases, and double-check facts before responding.',
  xhigh:
    'Thinking effort: extra high (xhigh). Perform exhaustive deep reasoning, evaluate edge cases, and verify every claim carefully before responding.',
};

const CODE_FILE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.cpp',
  '.cc',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
  '.sh',
  '.bash',
  '.ps1',
  '.sql',
  '.svelte',
  '.vue',
  '.html',
  '.css',
  '.scss',
]);

const CODING_TERMS = [
  /\brefactor(?:ing|ed|s)?\b/i,
  /\bdebug(?:ging|ged)?\b/i,
  /\bunit\s+tests?\b/i,
  /\bpytest\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bnpm\s+test\b/i,
  /\bnode\s+--test\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bcompil(?:e|ing|ation)\b/i,
  /\bbuild\s+error\b/i,
  /\btypecheck\b/i,
  /\beslint\b/i,
  /\blinter\b/i,
  /\bgit\s+diff\b/i,
  /\bgit\s+commit\b/i,
  /\bpull\s+request\b/i,
  /\bstack\s+trace\b/i,
  /\bbug\s*fix\b/i,
  /\bfix\s+(?:the\s+)?bug\b/i,
  /\bfailing\s+test\b/i,
  /\bimplement\s+(?:a\s+|the\s+)?(?:function|class|method|endpoint|api|cli|script|component|module|hook|plugin)\b/i,
  /\bedit\s+(?:the\s+)?(?:code|script)\b/i,
  /\bwrite\s+(?:a\s+|the\s+)?(?:script|function|test|class|module|sql|regex)\b/i,
  /\bcodebase\b/i,
  /\brepository\b/i,
  /\brepo\b/i,
  /\bdockerfile\b/i,
  /\bci\/cd\b/i,
  /\bmiddleware\b/i,
  /\bmigration\b/i,
  /\bschema\b/i,
];

const KNOWLEDGE_TERMS = [
  /\bsummariz(?:e|ing|ation)\b/i,
  /\bsummary\b/i,
  /\bdraft\s+(?:an?\s+|the\s+)?(?:email|memo|letter|post|proposal|report|doc|document)\b/i,
  /\bessay\b/i,
  /\bblog\s+post\b/i,
  /\bmeeting\s+notes\b/i,
  /\bbrainstorm\b/i,
  /\bresearch\b/i,
  /\bcompare\s+options\b/i,
  /\bexecutive\s+summary\b/i,
  /\bpresentation\b/i,
  /\bslides\b/i,
  /\boutline\b/i,
  /\btranslat(?:e|ion)\b/i,
  /\bproofread\b/i,
  /\brewrite\s+(?:this\s+|the\s+)?(?:paragraph|email|text)\b/i,
  /\bexplain\s+(?:this\s+|the\s+)?concept\b/i,
  /\bknowledge\s+base\b/i,
  /\bliterature\s+review\b/i,
  /\bpolicy\b/i,
  /\bmarket\s+analysis\b/i,
  /\bagenda\b/i,
  /\bnotes\b/i,
];

/**
 * Registers or updates a harness descriptor in the extensible harness catalog.
 */
export function registerHarness(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
    throw new Error('Harness descriptor requires a non-empty id');
  }
  const cleanId = descriptor.id.trim().toLowerCase();
  const entry = {
    id: cleanId,
    label: String(descriptor.label || cleanId),
    description: String(descriptor.description || ''),
  };
  const existingIdx = HARNESS_CATALOG.findIndex((h) => h.id === cleanId);
  if (existingIdx >= 0) {
    HARNESS_CATALOG[existingIdx] = entry;
  } else {
    HARNESS_CATALOG.push(entry);
  }
  HARNESS_ALIASES.set(cleanId, cleanId);
  return entry;
}

/**
 * Looks up a harness descriptor by id (or alias).
 */
export function getHarnessDescriptor(id) {
  const normalized = normalizeHarness(id, '');
  if (!normalized) return null;
  return HARNESS_CATALOG.find((h) => h.id === normalized) || null;
}

/**
 * Normalizes a harness identifier or alias to a canonical harness id.
 */
export function normalizeHarness(id, fallback = 'auto') {
  if (typeof id !== 'string') return fallback;
  const trimmed = id.trim().toLowerCase();
  if (!trimmed || trimmed === 'inherit') return fallback;
  if (HARNESS_ALIASES.has(trimmed)) {
    return HARNESS_ALIASES.get(trimmed);
  }
  const catalogMatch = HARNESS_CATALOG.find((h) => h.id.toLowerCase() === trimmed);
  return catalogMatch ? catalogMatch.id : fallback;
}

/**
 * Normalizes UI density mode (`simple` | `advanced`).
 */
export function normalizeUiMode(mode, fallback = 'simple') {
  if (typeof mode !== 'string') return fallback;
  const lower = mode.trim().toLowerCase();
  if (lower === 'simple' || lower === 'basic') return 'simple';
  if (lower === 'advanced' || lower === 'adv' || lower === 'expert') return 'advanced';
  return fallback;
}

/**
 * Normalizes max thinking/tool loops (integer 1..50).
 */
export function normalizeMaxThinkingLoops(raw, fallback = DEFAULT_MAX_THINKING_LOOPS) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < MIN_MAX_THINKING_LOOPS) return MIN_MAX_THINKING_LOOPS;
  if (rounded > MAX_MAX_THINKING_LOOPS) return MAX_MAX_THINKING_LOOPS;
  return rounded;
}

/**
 * Normalizes caller-provided taskType (`coding` | `knowledge`).
 */
export function normalizeTaskType(raw) {
  if (typeof raw !== 'string') return '';
  const lower = raw.trim().toLowerCase();
  if (!lower || lower === 'auto') return '';
  if (
    ['coding', 'code', 'swe', 'dev', 'engineering', 'programming', 'debug', 'refactor', 'test'].includes(
      lower
    )
  ) {
    return 'coding';
  }
  if (
    [
      'knowledge',
      'writing',
      'research',
      'docs',
      'doc',
      'analysis',
      'planning',
      'general',
      'chat',
      'qa',
      'summary',
    ].includes(lower)
  ) {
    return 'knowledge';
  }
  return '';
}

/**
 * Routes a task between `mini-swe-agent` (coding) and `native` (knowledge work)
 * when harness is set to `auto`.
 */
export function classifyTaskForAutoHarness({ text = '', files = [], taskType = '' } = {}) {
  const explicit = normalizeTaskType(taskType);
  if (explicit === 'coding') {
    return { harness: 'mini-swe-agent', taskType: 'coding', reason: 'caller:coding' };
  }
  if (explicit === 'knowledge') {
    return { harness: 'native', taskType: 'knowledge', reason: 'caller:knowledge' };
  }

  let codingScore = 0;
  let knowledgeScore = 0;

  if (Array.isArray(files)) {
    for (const f of files) {
      const ext = extname(String(f || '').trim()).toLowerCase();
      if (CODE_FILE_EXTENSIONS.has(ext)) {
        codingScore += 3;
      }
    }
  }

  const content = String(text || '');
  if (/```[\s\S]*?```/.test(content)) {
    codingScore += 3;
  }
  if (
    /(?:TypeError|SyntaxError|ReferenceError|AssertionError):|Traceback \(most recent call last\)/i.test(
      content
    )
  ) {
    codingScore += 3;
  }

  for (const rx of CODING_TERMS) {
    if (rx.test(content)) codingScore += 2;
  }

  if (
    /\b[\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|cpp|c|cs|rb|php|sh|ps1|sql|svelte|vue)\b/i.test(
      content
    )
  ) {
    codingScore += 2;
  }

  for (const rx of KNOWLEDGE_TERMS) {
    if (rx.test(content)) knowledgeScore += 2;
  }

  if (codingScore >= 2 && codingScore > knowledgeScore) {
    return { harness: 'mini-swe-agent', taskType: 'coding', reason: 'auto:coding' };
  }
  return { harness: 'native', taskType: 'knowledge', reason: 'auto:knowledge' };
}

/**
 * Normalizes a thinking-level identifier or alias to a canonical level id.
 */
export function normalizeThinkingLevel(level, fallback = 'auto') {
  if (typeof level !== 'string') return fallback;
  const trimmed = level.trim().toLowerCase();
  if (!trimmed || trimmed === 'inherit') return fallback;
  return THINKING_ALIASES.get(trimmed) || fallback;
}

function normalizeOptionalBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
  }
  return undefined;
}

/**
 * Resolves effective harness, thinkingLevel, verbose thinking flag, and uiMode with precedence:
 * overrides -> model settings -> global state.agentSettings -> defaults.
 */
export function resolveEffectiveAgentConfig(state = {}, model = null, overrides = {}) {
  const globalHarness = normalizeHarness(state?.agentSettings?.harness, 'auto');
  const globalThinking = normalizeThinkingLevel(state?.agentSettings?.thinkingLevel, 'auto');
  const globalVerbose =
    state?.agentSettings?.verbose === undefined ? true : Boolean(state.agentSettings.verbose);
  const uiMode = normalizeUiMode(state?.agentSettings?.uiMode, 'simple');
  const globalMaxThinkingLoops = normalizeMaxThinkingLoops(
    state?.agentSettings?.maxThinkingLoops,
    DEFAULT_MAX_THINKING_LOOPS
  );

  const modelHarness = normalizeHarness(model?.harness, '');
  const modelThinking = normalizeThinkingLevel(model?.thinkingLevel, '');

  const overrideHarness = normalizeHarness(overrides?.harness, '');
  const overrideThinking = normalizeThinkingLevel(overrides?.thinkingLevel, '');
  const overrideVerbose = normalizeOptionalBool(overrides?.verbose);
  const rawOverrideLoops = overrides?.maxThinkingLoops ?? overrides?.maxSteps;
  const hasOverrideLoops =
    rawOverrideLoops !== undefined &&
    rawOverrideLoops !== null &&
    rawOverrideLoops !== '' &&
    Number.isFinite(Number(rawOverrideLoops));
  const maxThinkingLoops = hasOverrideLoops
    ? normalizeMaxThinkingLoops(rawOverrideLoops, globalMaxThinkingLoops)
    : globalMaxThinkingLoops;
  const maxThinkingLoopsSource = hasOverrideLoops
    ? 'override'
    : state?.agentSettings?.maxThinkingLoops !== undefined
      ? 'global'
      : 'default';

  let harness = globalHarness;
  let harnessSource = state?.agentSettings?.harness ? 'global' : 'default';
  if (overrideHarness) {
    harness = overrideHarness;
    harnessSource = 'override';
  } else if (modelHarness) {
    harness = modelHarness;
    harnessSource = 'model';
  }

  let thinkingLevel = globalThinking;
  let thinkingSource = state?.agentSettings?.thinkingLevel ? 'global' : 'default';
  if (overrideThinking) {
    thinkingLevel = overrideThinking;
    thinkingSource = 'override';
  } else if (modelThinking) {
    thinkingLevel = modelThinking;
    thinkingSource = 'model';
  }

  const verbose = overrideVerbose !== undefined ? overrideVerbose : globalVerbose;
  const verboseSource =
    overrideVerbose !== undefined
      ? 'override'
      : state?.agentSettings?.verbose !== undefined
        ? 'global'
        : 'default';

  return {
    harness,
    thinkingLevel,
    verbose,
    uiMode,
    maxThinkingLoops,
    taskType: normalizeTaskType(overrides?.taskType),
    harnessSource,
    thinkingSource,
    verboseSource,
    maxThinkingLoopsSource,
  };
}

/**
 * Maps thinkingLevel to OpenAI `reasoning_effort` and appends a concise hint to systemPrompt.
 * - `auto` -> omits `reasoning_effort` and leaves systemPrompt untouched
 * - `off` -> `reasoning_effort: 'none'`
 * - `minimal` / `low` / `medium` / `high` / `xhigh` -> that exact string
 */
export function applyThinkingToPayload(payload = {}, systemPrompt = '', thinkingLevel = 'auto') {
  const level = normalizeThinkingLevel(thinkingLevel, 'auto');
  const targetPayload = payload && typeof payload === 'object' ? payload : {};
  const basePrompt = systemPrompt ? String(systemPrompt) : '';

  if (level === 'auto') {
    delete targetPayload.reasoning_effort;
    return {
      payload: targetPayload,
      systemPrompt: basePrompt,
      thinkingLevel: level,
      reasoningEffort: undefined,
    };
  }

  const reasoningEffort = level === 'off' ? 'none' : level;
  targetPayload.reasoning_effort = reasoningEffort;

  const hint = THINKING_SYSTEM_HINTS[level] || '';
  let nextPrompt = basePrompt;
  if (hint && !basePrompt.includes(hint)) {
    nextPrompt = basePrompt ? `${basePrompt.trim()}\n\n${hint}` : hint;
  }

  return {
    payload: targetPayload,
    systemPrompt: nextPrompt,
    thinkingLevel: level,
    reasoningEffort,
  };
}

/**
 * Extracts a concise error detail string from a failed HTTP response.
 */
export async function parseHttpErrorDetail(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const errText = await res.text();
    if (!errText) return detail;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) return String(parsed.error.message);
      if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim();
      if (parsed?.message) return String(parsed.message);
      if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim();
      if (Array.isArray(parsed?.detail) && parsed.detail.length > 0) {
        return JSON.stringify(parsed.detail).slice(0, 240);
      }
      return `${detail}: ${errText.slice(0, 200)}`;
    } catch {
      return `${detail}: ${errText.slice(0, 200)}`;
    }
  } catch {
    return detail;
  }
}

/**
 * Returns true if an upstream HTTP 400/422/500 error indicates rejection of `reasoning_effort`.
 */
export function isUnsupportedReasoningEffortError(status, detail = '') {
  const code = Number(status);
  if (![400, 422, 500].includes(code)) return false;
  const msg = String(detail || '');
  if (/reasoning[_\s-]?effort|reasoning/i.test(msg)) return true;
  if (
    (code === 400 || code === 422) &&
    /unrecognized|unknown\s*(?:field|param|key|property)|extra[_\s]+(?:fields|inputs)|additional\s*properties|unsupported\s*(?:param|field|option)|invalid\s*(?:request|param|field)/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

function isUnsupportedToolsError(status, detail = '') {
  return [400, 422, 500, 501].includes(Number(status)) && /tool|function/i.test(String(detail || ''));
}

function isUnsupportedStreamError(status, detail = '') {
  return [400, 422, 500, 501].includes(Number(status)) && /\bstream\b|sse/i.test(String(detail || ''));
}

/**
 * Extracts explicit `reasoning_content` / `reasoning` plus inline `<think>...</think>` or
 * `<thought>...</thought>` tags from an OpenAI chat completion choice without mutating raw text.
 */
export function extractChoiceReasoningAndContent(choice) {
  const rawContent =
    typeof choice?.message?.content === 'string'
      ? choice.message.content
      : typeof choice?.text === 'string'
        ? choice.text
        : choice?.message?.content != null
          ? JSON.stringify(choice.message.content)
          : '';

  const explicitReasoning = [
    choice?.message?.reasoning_content,
    choice?.message?.reasoning,
    choice?.reasoning_content,
    choice?.reasoning,
  ]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join('\n\n');

  const tagParts = [];
  let visible = String(rawContent || '');
  visible = visible.replace(/<(think|thought)>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => {
    const cleaned = String(inner || '').trim();
    if (cleaned) tagParts.push(cleaned);
    return '';
  });
  visible = visible.replace(/<(think|thought)>([\s\S]*)$/gi, (_, _tag, inner) => {
    const cleaned = String(inner || '').trim();
    if (cleaned) tagParts.push(cleaned);
    return '';
  });

  const combinedParts = [];
  if (explicitReasoning) combinedParts.push(explicitReasoning);
  if (tagParts.length > 0) {
    const tagCombined = tagParts.join('\n\n');
    if (tagCombined !== explicitReasoning) {
      combinedParts.push(tagCombined);
    }
  }

  return {
    content: visible.trim(),
    rawContent: String(rawContent || ''),
    reasoning: combinedParts.join('\n\n'),
  };
}

/**
 * Combines per-step reasoning + pre-tool narrative notes into a clean readable block.
 */
export function combineThinkingTrace(thinkingSteps = []) {
  if (!Array.isArray(thinkingSteps) || thinkingSteps.length === 0) return '';
  const activeSteps = thinkingSteps.filter(
    (s) => (s.reasoning && s.reasoning.trim()) || (s.note && s.note.trim())
  );
  if (activeSteps.length === 0) return '';
  if (activeSteps.length === 1 && !activeSteps[0].note) {
    return activeSteps[0].reasoning.trim();
  }
  return activeSteps
    .map((s) => {
      const parts = [];
      if (s.reasoning && s.reasoning.trim()) parts.push(s.reasoning.trim());
      if (s.note && s.note.trim() && s.note.trim() !== (s.reasoning || '').trim()) {
        parts.push(s.note.trim());
      }
      if (activeSteps.length === 1) return parts.join('\n\n');
      return `[Step ${s.step}]\n${parts.join('\n\n')}`;
    })
    .join('\n\n');
}

/**
 * Formats thinking steps & tool traces as readable Markdown for chat hooks and agents.
 */
export function formatVerboseThinkingMarkdown(
  res = {},
  { open = true, includeTools = true } = {}
) {
  const sections = [];
  const steps = Array.isArray(res?.thinkingSteps)
    ? res.thinkingSteps.filter(
        (s) => (s.reasoning && s.reasoning.trim()) || (s.note && s.note.trim())
      )
    : [];

  if (steps.length > 0) {
    const body = steps
      .map((s) => {
        const lines = [];
        if (steps.length > 1) {
          lines.push(`**Step ${s.step}**`);
        }
        if (s.reasoning && s.reasoning.trim()) {
          lines.push(s.reasoning.trim());
        }
        if (s.note && s.note.trim() && s.note.trim() !== (s.reasoning || '').trim()) {
          lines.push(`*Thought:* ${s.note.trim()}`);
        }
        return lines.join('\n\n');
      })
      .join('\n\n---\n\n');
    const openAttr = open ? ' open' : '';
    sections.push(
      `\n\n<details${openAttr}><summary>Thinking (${steps.length} step${steps.length === 1 ? '' : 's'})</summary>\n\n${body}\n\n</details>`
    );
  } else if (typeof res?.reasoning === 'string' && res.reasoning.trim()) {
    const openAttr = open ? ' open' : '';
    sections.push(
      `\n\n<details${openAttr}><summary>Thinking</summary>\n\n${res.reasoning.trim()}\n\n</details>`
    );
  }

  if (includeTools && Array.isArray(res?.toolTrace) && res.toolTrace.length > 0) {
    const traceLines = res.toolTrace
      .map((t) => {
        const preview = t.preview ? ` — \`${String(t.preview).replace(/`/g, "'").slice(0, 100)}\`` : '';
        return `- **Step ${t.step || '?'}** \`${t.tool}\` (${t.ok ? 'ok' : 'err'}, ${t.durationMs}ms)${preview}`;
      })
      .join('\n');
    const openAttr = open ? ' open' : '';
    sections.push(
      `\n\n<details${openAttr}><summary>Tools &amp; skills used (${res.toolTrace.length})</summary>\n\n${traceLines}\n\n</details>`
    );
  }

  return sections.join('');
}

function createThinkTagStreamSplitter(onToken) {
  let inThink = false;
  let pending = '';

  const OPEN_TAGS = ['<think>', '<thought>'];
  const CLOSE_TAGS = ['</think>', '</thought>'];

  function findNextTag(buf, tags) {
    let best = null;
    const lower = buf.toLowerCase();
    for (const tag of tags) {
      const idx = lower.indexOf(tag);
      if (idx >= 0 && (!best || idx < best.idx)) {
        best = { idx, len: tag.length };
      }
    }
    return best;
  }

  function flushSafe(tags) {
    let maxKeep = 0;
    const lower = pending.toLowerCase();
    for (const tag of tags) {
      for (let len = Math.min(pending.length, tag.length - 1); len >= 1; len -= 1) {
        if (lower.endsWith(tag.slice(0, len))) {
          maxKeep = Math.max(maxKeep, len);
          break;
        }
      }
    }
    if (pending.length > maxKeep) {
      const emit = pending.slice(0, pending.length - maxKeep);
      pending = pending.slice(pending.length - maxKeep);
      if (emit) onToken({ kind: inThink ? 'thinking' : 'content', text: emit });
    }
  }

  return {
    push(chunk) {
      pending += String(chunk || '');
      while (pending.length > 0) {
        const tags = inThink ? CLOSE_TAGS : OPEN_TAGS;
        const hit = findNextTag(pending, tags);
        if (!hit) {
          flushSafe(tags);
          break;
        }
        const before = pending.slice(0, hit.idx);
        if (before) onToken({ kind: inThink ? 'thinking' : 'content', text: before });
        pending = pending.slice(hit.idx + hit.len);
        inThink = !inThink;
      }
    },
    end() {
      if (pending) {
        onToken({ kind: inThink ? 'thinking' : 'content', text: pending });
        pending = '';
      }
    },
  };
}

async function consumeSseChatStream(res, fallbackModel, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let model = fallbackModel;
  let id = '';
  let finishReason = null;
  let usage = null;
  let reasoning = '';
  let rawContent = '';
  const toolCallMap = new Map();
  const emitToken = typeof onToken === 'function' ? onToken : () => {};
  const splitter = createThinkTagStreamSplitter(emitToken);

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (parsed.id) id = parsed.id;
    if (parsed.model) model = parsed.model;
    if (parsed.usage) usage = parsed.usage;
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};

    const rDelta =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
    if (rDelta) {
      reasoning += rDelta;
      emitToken({ kind: 'thinking', text: rDelta });
    }

    if (typeof delta.content === 'string' && delta.content) {
      rawContent += delta.content;
      splitter.push(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc?.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, {
            id: tc.id || `call_stream_${idx}`,
            type: tc.type || 'function',
            function: { name: '', arguments: '' },
          });
        }
        const entry = toolCallMap.get(idx);
        if (tc.id) entry.id = tc.id;
        if (tc.type) entry.type = tc.type;
        if (tc.function?.name) entry.function.name += tc.function.name;
        if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);
      processLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) processLine(line);
  }
  splitter.end();

  const toolCalls = [...toolCallMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  const message = {
    role: 'assistant',
    content: rawContent,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    id: id || 'chatcmpl-stream',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Posts an OpenAI chat/completions request with automatic fallback retry when an upstream
 * server rejects `reasoning_effort` (HTTP 400/422/500), `tools`, or `stream`.
 */
export async function requestChatCompletionWithFallbacks({
  endpoint,
  headers,
  payload,
  timeoutMs = 90000,
  allowToolsFallback = true,
  allowReasoningFallback = true,
  stream = false,
  onToken = null,
  fetchImpl = fetch,
} = {}) {
  const activePayload = { ...payload };
  if (stream && typeof onToken === 'function') {
    activePayload.stream = true;
  }
  let latencyMs = 0;
  let reasoningEffortRejected = false;
  let toolsRejected = false;
  let streamed = false;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = Date.now();
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: activePayload.stream
        ? { ...headers, Accept: 'text/event-stream, application/json' }
        : headers,
      body: JSON.stringify(activePayload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
      let json;
      if (contentType.includes('text/event-stream') && res.body) {
        json = await consumeSseChatStream(res, activePayload.model, onToken);
        streamed = true;
      } else {
        json = await res.json();
        if (typeof onToken === 'function') {
          const parsed = extractChoiceReasoningAndContent(json?.choices?.[0]);
          if (parsed.reasoning) onToken({ kind: 'thinking', text: parsed.reasoning });
          if (parsed.content) onToken({ kind: 'content', text: parsed.content });
          streamed = true;
        }
      }
      latencyMs += Date.now() - started;
      return {
        json,
        latencyMs,
        reasoningEffortRejected,
        toolsRejected,
        streamed,
      };
    }

    latencyMs += Date.now() - started;
    const detail = await parseHttpErrorDetail(res);

    if (activePayload.stream && isUnsupportedStreamError(res.status, detail)) {
      activePayload.stream = false;
      continue;
    }

    if (
      allowReasoningFallback &&
      activePayload.reasoning_effort !== undefined &&
      isUnsupportedReasoningEffortError(res.status, detail)
    ) {
      delete activePayload.reasoning_effort;
      reasoningEffortRejected = true;
      continue;
    }

    if (
      allowToolsFallback &&
      activePayload.tools !== undefined &&
      isUnsupportedToolsError(res.status, detail)
    ) {
      delete activePayload.tools;
      delete activePayload.tool_choice;
      toolsRejected = true;
      continue;
    }

    throw new Error(`Chat completion failed at ${endpoint} (${detail})`);
  }

  throw new Error(`Chat completion failed at ${endpoint} after fallback retries`);
}

/**
 * Formats command/tool execution output using mini-swe-agent's `observation_template`
 * with a 10,000-char limit (5,000-char head + `<elided_chars>` + 5,000-char tail).
 */
export function formatMiniSweObservation({
  returncode,
  exitCode,
  output,
  stdout,
  stderr,
  error,
  timedOut,
} = {}) {
  const code =
    returncode !== undefined
      ? Number(returncode)
      : exitCode !== undefined
        ? Number(exitCode)
        : error
          ? 1
          : 0;

  let text;
  if (typeof output === 'string') {
    text = output;
  } else {
    const parts = [];
    if (stdout) parts.push(String(stdout));
    if (stderr) parts.push(String(stderr));
    if (error && !parts.length) parts.push(String(error));
    if (timedOut) parts.push('[Command timed out]');
    text = parts.join('\n');
  }

  if (text.length <= MINI_SWE_MAX_OBSERVATION_CHARS) {
    return `<returncode>${code}</returncode>\n<output>\n${text}\n</output>`;
  }

  const elided = text.length - MINI_SWE_MAX_OBSERVATION_CHARS;
  const head = text.slice(0, MINI_SWE_HEAD_CHARS);
  const tail = text.slice(-MINI_SWE_TAIL_CHARS);
  return [
    `<returncode>${code}</returncode>`,
    '<warning>',
    'The output of your last command was too long. Please try a different command that produces less output. If you are looking at a file you can try using head, tail, or selective line reads.',
    '</warning>',
    '<output_head>',
    head,
    '</output_head>',
    '<elided_chars>',
    `${elided} characters elided`,
    '</elided_chars>',
    '<output_tail>',
    tail,
    '</output_tail>',
  ].join('\n');
}

/**
 * Formats the mini-swe-agent `system_template` enriched with Antigravity skills, rules, and MCP servers.
 */
export function buildMiniSweSystemPrompt({
  cwd = process.cwd(),
  env = discoverAntigravityEnvironment({ cwd }),
  systemPrompt = '',
  allowWrite = true,
} = {}) {
  const skillsLines = (env?.skills || [])
    .map((s) => {
      const desc = s.description ? s.description.slice(0, 180) : '';
      return `- ${s.name}: ${desc}${s.description && s.description.length > 180 ? '...' : ''}`;
    })
    .join('\n');

  const mcpLines = (env?.mcpServers || [])
    .map(
      (s) =>
        `- ${s.name} (${s.command ? `${s.command} ${(s.args || []).join(' ')}`.trim() : s.url || 'configured'})`
    )
    .join('\n');

  const rulesBlock = (env?.rules || [])
    .map((r) => `Rule (${basename(r.path)}):\n${r.content}`)
    .join('\n\n');

  const actionGuide = allowWrite
    ? [
        '## mini-SWE-agent Control Flow & Antigravity Tools',
        'You may act via native function tools (`bash`, `run_command`, `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `list_skills`, `activate_skill`, `list_mcp_tools`, `call_mcp_tool`) OR by emitting EXACTLY ONE fenced bash command block per turn:',
        '```mswea_bash_command',
        'your_command_here',
        '```',
        '- Wait for the `<returncode>` and `<output>` observation after each step before continuing.',
        '- If a task matches an available skill below, call `activate_skill` first.',
        '- Do not fabricate file contents or command output.',
        `- When the task is completely finished and verified, submit by running \`echo ${MINI_SWE_SUBMISSION_MARKER}\` (optionally printing your final summary on subsequent lines) OR respond with \`${MINI_SWE_SUBMISSION_MARKER}\` followed by your final report.`,
      ]
    : [
        '## mini-SWE-agent Control Flow (Read-Only Mode)',
        'Write and shell command tools are disabled in read-only mode. Use read-only Antigravity tools (`read_file`, `list_dir`, `search_files`, `list_skills`, `activate_skill`, `list_mcp_tools`, `call_mcp_tool`) to inspect the workspace.',
        `- When finished, begin your final response with \`${MINI_SWE_SUBMISSION_MARKER}\` followed by your verified report.`,
      ];

  const sections = [
    'You are a helpful assistant operating with the mini-SWE-agent harness inside Antigravity.',
    `Workspace cwd: ${env?.cwd || resolve(cwd)}\nOS: ${process.platform}\nWrite/Command access: ${allowWrite ? 'enabled' : 'read-only'}`,
    actionGuide.join('\n'),
  ];

  if (skillsLines) sections.push(`<skills>\n${skillsLines}\n</skills>`);
  if (mcpLines) sections.push(`<mcp_servers>\n${mcpLines}\n</mcp_servers>`);
  if (rulesBlock) sections.push(`<rules>\n${rulesBlock}\n</rules>`);
  if (systemPrompt && String(systemPrompt).trim()) {
    sections.push(String(systemPrompt).trim());
  }

  return sections.join('\n\n');
}

/**
 * Formats the mini-swe-agent `instance_template` for a user task.
 */
export function formatMiniSweInstancePrompt(
  task,
  { cwd = process.cwd(), allowWrite = true } = {}
) {
  const text = String(task || '').trim();
  const actionLine = allowWrite
    ? `- Use \`bash\` (or a \`\`\`mswea_bash_command\`\`\` block) and Antigravity tools (\`read_file\`, \`edit_file\`, \`write_file\`, \`search_files\`, \`activate_skill\`, \`call_mcp_tool\`) to inspect and verify.`
    : `- Use read-only Antigravity tools (\`read_file\`, \`list_dir\`, \`search_files\`, \`activate_skill\`, \`list_mcp_tools\`, \`call_mcp_tool\`) to inspect and verify.`;
  return [
    '<pr_description>',
    `Please solve this task:\n${text}`,
    '</pr_description>',
    '',
    '<instructions>',
    `- Workspace directory: ${resolve(cwd || process.cwd())}`,
    actionLine,
    `- When completely finished, submit via \`echo ${MINI_SWE_SUBMISSION_MARKER}\` (or output \`${MINI_SWE_SUBMISSION_MARKER}\` followed by your final answer).`,
    '</instructions>',
  ].join('\n');
}

/**
 * Formats the mini-swe-agent `format_error_template` retry message.
 */
export function formatMiniSweFormatError(actionCount = 0, { allowWrite = true } = {}) {
  const lines = [
    `Please always provide EXACTLY ONE action in triple backticks, found ${actionCount} actions.`,
    'Please call an available tool (such as `bash`, `read_file`, `edit_file`, `write_file`, `list_dir`, `search_files`, `activate_skill`, or `call_mcp_tool`) OR format your bash command in triple backticks as shown in <response_example>.',
    `If you have finished the task, submit by running \`echo ${MINI_SWE_SUBMISSION_MARKER}\` or outputting \`${MINI_SWE_SUBMISSION_MARKER}\` followed by your final response.`,
  ];
  if (allowWrite) {
    lines.push(
      '<response_example>',
      'Here are some thoughts about why you want to perform the action.',
      '```mswea_bash_command',
      '<action>',
      '```',
      '</response_example>'
    );
  }
  return lines.join('\n');
}

/**
 * Extracts `mswea_bash_command` fenced blocks from assistant plain-text output.
 */
export function parseMiniSweBashBlocks(content) {
  const text = String(content || '');
  if (!text) return [];
  const commands = [];
  const regex = /```mswea_bash_command[ \t]*\r?\n([\s\S]*?)```/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const cmd = match[1].replace(/\r\n$/, '').trim();
    if (cmd) commands.push(cmd);
  }
  return commands;
}

function stripMsweaBlocks(content) {
  return String(content || '')
    .replace(/```mswea_bash_command[ \t]*\r?\n[\s\S]*?```/gi, '')
    .trim();
}

function stripSubmissionSentinelFromText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === MINI_SWE_SUBMISSION_MARKER) continue;
    if (trimmed.startsWith(MINI_SWE_SUBMISSION_MARKER)) {
      const rest = trimmed
        .slice(MINI_SWE_SUBMISSION_MARKER.length)
        .replace(/^[\s:–—-]+/, '')
        .trim();
      if (rest) kept.push(rest);
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function checkMiniSweCommandSubmission(toolResult, assistantContent = '') {
  const stdout = String(toolResult?.stdout ?? '');
  const lines = stdout.replace(/\r\n/g, '\n').trimStart().split('\n');
  const first = (lines[0] || '').trim();
  const matchesMarker =
    first === MINI_SWE_SUBMISSION_MARKER ||
    first.startsWith(`${MINI_SWE_SUBMISSION_MARKER} `) ||
    first.startsWith(`${MINI_SWE_SUBMISSION_MARKER}:`);

  if (!matchesMarker) {
    return { submitted: false, output: '' };
  }

  const afterFirstLine = lines.slice(1).join('\n').trim();
  const afterMarkerOnFirst = first
    .slice(MINI_SWE_SUBMISSION_MARKER.length)
    .replace(/^[\s:–—-]+/, '')
    .trim();
  const assistantText = stripSubmissionSentinelFromText(stripMsweaBlocks(assistantContent));

  return {
    submitted: true,
    output:
      afterFirstLine ||
      afterMarkerOnFirst ||
      assistantText ||
      MINI_SWE_SUBMISSION_MARKER,
  };
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

function buildMiniSweToolObservation(toolName, result) {
  if (toolName === 'bash' || toolName === 'run_command') {
    return formatMiniSweObservation({
      returncode: result?.error ? 1 : result?.exitCode ?? 0,
      stdout: result?.stdout,
      stderr: result?.stderr,
      error: result?.error,
      timedOut: result?.timedOut,
    });
  }
  const serialized = typeof result === 'string' ? result : JSON.stringify(result);
  return formatMiniSweObservation({
    returncode: result?.error ? 1 : 0,
    output: serialized,
  });
}

/**
 * Executes the mini-SWE-agent multi-step loop (`DefaultAgent` + `mini.yaml` + `default.yaml`)
 * enriched with Antigravity workspace tools, skills, rules, and MCP servers.
 */
export async function runMiniSweAgentLoop({
  endpoint,
  headers = { 'Content-Type': 'application/json', Accept: 'application/json' },
  modelId,
  configuredModelId,
  displayName,
  agentName = '',
  baseUrl,
  apiKey = '',
  autoDiscovered = false,
  configuredHarness = 'mini-swe-agent',
  harnessAutoReason = '',
  runId = null,
  messages,
  userContent = '',
  prompt = '',
  systemPrompt = '',
  historyMessages = [],
  cwd = process.cwd(),
  env,
  allowWrite = true,
  maxSteps = 12,
  temperature = 0.2,
  maxTokens,
  timeoutMs = 90000,
  thinkingLevel = 'auto',
  maxConsecutiveFormatErrors = 3,
  sessionId = null,
  toolSchemas,
  executeTool = executeLocalModelTool,
  fetchImpl = fetch,
  stream = false,
  onEvent = null,
} = {}) {
  const resolvedBaseUrl = baseUrl || (endpoint ? endpoint.replace(/\/chat\/completions\/?$/, '') : '');
  const resolvedEndpoint = endpoint || `${resolvedBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  if (!resolvedEndpoint) {
    throw new Error('endpoint or baseUrl is required for runMiniSweAgentLoop');
  }

  const reqHeaders = { ...headers };
  if (apiKey && !reqHeaders.Authorization) {
    reqHeaders.Authorization = `Bearer ${apiKey}`;
  }

  const resolvedEnv = env || discoverAntigravityEnvironment({ cwd });
  const baseSystemPrompt = buildMiniSweSystemPrompt({
    cwd,
    env: resolvedEnv,
    systemPrompt,
    allowWrite,
  });

  const thinkingApplied = applyThinkingToPayload({}, baseSystemPrompt, thinkingLevel);
  const effectiveSystemPrompt = thinkingApplied.systemPrompt;
  const normalizedThinkingLevel = thinkingApplied.thinkingLevel;
  const initialReasoningEffort = thinkingApplied.reasoningEffort;

  const taskText = String(userContent || prompt || '').trim() || 'Hello!';
  const useExplicitMessages = Array.isArray(messages) && messages.length > 0;
  const conversation = useExplicitMessages
    ? messages[0]?.role === 'system'
      ? [
          {
            ...messages[0],
            content: applyThinkingToPayload({}, messages[0].content, thinkingLevel).systemPrompt,
          },
          ...messages.slice(1),
        ]
      : [{ role: 'system', content: effectiveSystemPrompt }, ...messages]
    : [
        { role: 'system', content: effectiveSystemPrompt },
        ...historyMessages,
        {
          role: 'user',
          content: formatMiniSweInstancePrompt(taskText, { cwd, allowWrite }),
        },
      ];

  const effectiveToolSchemas =
    toolSchemas || getLocalModelToolSchemas({ allowWrite });
  const stepBudget = Math.max(1, Number(maxSteps) || 12);
  const maxFormatErrors = Math.max(1, Number(maxConsecutiveFormatErrors) || 3);

  let sendToolsSchema = Boolean(effectiveToolSchemas?.length);
  let sendReasoningEffort = Boolean(initialReasoningEffort);

  const toolTrace = [];
  const thinkingSteps = [];
  const emitEvent = typeof onEvent === 'function' ? onEvent : null;
  let totalLatencyMs = 0;
  let totalUsage = null;
  let stepsUsed = 0;
  let lastModel = modelId;
  let lastFinishReason = null;
  let replyText = '';
  let consecutiveFormatErrors = 0;
  let formatErrorsTotal = 0;
  let submitted = false;

  const pushThinkingStep = (step, reasoning, note, stepTools, stepLatencyMs) => {
    thinkingSteps.push({
      step,
      ...(reasoning ? { reasoning } : {}),
      ...(note ? { note } : {}),
      tools: stepTools,
      latencyMs: stepLatencyMs,
    });
  };

  for (let step = 1; step <= stepBudget; step += 1) {
    const isLastStep = step === stepBudget;
    emitEvent?.({
      type: 'step_start',
      step,
      maxSteps: stepBudget,
      harness: 'mini-swe-agent',
      ...(configuredHarness ? { configuredHarness } : {}),
      ...(harnessAutoReason ? { harnessAutoReason } : {}),
      ...(runId ? { runId } : {}),
    });
    const payload = {
      model: modelId,
      messages: conversation,
      temperature,
      stream: false,
    };
    if (sendToolsSchema && !isLastStep && effectiveToolSchemas?.length) {
      payload.tools = effectiveToolSchemas;
      payload.tool_choice = 'auto';
    }
    if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
      payload.max_tokens = Math.round(Number(maxTokens));
    }
    if (sendReasoningEffort && initialReasoningEffort) {
      payload.reasoning_effort = initialReasoningEffort;
    }

    const reqOutcome = await requestChatCompletionWithFallbacks({
      endpoint: resolvedEndpoint,
      headers: reqHeaders,
      payload,
      timeoutMs,
      allowToolsFallback: sendToolsSchema && !isLastStep,
      allowReasoningFallback: sendReasoningEffort,
      stream: Boolean(stream && emitEvent),
      onToken: emitEvent
        ? (tok) =>
            emitEvent({
              type: tok.kind === 'thinking' ? 'thinking_delta' : 'content_delta',
              step,
              text: tok.text,
            })
        : null,
      fetchImpl,
    });

    totalLatencyMs += reqOutcome.latencyMs;
    if (reqOutcome.reasoningEffortRejected) sendReasoningEffort = false;
    if (reqOutcome.toolsRejected) sendToolsSchema = false;

    const json = reqOutcome.json;
    stepsUsed += 1;
    if (json?.model) lastModel = json.model;
    totalUsage = accumulateUsage(totalUsage, json?.usage);

    const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
    lastFinishReason = choice?.finish_reason || null;
    const parsedChoice = extractChoiceReasoningAndContent(choice);
    const rawContent = parsedChoice.content || parsedChoice.rawContent;
    const reasoning = parsedChoice.reasoning;

    const nativeCalls = Array.isArray(choice?.message?.tool_calls)
      ? choice.message.tool_calls
      : [];

    const runStepTool = async (tcName, tcArgs) => {
      emitEvent?.({ type: 'tool_start', step, tool: tcName, args: tcArgs });
      const t0 = Date.now();
      const result = await executeTool(tcName, tcArgs, {
        cwd,
        allowWrite,
        env: resolvedEnv,
      });
      const durationMs = Date.now() - t0;
      const rawSerialized = typeof result === 'string' ? result : JSON.stringify(result);
      const traceEntry = {
        step,
        tool: tcName,
        args: tcArgs,
        ok: !result?.error,
        durationMs,
        preview: rawSerialized.slice(0, 220),
      };
      toolTrace.push(traceEntry);
      emitEvent?.({ type: 'tool_end', ...traceEntry });
      return { result, rawSerialized };
    };

    if (isLastStep) {
      const bashBlocks = parseMiniSweBashBlocks(rawContent);
      const stepNote = bashBlocks.length > 0 ? stripMsweaBlocks(rawContent) : '';
      const stepTools = [];
      if (stepNote && stepNote !== reasoning) {
        emitEvent?.({ type: 'assistant_note', step, text: stepNote });
      }
      if (
        bashBlocks.length === 1 &&
        bashBlocks[0].includes(MINI_SWE_SUBMISSION_MARKER) &&
        allowWrite
      ) {
        const { result } = await runStepTool('bash', { command: bashBlocks[0] });
        stepTools.push('bash');
        pushThinkingStep(step, reasoning, stepNote, stepTools, reqOutcome.latencyMs);
        const check = checkMiniSweCommandSubmission(result, rawContent);
        if (check.submitted) {
          submitted = true;
          lastFinishReason = 'submitted';
          replyText = check.output;
          break;
        }
      } else {
        pushThinkingStep(step, reasoning, stepNote, stepTools, reqOutcome.latencyMs);
      }
      if (rawContent.includes(MINI_SWE_SUBMISSION_MARKER)) {
        submitted = true;
        lastFinishReason = 'submitted';
        replyText =
          stripSubmissionSentinelFromText(stripMsweaBlocks(rawContent)) ||
          MINI_SWE_SUBMISSION_MARKER;
        break;
      }
      replyText = stripMsweaBlocks(rawContent) || rawContent || reasoning || '';
      break;
    }

    if (nativeCalls.length > 0) {
      consecutiveFormatErrors = 0;
      const stepNote = stripMsweaBlocks(parsedChoice.content || '');
      if (stepNote && stepNote !== reasoning) {
        emitEvent?.({ type: 'assistant_note', step, text: stepNote });
      }
      conversation.push({
        role: 'assistant',
        content: parsedChoice.rawContent,
        tool_calls: nativeCalls,
      });

      const stepTools = [];
      let submittedOutput = '';
      for (const tc of nativeCalls) {
        const tcName = tc?.function?.name || tc?.name || '';
        const tcArgs = tc?.function?.arguments ?? tc?.arguments ?? {};
        stepTools.push(tcName);
        const { result } = await runStepTool(tcName, tcArgs);
        const obs = buildMiniSweToolObservation(tcName, result);
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id || `call_${step}_${toolTrace.length}`,
          name: tcName,
          content: obs,
        });

        if (tcName === 'bash' || tcName === 'run_command') {
          const check = checkMiniSweCommandSubmission(result, rawContent);
          if (check.submitted) {
            submitted = true;
            submittedOutput = check.output;
          }
        }
      }
      pushThinkingStep(step, reasoning, stepNote, stepTools, reqOutcome.latencyMs);

      if (submitted) {
        lastFinishReason = 'submitted';
        replyText = submittedOutput;
        break;
      }
      continue;
    }

    const bashBlocks = parseMiniSweBashBlocks(rawContent);
    if (bashBlocks.length === 1) {
      consecutiveFormatErrors = 0;
      const command = bashBlocks[0];
      const stepNote = stripMsweaBlocks(rawContent);
      if (stepNote && stepNote !== reasoning) {
        emitEvent?.({ type: 'assistant_note', step, text: stepNote });
      }
      conversation.push({ role: 'assistant', content: parsedChoice.rawContent });

      const { result } = await runStepTool('bash', { command });
      pushThinkingStep(step, reasoning, stepNote, ['bash'], reqOutcome.latencyMs);
      const obs = buildMiniSweToolObservation('bash', result);
      conversation.push({ role: 'user', content: obs });

      const check = checkMiniSweCommandSubmission(result, rawContent);
      if (check.submitted) {
        submitted = true;
        lastFinishReason = 'submitted';
        replyText = check.output;
        break;
      }
      continue;
    }

    if (bashBlocks.length > 1) {
      consecutiveFormatErrors += 1;
      formatErrorsTotal += 1;
      const stepNote = stripMsweaBlocks(rawContent);
      if (stepNote && stepNote !== reasoning) {
        emitEvent?.({ type: 'assistant_note', step, text: stepNote });
      }
      pushThinkingStep(step, reasoning, stepNote, [], reqOutcome.latencyMs);
      conversation.push({ role: 'assistant', content: parsedChoice.rawContent });
      if (consecutiveFormatErrors >= maxFormatErrors) {
        lastFinishReason = 'format_error_limit';
        replyText =
          stepNote ||
          rawContent ||
          `Stopped after ${consecutiveFormatErrors} consecutive mini-SWE-agent format errors.`;
        break;
      }
      conversation.push({
        role: 'user',
        content: formatMiniSweFormatError(bashBlocks.length, { allowWrite }),
      });
      continue;
    }

    const textCalls = parseTextToolCalls(rawContent);
    if (textCalls.length > 0) {
      consecutiveFormatErrors = 0;
      const stepNote = stripMsweaBlocks(
        rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim()
      );
      if (stepNote && stepNote !== reasoning) {
        emitEvent?.({ type: 'assistant_note', step, text: stepNote });
      }
      conversation.push({ role: 'assistant', content: parsedChoice.rawContent });

      const stepTools = [];
      const resultBlocks = [];
      let submittedOutput = '';
      for (const tc of textCalls) {
        stepTools.push(tc.name);
        const { result } = await runStepTool(tc.name, tc.arguments);
        const obs = buildMiniSweToolObservation(tc.name, result);
        resultBlocks.push(`<tool_result name="${tc.name}">\n${obs}\n</tool_result>`);

        if (tc.name === 'bash' || tc.name === 'run_command') {
          const check = checkMiniSweCommandSubmission(result, rawContent);
          if (check.submitted) {
            submitted = true;
            submittedOutput = check.output;
          }
        }
      }
      pushThinkingStep(step, reasoning, stepNote, stepTools, reqOutcome.latencyMs);

      conversation.push({
        role: 'user',
        content: resultBlocks.join('\n\n'),
      });

      if (submitted) {
        lastFinishReason = 'submitted';
        replyText = submittedOutput;
        break;
      }
      continue;
    }

    if (rawContent.includes(MINI_SWE_SUBMISSION_MARKER)) {
      submitted = true;
      lastFinishReason = 'submitted';
      pushThinkingStep(step, reasoning, '', [], reqOutcome.latencyMs);
      replyText =
        stripSubmissionSentinelFromText(rawContent) || MINI_SWE_SUBMISSION_MARKER;
      break;
    }

    consecutiveFormatErrors += 1;
    formatErrorsTotal += 1;
    const errNote = rawContent.trim();
    if (errNote && errNote !== reasoning) {
      emitEvent?.({ type: 'assistant_note', step, text: errNote });
    }
    pushThinkingStep(step, reasoning, errNote, [], reqOutcome.latencyMs);
    conversation.push({ role: 'assistant', content: parsedChoice.rawContent });
    if (consecutiveFormatErrors >= maxFormatErrors) {
      lastFinishReason = 'format_error_limit';
      replyText = rawContent || reasoning || '';
      break;
    }
    conversation.push({
      role: 'user',
      content: formatMiniSweFormatError(0, { allowWrite }),
    });
  }

  const combinedReasoning = combineThinkingTrace(thinkingSteps);

  return {
    ok: true,
    ...(runId ? { runId } : {}),
    model: lastModel || modelId,
    configuredModelId: configuredModelId || modelId,
    displayName: displayName || modelId,
    agentName,
    baseUrl: resolvedBaseUrl,
    configuredHarness: configuredHarness || 'mini-swe-agent',
    harness: 'mini-swe-agent',
    ...(harnessAutoReason ? { harnessAutoReason } : {}),
    thinkingLevel: normalizedThinkingLevel,
    latencyMs: totalLatencyMs,
    reply: replyText,
    ...(combinedReasoning ? { reasoning: combinedReasoning } : {}),
    ...(thinkingSteps.length > 0 ? { thinkingSteps } : {}),
    finishReason: lastFinishReason,
    usage: totalUsage,
    sessionId: sessionId || null,
    autoDiscovered,
    stepsUsed,
    toolTrace,
    skillsAvailable: resolvedEnv.skills.length,
    mcpServersAvailable: resolvedEnv.mcpServers.length,
    submitted,
    formatErrors: formatErrorsTotal,
  };
}
