/**
 * Shared live-stream NDJSON event bus for `agy-local-agents`.
 *
 * Bridges local-model CLI (`node local-model.mjs`), MCP tool executions,
 * the inline MCP App live viewer, and the sidecar Web UI with zero dependencies.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_INDEX_ENTRIES = 30;
const STREAM_TTL_MS = 2 * 60 * 60 * 1000;
const STALE_RUNNING_MS = 5 * 60 * 1000;
const DELTA_FLUSH_MS = 60;
const DELTA_FLUSH_CHARS = 160;

export function resolveStreamsDir(configPath) {
  if (process.env.AGY_LOCAL_AGENTS_STREAMS_DIR) {
    return process.env.AGY_LOCAL_AGENTS_STREAMS_DIR;
  }
  if (process.env.AGY_ADD_MODELS_STREAMS_DIR) {
    return process.env.AGY_ADD_MODELS_STREAMS_DIR;
  }
  return join(dirname(configPath), 'streams');
}

export function sanitizeRunId(raw) {
  const clean = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return clean || createRunId('run');
}

export function createRunId(prefix = 'run') {
  const safePrefix = String(prefix || 'run')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'run';
  return `${safePrefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function getIndexPath(streamsDir) {
  return join(streamsDir, 'index.json');
}

function getNdjsonPath(streamsDir, runId) {
  return join(streamsDir, `${sanitizeRunId(runId)}.ndjson`);
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
        // Ignore cleanup errors.
      }
    }
  }
}

function readIndexRaw(streamsDir) {
  const indexPath = getIndexPath(streamsDir);
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    return Array.isArray(parsed?.runs) ? parsed.runs : Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pruneOldStreams(streamsDir, entries) {
  const now = Date.now();
  const kept = [];
  for (const entry of entries) {
    if (!entry || !entry.runId) continue;
    const ndjsonPath = getNdjsonPath(streamsDir, entry.runId);
    const updatedMs = Date.parse(entry.updatedAt || entry.startedAt || '') || now;
    if (now - updatedMs > STREAM_TTL_MS) {
      if (existsSync(ndjsonPath)) {
        try {
          unlinkSync(ndjsonPath);
        } catch {
          // Ignore.
        }
      }
      continue;
    }
    kept.push(entry);
  }

  // Also clean orphan expired ndjson files not in index.
  try {
    for (const file of readdirSync(streamsDir)) {
      if (!file.endsWith('.ndjson')) continue;
      const full = join(streamsDir, file);
      try {
        const st = statSync(full);
        if (now - st.mtimeMs > STREAM_TTL_MS) {
          unlinkSync(full);
        }
      } catch {
        // Ignore.
      }
    }
  } catch {
    // Ignore.
  }

  kept.sort((a, b) => (Date.parse(b.startedAt || '') || 0) - (Date.parse(a.startedAt || '') || 0));
  return kept.slice(0, MAX_INDEX_ENTRIES);
}

function upsertIndexEntry(streamsDir, entryPatch) {
  if (!streamsDir || !entryPatch?.runId) return null;
  mkdirSync(streamsDir, { recursive: true, mode: 0o700 });
  const existingList = readIndexRaw(streamsDir);
  const idx = existingList.findIndex((r) => r.runId === entryPatch.runId);
  const nowIso = new Date().toISOString();
  const merged =
    idx >= 0
      ? { ...existingList[idx], ...entryPatch, updatedAt: nowIso }
      : { startedAt: nowIso, ...entryPatch, updatedAt: nowIso };
  if (idx >= 0) existingList[idx] = merged;
  else existingList.unshift(merged);
  const pruned = pruneOldStreams(streamsDir, existingList);
  try {
    writeJsonAtomic(getIndexPath(streamsDir), { runs: pruned });
  } catch {
    // Non-fatal if concurrent writer raced on index.json.
  }
  return merged;
}

function appendNdjsonLine(ndjsonPath, obj) {
  try {
    appendFileSync(ndjsonPath, JSON.stringify(obj) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Non-fatal if stream dir becomes unavailable.
  }
}

export function createStreamRecorder({
  streamsDir,
  runId,
  kind = 'chat',
  taskType = '',
  maxThinkingLoops = 10,
  model = '',
  displayName = '',
  task = '',
  cwd = '',
  configuredHarness = 'auto',
  harness = 'native',
  harnessAutoReason = '',
  thinkingLevel = 'auto',
} = {}) {
  const cleanRunId = sanitizeRunId(runId || createRunId(kind === 'subagent' ? 'sub' : 'chat'));
  const resolvedDir = streamsDir;
  mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  const ndjsonPath = getNdjsonPath(resolvedDir, cleanRunId);
  const startedAt = new Date().toISOString();
  const taskSummary = String(task || '').trim().slice(0, 300);
  const cleanMaxLoops = Math.max(1, Number(maxThinkingLoops) || 10);

  // Start a clean NDJSON stream file if a sequential runId (e.g. local-subagent-1) is reused.
  try {
    writeFileSync(ndjsonPath, '', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Ignore reset error; appendNdjsonLine will still attempt writes.
  }

  let currentMeta = {
    runId: cleanRunId,
    kind,
    ...(taskType ? { taskType: String(taskType) } : {}),
    maxThinkingLoops: cleanMaxLoops,
    status: 'running',
    model: String(model || ''),
    displayName: String(displayName || model || ''),
    task: taskSummary,
    cwd: String(cwd || ''),
    configuredHarness: String(configuredHarness || 'auto'),
    harness: String(harness || 'native'),
    ...(harnessAutoReason ? { harnessAutoReason: String(harnessAutoReason) } : {}),
    thinkingLevel: String(thinkingLevel || 'auto'),
    startedAt,
    stepsUsed: 0,
    toolCount: 0,
    currentTool: '',
    lastActivity: 'Starting…',
  };

  upsertIndexEntry(resolvedDir, currentMeta);
  appendNdjsonLine(ndjsonPath, {
    type: 'run_start',
    ts: startedAt,
    runId: cleanRunId,
    kind,
    ...(taskType ? { taskType: String(taskType) } : {}),
    maxThinkingLoops: cleanMaxLoops,
    model: currentMeta.model,
    displayName: currentMeta.displayName,
    task: taskSummary,
    cwd: currentMeta.cwd,
    configuredHarness: currentMeta.configuredHarness,
    harness: currentMeta.harness,
    ...(harnessAutoReason ? { harnessAutoReason } : {}),
    thinkingLevel: currentMeta.thinkingLevel,
  });

  let pendingDelta = null;
  let flushTimer = null;
  let closed = false;

  const flushDelta = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingDelta) return;
    const toWrite = pendingDelta;
    pendingDelta = null;
    appendNdjsonLine(ndjsonPath, {
      ...toWrite,
      ts: new Date().toISOString(),
    });
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushDelta();
    }, DELTA_FLUSH_MS);
    if (typeof flushTimer.unref === 'function') {
      flushTimer.unref();
    }
  };

  const emit = (ev) => {
    if (closed || !ev || !ev.type) return;
    if (ev.type === 'thinking_delta' || ev.type === 'content_delta') {
      const text = String(ev.text || '');
      if (!text) return;
      if (
        pendingDelta &&
        pendingDelta.type === ev.type &&
        pendingDelta.step === ev.step
      ) {
        pendingDelta.text += text;
        if (pendingDelta.text.length >= DELTA_FLUSH_CHARS) {
          flushDelta();
        }
        return;
      }
      flushDelta();
      pendingDelta = {
        type: ev.type,
        step: ev.step,
        text,
      };
      if (pendingDelta.text.length >= DELTA_FLUSH_CHARS) {
        flushDelta();
      } else {
        scheduleFlush();
      }
      return;
    }

    flushDelta();
    appendNdjsonLine(ndjsonPath, {
      ...ev,
      ts: new Date().toISOString(),
    });

    if (ev.type === 'step_start' && ev.step) {
      currentMeta.stepsUsed = Math.max(currentMeta.stepsUsed || 0, Number(ev.step) || 0);
      if (ev.maxSteps) {
        currentMeta.maxThinkingLoops = Math.max(1, Number(ev.maxSteps) || currentMeta.maxThinkingLoops);
      }
      currentMeta.lastActivity = `Loop ${currentMeta.stepsUsed}/${currentMeta.maxThinkingLoops}`;
      upsertIndexEntry(resolvedDir, currentMeta);
    } else if (ev.type === 'tool_start') {
      currentMeta.currentTool = String(ev.tool || '');
      currentMeta.lastActivity = `→ ${currentMeta.currentTool}`;
      upsertIndexEntry(resolvedDir, currentMeta);
    } else if (ev.type === 'tool_end') {
      currentMeta.toolCount = (currentMeta.toolCount || 0) + 1;
      currentMeta.currentTool = '';
      currentMeta.lastActivity = `${ev.ok ? '✓' : '✗'} ${ev.tool || 'tool'}`;
      upsertIndexEntry(resolvedDir, currentMeta);
    }
  };

  const updateMeta = (patch = {}) => {
    if (!patch || typeof patch !== 'object') return currentMeta;
    currentMeta = { ...currentMeta, ...patch };
    upsertIndexEntry(resolvedDir, currentMeta);
    return currentMeta;
  };

  const finish = (summary = {}) => {
    if (closed) return;
    flushDelta();
    closed = true;
    const endedAt = new Date().toISOString();
    const reply = typeof summary.reply === 'string' ? summary.reply : '';
    const boundedReply =
      reply.length > 16000 ? `${reply.slice(0, 16000)}\n... [truncated]` : reply;
    const endEvent = {
      type: 'run_end',
      ts: endedAt,
      status: 'done',
      model: summary.model || currentMeta.model,
      displayName: summary.displayName || currentMeta.displayName,
      latencyMs: summary.latencyMs ?? 0,
      stepsUsed: summary.stepsUsed ?? currentMeta.stepsUsed ?? 1,
      reply: boundedReply,
      harness: summary.harness || currentMeta.harness,
      configuredHarness: summary.configuredHarness || currentMeta.configuredHarness,
      ...(summary.harnessAutoReason || currentMeta.harnessAutoReason
        ? { harnessAutoReason: summary.harnessAutoReason || currentMeta.harnessAutoReason }
        : {}),
      thinkingLevel: summary.thinkingLevel || currentMeta.thinkingLevel,
      toolCount: Array.isArray(summary.toolTrace)
        ? summary.toolTrace.length
        : currentMeta.toolCount || 0,
    };
    appendNdjsonLine(ndjsonPath, endEvent);
    updateMeta({
      status: 'done',
      endedAt,
      model: endEvent.model,
      displayName: endEvent.displayName,
      latencyMs: endEvent.latencyMs,
      stepsUsed: endEvent.stepsUsed,
      harness: endEvent.harness,
      configuredHarness: endEvent.configuredHarness,
      ...(endEvent.harnessAutoReason ? { harnessAutoReason: endEvent.harnessAutoReason } : {}),
      thinkingLevel: endEvent.thinkingLevel,
      toolCount: endEvent.toolCount,
      currentTool: '',
      lastActivity: 'Completed',
    });
  };

  const fail = (err) => {
    if (closed) return;
    flushDelta();
    closed = true;
    const endedAt = new Date().toISOString();
    const message = err?.message ? String(err.message) : String(err || 'Unknown error');
    appendNdjsonLine(ndjsonPath, {
      type: 'run_error',
      ts: endedAt,
      status: 'error',
      error: message,
    });
    updateMeta({
      status: 'error',
      endedAt,
      currentTool: '',
      lastActivity: `Error: ${message.slice(0, 80)}`,
      error: message,
    });
  };

  return {
    runId: cleanRunId,
    ndjsonPath,
    emit,
    updateMeta,
    finish,
    fail,
    flush: flushDelta,
  };
}

function effectiveRunStatus(streamsDir, entry) {
  if (!entry) return 'unknown';
  if (entry.status !== 'running') return entry.status || 'unknown';
  const ndjsonPath = getNdjsonPath(streamsDir, entry.runId);
  try {
    if (existsSync(ndjsonPath)) {
      const mtime = statSync(ndjsonPath).mtimeMs;
      if (Date.now() - mtime > STALE_RUNNING_MS) return 'stale';
    } else {
      const startedMs = Date.parse(entry.startedAt || '') || 0;
      if (Date.now() - startedMs > STALE_RUNNING_MS) return 'stale';
    }
  } catch {
    // Ignore stat errors.
  }
  return 'running';
}

export function listRecentStreams({ streamsDir, limit = 12 } = {}) {
  if (!streamsDir || !existsSync(streamsDir)) return [];
  const raw = readIndexRaw(streamsDir);
  const runs = raw
    .map((entry) => ({
      ...entry,
      status: effectiveRunStatus(streamsDir, entry),
    }))
    .sort((a, b) => (Date.parse(b.startedAt || '') || 0) - (Date.parse(a.startedAt || '') || 0));
  return runs.slice(0, Math.max(1, Number(limit) || 12));
}

export function readStreamEvents({ streamsDir, runId, cursor = 0 } = {}) {
  const cleanId = sanitizeRunId(runId);
  const ndjsonPath = getNdjsonPath(streamsDir, cleanId);
  const rawIndex = streamsDir ? readIndexRaw(streamsDir) : [];
  const metaEntry = rawIndex.find((r) => r.runId === cleanId) || null;

  if (!existsSync(ndjsonPath)) {
    return {
      runId: cleanId,
      exists: Boolean(metaEntry),
      meta: metaEntry ? { ...metaEntry, status: effectiveRunStatus(streamsDir, metaEntry) } : null,
      status: metaEntry ? effectiveRunStatus(streamsDir, metaEntry) : 'pending',
      events: [],
      nextCursor: 0,
      totalEvents: 0,
    };
  }

  let lines = [];
  try {
    const raw = readFileSync(ndjsonPath, 'utf-8');
    lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch {
    lines = [];
  }

  const rawCursor = Math.max(0, Number(cursor) || 0);
  const reset = rawCursor > lines.length;
  const start = reset ? 0 : rawCursor;
  const parsedEvents = [];
  let derivedStatus = metaEntry ? effectiveRunStatus(streamsDir, metaEntry) : 'running';

  for (let i = 0; i < lines.length; i += 1) {
    let ev = null;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (ev.type === 'run_end') derivedStatus = 'done';
    else if (ev.type === 'run_error') derivedStatus = 'error';
    if (i >= start) {
      parsedEvents.push(ev);
    }
  }

  return {
    runId: cleanId,
    exists: true,
    reset,
    meta: metaEntry ? { ...metaEntry, status: derivedStatus } : null,
    status: derivedStatus,
    events: parsedEvents,
    nextCursor: lines.length,
    totalEvents: lines.length,
  };
}

export function findMatchingStreamRun({ streamsDir, runId = '', task = '', prompt = '' } = {}) {
  if (!streamsDir) return '';
  if (runId) {
    const clean = sanitizeRunId(runId);
    if (existsSync(getNdjsonPath(streamsDir, clean))) return clean;
    const index = listRecentStreams({ streamsDir, limit: 30 });
    if (index.some((r) => r.runId === clean)) return clean;
  }

  const runs = listRecentStreams({ streamsDir, limit: 20 });
  if (runs.length === 0) return '';

  const needle = String(task || prompt || '')
    .trim()
    .toLowerCase()
    .slice(0, 80);
  const now = Date.now();

  if (needle) {
    const exactMatch = runs.find((r) => {
      const startedMs = Date.parse(r.startedAt || '') || 0;
      const withinWindow = r.status === 'running' || now - startedMs < 60000;
      if (!withinWindow) return false;
      const candidate = String(r.task || '').trim().toLowerCase();
      return candidate && (candidate.startsWith(needle) || needle.startsWith(candidate));
    });
    if (exactMatch) return exactMatch.runId;
  }

  const activeRun = runs.find((r) => r.status === 'running');
  return activeRun ? activeRun.runId : '';
}
