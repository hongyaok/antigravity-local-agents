import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps/app-with-deps';

const POLL_INTERVAL_MS = 250;
const MAX_POLL_DURATION_MS = 10 * 60 * 1000;

const app = new App({ name: 'agy-local-agents-stream', version: '0.2.0' });

const ui = {
  runs: new Map(), // runId -> runState
  order: [], // array of runIds
  activeRunId: '',
  watchArgs: null, // { runId, runIds, task, prompt, title }
  polling: false,
  pollTimer: null,
  timerHandle: null,
  pollStartMs: 0,
  cancelled: false,
};

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortHarness(harness, autoReason) {
  let label = harness === 'mini-swe-agent' ? 'mini-SWE' : harness === 'native' ? 'Native' : harness || 'Auto';
  if (autoReason) {
    const tag = autoReason.includes('coding') ? 'auto:coding' : autoReason.includes('knowledge') ? 'auto:knowledge' : autoReason;
    label += ` · ${tag}`;
  }
  return label;
}

function getOrCreateRun(runId, seed = {}) {
  const id = String(runId || 'pending');
  let run = ui.runs.get(id);
  if (!run) {
    run = {
      runId: id,
      status: seed.status || 'running',
      model: seed.model || 'local-model',
      displayName: seed.displayName || seed.model || 'Local Agent',
      harness: seed.harness || 'auto',
      configuredHarness: seed.configuredHarness || '',
      harnessAutoReason: seed.harnessAutoReason || '',
      thinkingLevel: seed.thinkingLevel || 'auto',
      task: seed.task || seed.prompt || '',
      startedAtMs: seed.startedAt ? Date.parse(seed.startedAt) || Date.now() : Date.now(),
      latencyMs: seed.latencyMs || 0,
      step: 0,
      maxSteps: 0,
      thinkingText: '',
      contentText: '',
      reply: '',
      error: '',
      tools: [],
      cursor: 0,
    };
    ui.runs.set(id, run);
    if (!ui.order.includes(id)) {
      ui.order.push(id);
    }
    if (!ui.activeRunId || (ui.activeRunId === 'pending' && id !== 'pending')) {
      ui.activeRunId = id;
    }
  } else {
    if (seed.model && run.model === 'local-model') run.model = seed.model;
    if (seed.displayName && run.displayName === 'Local Agent') run.displayName = seed.displayName;
    if (seed.task && !run.task) run.task = seed.task;
    if (seed.harness && run.harness === 'auto') run.harness = seed.harness;
    if (seed.harnessAutoReason && !run.harnessAutoReason) run.harnessAutoReason = seed.harnessAutoReason;
  }
  return run;
}

function applyEventsToRun(run, events = [], nextCursor = null) {
  for (const ev of events) {
    if (!ev || !ev.type) continue;
    switch (ev.type) {
      case 'run_start': {
        if (ev.model) run.model = ev.model;
        if (ev.displayName) run.displayName = ev.displayName;
        if (ev.harness) run.harness = ev.harness;
        if (ev.configuredHarness) run.configuredHarness = ev.configuredHarness;
        if (ev.harnessAutoReason) run.harnessAutoReason = ev.harnessAutoReason;
        if (ev.thinkingLevel) run.thinkingLevel = ev.thinkingLevel;
        if (ev.task) run.task = ev.task;
        if (ev.ts) run.startedAtMs = Date.parse(ev.ts) || run.startedAtMs;
        break;
      }
      case 'harness_resolved': {
        if (ev.harness) run.harness = ev.harness;
        if (ev.configuredHarness) run.configuredHarness = ev.configuredHarness;
        if (ev.reason) run.harnessAutoReason = ev.reason;
        break;
      }
      case 'step_start': {
        run.step = Number(ev.step) || run.step;
        run.maxSteps = Number(ev.maxSteps) || run.maxSteps;
        if (ev.harness) run.harness = ev.harness;
        if (ev.harnessAutoReason) run.harnessAutoReason = ev.harnessAutoReason;
        if (run.step > 1 && run.thinkingText && !run.thinkingText.endsWith('\n')) {
          run.thinkingText += '\n';
        }
        break;
      }
      case 'thinking_delta': {
        if (ev.text) run.thinkingText += ev.text;
        break;
      }
      case 'content_delta': {
        if (ev.text) run.contentText += ev.text;
        break;
      }
      case 'assistant_note': {
        if (ev.text) {
          const note = String(ev.text).trim();
          if (note) {
            run.thinkingText += (run.thinkingText ? '\n' : '') + note + '\n';
          }
        }
        break;
      }
      case 'tool_start': {
        const argsStr =
          typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args || {});
        run.tools.push({
          step: ev.step || run.step || 1,
          tool: ev.tool || 'tool',
          argsPreview: argsStr.slice(0, 90),
          status: 'running',
          durationMs: 0,
          preview: '',
        });
        break;
      }
      case 'tool_end': {
        let match = null;
        for (let i = run.tools.length - 1; i >= 0; i -= 1) {
          if (run.tools[i].tool === ev.tool && run.tools[i].status === 'running') {
            match = run.tools[i];
            break;
          }
        }
        if (match) {
          match.status = ev.ok ? 'ok' : 'err';
          match.durationMs = Number(ev.durationMs) || 0;
          match.preview = ev.preview ? String(ev.preview).replace(/\s+/g, ' ').slice(0, 100) : '';
        } else {
          run.tools.push({
            step: ev.step || run.step || 1,
            tool: ev.tool || 'tool',
            argsPreview: '',
            status: ev.ok ? 'ok' : 'err',
            durationMs: Number(ev.durationMs) || 0,
            preview: ev.preview ? String(ev.preview).replace(/\s+/g, ' ').slice(0, 100) : '',
          });
        }
        break;
      }
      case 'run_end': {
        run.status = 'done';
        if (ev.model) run.model = ev.model;
        if (ev.displayName) run.displayName = ev.displayName;
        if (ev.harness) run.harness = ev.harness;
        if (ev.harnessAutoReason) run.harnessAutoReason = ev.harnessAutoReason;
        if (ev.latencyMs !== undefined) run.latencyMs = Number(ev.latencyMs) || run.latencyMs;
        if (ev.stepsUsed !== undefined) run.step = Number(ev.stepsUsed) || run.step;
        if (typeof ev.reply === 'string' && ev.reply) {
          run.reply = ev.reply;
        }
        break;
      }
      case 'run_error': {
        run.status = 'error';
        run.error = ev.error || 'Local agent failed';
        break;
      }
    }
  }
  if (typeof nextCursor === 'number' && nextCursor >= run.cursor) {
    run.cursor = nextCursor;
  }
}

function hydrateFromFinalResult(data) {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data.runs)) {
    for (const r of data.runs) {
      if (!r || !r.runId) continue;
      if (ui.runs.has('pending') && r.runId !== 'pending') {
        ui.runs.delete('pending');
        ui.order = ui.order.filter((id) => id !== 'pending');
      }
      const run = getOrCreateRun(r.runId, r.meta || r);
      if (Array.isArray(r.events) && r.events.length > 0) {
        applyEventsToRun(run, r.events.slice(run.cursor), r.nextCursor);
      }
      if (r.status) run.status = r.status;
    }
    return;
  }

  const targetId = data.runId || ui.activeRunId || 'pending';
  if (ui.runs.has('pending') && targetId !== 'pending') {
    const pending = ui.runs.get('pending');
    ui.runs.delete('pending');
    ui.order = ui.order.filter((id) => id !== 'pending');
    ui.runs.set(targetId, { ...pending, runId: targetId });
    ui.order.push(targetId);
    ui.activeRunId = targetId;
  }
  const run = getOrCreateRun(targetId, data);
  run.status = data.ok === false ? 'error' : 'done';
  if (data.model) run.model = data.model;
  if (data.displayName) run.displayName = data.displayName;
  if (data.harness) run.harness = data.harness;
  if (data.harnessAutoReason) run.harnessAutoReason = data.harnessAutoReason;
  if (data.thinkingLevel) run.thinkingLevel = data.thinkingLevel;
  if (typeof data.latencyMs === 'number') run.latencyMs = data.latencyMs;
  if (typeof data.stepsUsed === 'number') run.step = data.stepsUsed;
  if (!run.thinkingText && typeof data.reasoning === 'string') {
    run.thinkingText = data.reasoning;
  }
  if (typeof data.reply === 'string') {
    run.reply = data.reply;
  }
  if (Array.isArray(data.toolTrace) && run.tools.length === 0) {
    run.tools = data.toolTrace.map((t) => ({
      step: t.step || 1,
      tool: t.tool || 'tool',
      argsPreview: '',
      status: t.ok ? 'ok' : 'err',
      durationMs: Number(t.durationMs) || 0,
      preview: t.preview ? String(t.preview).slice(0, 100) : '',
    }));
  }
  if (data.error) run.error = String(data.error);
}

function hasActiveRuns() {
  if (ui.runs.size === 0) return true;
  for (const run of ui.runs.values()) {
    if (run.status === 'running' || run.status === 'pending') return true;
  }
  return false;
}

function formatElapsed(run) {
  if (run.status === 'done' && run.latencyMs > 0) {
    return `${(run.latencyMs / 1000).toFixed(1)}s`;
  }
  const sec = Math.max(0, (Date.now() - run.startedAtMs) / 1000);
  return `${sec.toFixed(1)}s`;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const tabsHtml =
    ui.order.length > 1
      ? `<div class="tabs">${ui.order
          .map((id, idx) => {
            const r = ui.runs.get(id);
            const active = id === ui.activeRunId;
            const dotCls =
              r?.status === 'done' ? 'done' : r?.status === 'error' ? 'err' : 'live';
            return `<button type="button" class="tab ${active ? 'active' : ''}" data-run-id="${esc(id)}"><span class="dot ${dotCls}"></span><span>#${idx + 1} ${esc((r?.displayName || r?.model || id).slice(0, 18))}</span></button>`;
          })
          .join('')}</div>`
      : '';

  const run = ui.runs.get(ui.activeRunId) || ui.runs.values().next().value || getOrCreateRun('pending');
  const isLive = run.status === 'running' || run.status === 'pending';
  const dotClass = ui.cancelled ? 'err' : run.status === 'done' ? 'done' : run.status === 'error' ? 'err' : 'live';
  const statusLabel = ui.cancelled ? 'Cancelled' : run.status === 'done' ? 'Done' : run.status === 'error' ? 'Error' : 'Live';
  const stepLabel = run.step > 0 ? (run.maxSteps > 0 ? `Step ${run.step}/${run.maxSteps}` : `Step ${run.step}`) : 'Starting';
  const harnessChip = shortHarness(run.harness, run.harnessAutoReason);

  const thinkingBody = run.thinkingText.trim();
  const thinkingSection = thinkingBody
    ? `<details class="block" ${isLive ? 'open' : ''}>
        <summary>Thinking</summary>
        <pre class="stream-pre thinking-pre" id="thinking-pre">${esc(thinkingBody)}</pre>
      </details>`
    : '';

  const toolsSection = run.tools.length
    ? `<div class="tools-strip">${run.tools
        .slice(-6)
        .map(
          (t) =>
            `<span class="tool-pill ${t.status === 'err' ? 'is-err' : t.status === 'ok' ? 'is-ok' : 'is-run'}" title="${esc(t.argsPreview || t.preview)}">${t.status === 'running' ? '⟳' : t.status === 'ok' ? '✓' : '✕'} ${esc(t.tool)}${t.durationMs ? ` ${t.durationMs}ms` : ''}</span>`
        )
        .join('')}</div>`
    : '';

  const responseText = (run.reply || run.contentText || '').trim();
  const responseSection = run.error
    ? `<div class="error-box">${esc(run.error)}</div>`
    : responseText
      ? `<div class="response-box" id="response-box"><pre class="stream-pre response-pre">${esc(responseText)}</pre></div>`
      : `<div class="waiting-line">${isLive ? 'Streaming from local model…' : 'Completed'}</div>`;

  const prevThinkScroll = document.getElementById('thinking-pre')?.scrollTop || 0;
  const prevThinkAtBottom = (() => {
    const el = document.getElementById('thinking-pre');
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  })();

  root.innerHTML = `
    <div class="stream-card">
      ${tabsHtml}
      <div class="head">
        <div class="head-left">
          <span class="dot ${dotClass}"></span>
          <span class="status-txt">${esc(statusLabel)}</span>
          <span class="model-txt">${esc(run.displayName || run.model)}</span>
          <span class="chip">${esc(harnessChip)}</span>
        </div>
        <div class="head-right">
          <span class="meta-txt">${esc(stepLabel)}</span>
          <span class="meta-txt" id="elapsed-txt">${esc(formatElapsed(run))}</span>
        </div>
      </div>
      ${run.task ? `<div class="task-line" title="${esc(run.task)}">${esc(run.task)}</div>` : ''}
      ${toolsSection}
      ${thinkingSection}
      ${responseSection}
    </div>
  `;

  root.querySelectorAll('[data-run-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.activeRunId = btn.dataset.runId;
      render();
    });
  });

  const tPre = document.getElementById('thinking-pre');
  if (tPre) {
    tPre.scrollTop = prevThinkAtBottom ? tPre.scrollHeight : prevThinkScroll;
  }
}

async function pollOnce() {
  if (ui.cancelled || !ui.polling) return;
  if (Date.now() - ui.pollStartMs > MAX_POLL_DURATION_MS) {
    stopPolling();
    return;
  }

  try {
    const cursors = {};
    for (const [id, run] of ui.runs.entries()) {
      if (id !== 'pending') cursors[id] = run.cursor || 0;
    }

    const args = {
      ...(ui.watchArgs?.runId ? { runId: ui.watchArgs.runId } : {}),
      ...(Array.isArray(ui.watchArgs?.runIds) && ui.watchArgs.runIds.length
        ? { runIds: ui.watchArgs.runIds }
        : {}),
      ...(ui.watchArgs?.task ? { task: ui.watchArgs.task } : {}),
      ...(ui.watchArgs?.prompt ? { prompt: ui.watchArgs.prompt } : {}),
      cursors,
    };

    const res = await app.callServerTool({
      name: 'agy_local_stream_poll',
      arguments: args,
    });

    const data = res?.structuredContent || (() => {
      try {
        const txt = res?.content?.[0]?.text;
        return txt ? JSON.parse(txt) : null;
      } catch {
        return null;
      }
    })();

    if (data && Array.isArray(data.runs) && data.runs.length > 0) {
      for (const r of data.runs) {
        if (!r || !r.runId) continue;
        if (ui.runs.has('pending')) {
          ui.runs.delete('pending');
          ui.order = ui.order.filter((id) => id !== 'pending');
        }
        const run = getOrCreateRun(r.runId, r.meta || {});
        applyEventsToRun(run, r.events || [], r.nextCursor);
        if (r.status === 'done' || r.status === 'error' || r.status === 'stale') {
          run.status = r.status === 'stale' ? 'error' : r.status;
        }
      }
      render();
    }
  } catch {
    // Ignore transient poll errors while tool runs.
  }

  if (ui.polling && hasActiveRuns()) {
    ui.pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  } else {
    stopPolling();
  }
}

function startPolling() {
  if (ui.polling) return;
  ui.polling = true;
  ui.pollStartMs = Date.now();
  if (!ui.timerHandle) {
    ui.timerHandle = setInterval(() => {
      const active = ui.runs.get(ui.activeRunId);
      const el = document.getElementById('elapsed-txt');
      if (active && el && (active.status === 'running' || active.status === 'pending')) {
        el.textContent = formatElapsed(active);
      }
    }, 300);
  }
  pollOnce();
}

function stopPolling() {
  ui.polling = false;
  if (ui.pollTimer) {
    clearTimeout(ui.pollTimer);
    ui.pollTimer = null;
  }
  if (ui.timerHandle) {
    clearInterval(ui.timerHandle);
    ui.timerHandle = null;
  }
}

app.ontoolinput = ({ arguments: args } = {}) => {
  const input = args && typeof args === 'object' ? args : {};
  ui.watchArgs = {
    runId: input.runId || '',
    runIds: Array.isArray(input.runIds) ? input.runIds : [],
    task: input.task || '',
    prompt: input.prompt || '',
    title: input.title || '',
  };
  ui.cancelled = false;

  if (Array.isArray(input.runIds) && input.runIds.length > 0) {
    for (const id of input.runIds) {
      getOrCreateRun(id, { task: input.title || input.task || '', model: input.model || 'local-model' });
    }
  } else {
    getOrCreateRun(input.runId || 'pending', {
      task: input.task || input.prompt || input.title || '',
      model: input.model || 'local-model',
      harness: input.harness || (input.taskType === 'coding' ? 'mini-swe-agent' : input.taskType === 'knowledge' ? 'native' : 'auto'),
    });
  }
  render();
  startPolling();
};

app.ontoolresult = (result) => {
  const data = result?.structuredContent || (() => {
    try {
      const txt = result?.content?.[0]?.text;
      return txt ? JSON.parse(txt) : null;
    } catch {
      return null;
    }
  })();

  if (data) {
    hydrateFromFinalResult(data);
  }
  render();

  if (data?.watching && hasActiveRuns()) {
    startPolling();
  } else if (!hasActiveRuns()) {
    stopPolling();
  }
};

app.ontoolcancelled = () => {
  ui.cancelled = true;
  stopPolling();
  render();
};

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function boot() {
  render();
  try {
    await app.connect();
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  } catch (err) {
    const root = document.getElementById('app');
    if (root) {
      root.innerHTML = `<div class="error-box">Stream viewer error: ${esc(err.message)}</div>`;
    }
  }
}

boot();
