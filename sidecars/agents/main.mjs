/**
 * Antigravity Local Agents (`agy-local-agents`) sidecar backend.
 *
 * - Serves the pixel-art Web UI (Simple & Advanced modes) and bundled fonts.
 * - Discovers models from any OpenAI-compatible URL + optional API key.
 * - Manages added models and syncs to ~/.gemini/antigravity/custom_models.json.
 * - Exposes live stream inspection (/api/streams, /api/streams/poll).
 * - Queries Antigravity Language Server (GetUserStatus) for live model quota.
 * - Runs a loopback-only OpenAI auth proxy so LocalOpenAIAgentConfig works with
 *   both keyless local servers and API-key-protected OpenAI endpoints.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  HARNESS_CATALOG,
  THINKING_LEVELS,
  addModels,
  chatWithModel,
  discoverModels,
  findSavedEndpointKey,
  generateSdkSnippets,
  getStreamsDir,
  inferPresetFromUrl,
  listRecentStreams,
  normalizeBaseUrl,
  readState,
  readStreamEvents,
  redactStateForClient,
  removeModel,
  resolveConfigPath,
  resolveConfiguredModel,
  runHybridOrchestration,
  scanLocalEndpoints,
  setAgentSettings,
  setDirectChatConfig,
  syncToAgentFiles,
  testModel,
  updateModel,
  upsertSavedEndpoint,
  writeState,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, 'fonts');
function getRuntimeInfoPath() {
  return join(dirname(resolveConfigPath()), 'runtime.json');
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    contentType: 'application/json',
    status,
  });
}

function stripThinkingLevel(label) {
  return String(label ?? '')
    .replace(
      /\s*(?:\((?:x-?high|extra\s*high|ultra\s*high|high|medium|med|low|minimal|min|max|none|thinking|non-thinking|extended\s*thinking|standard)(?:\s+thinking)?\)|[-–—]\s*(?:x-?high|extra\s*high|high|medium|med|low|minimal|thinking))\s*$/i,
      ''
    )
    .trim();
}

function stripModelIdThinkingSuffix(modelId) {
  return String(modelId ?? '')
    .replace(
      /-(?:x-?high|extra-?high|ultra-?high|high|medium|med|low|minimal|min|max|none|thinking|non-thinking)$/i,
      ''
    )
    .trim();
}

function groupUsageModels(rawConfigs) {
  const normalized = (Array.isArray(rawConfigs) ? rawConfigs : []).map((c) => {
    const rawLabel = c?.label ?? c?.modelId ?? c?.modelOrAlias?.model ?? 'Unknown';
    const rawModelId = c?.modelId ?? c?.modelOrAlias?.model ?? '';
    const frac =
      typeof c?.quotaInfo?.remainingFraction === 'number'
        ? c.quotaInfo.remainingFraction
        : typeof c?.remainingFraction === 'number'
          ? c.remainingFraction
          : null;
    const resetTime = c?.quotaInfo?.resetTime ?? c?.resetTime ?? null;
    return {
      label: rawLabel,
      modelId: rawModelId,
      remainingFraction: frac,
      resetTime,
      disabled: Boolean(c?.disabled),
      variants: typeof c?.variants === 'number' ? c.variants : 1,
    };
  });

  const hasNumericQuota = normalized.some((m) => typeof m.remainingFraction === 'number');
  const active = normalized.filter((m) => {
    if (m.disabled && m.remainingFraction === null) return false;
    if (hasNumericQuota && m.remainingFraction === null) return false;
    return true;
  });

  const groups = new Map();
  for (const item of active) {
    const baseLabel = stripThinkingLevel(item.label) || item.label || 'Unknown';
    const baseModelId = stripModelIdThinkingSuffix(item.modelId);
    const key = baseLabel.toLowerCase() || baseModelId.toLowerCase() || 'unknown';
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        label: baseLabel,
        modelId: baseModelId,
        remainingFraction: item.remainingFraction,
        resetTime: item.resetTime || null,
        variants: item.variants,
      });
    } else {
      if (typeof item.remainingFraction === 'number') {
        existing.remainingFraction =
          typeof existing.remainingFraction === 'number'
            ? Math.min(existing.remainingFraction, item.remainingFraction)
            : item.remainingFraction;
      }
      if (!existing.resetTime && item.resetTime) {
        existing.resetTime = item.resetTime;
      }
      existing.variants += item.variants;
    }
  }

  return Array.from(groups.values());
}

/**
 * Starts a loopback-only OpenAI-compatible HTTP proxy that injects saved API keys
 * so Google Antigravity SDK's LocalOpenAIAgentConfig can use authenticated endpoints.
 */
function startLoopbackOpenAIProxy() {
  const desiredPort =
    Number.parseInt(
      process.env.AGY_LOCAL_AGENTS_PROXY_PORT || process.env.AGY_ADD_MODELS_PROXY_PORT || '0',
      10
    ) || 0;
  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const path = reqUrl.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const state = readState();
      const data = (state.models || [])
        .filter((m) => m.enabled)
        .map((m) => ({
          id: m.modelId,
          object: 'model',
          owned_by: m.ownedBy || m.preset || 'agy-local-agents',
          agy_display_name: m.displayName,
          agy_base_url: m.baseUrl,
        }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }

    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      let bodyText = '';
      for await (const chunk of req) {
        bodyText += chunk;
        if (bodyText.length > 8 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Request body too large' } }));
          return;
        }
      }

      let bodyJson;
      try {
        bodyJson = JSON.parse(bodyText || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
        return;
      }

      const configured = resolveConfiguredModel(bodyJson?.model);
      if (!configured) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `No configured OpenAI-compatible model matched "${bodyJson?.model || ''}"`,
            },
          })
        );
        return;
      }

      const upstreamUrl = `${configured.baseUrl}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (configured.apiKey) {
        headers.Authorization = `Bearer ${configured.apiKey}`;
      } else if (req.headers.authorization) {
        headers.Authorization = req.headers.authorization;
      }

      const forwarded = { ...bodyJson, model: configured.modelId };

      try {
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(forwarded),
        });
        const respHeaders = {
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
        };
        if (upstream.headers.get('cache-control')) {
          respHeaders['Cache-Control'] = upstream.headers.get('cache-control');
        }
        res.writeHead(upstream.status, respHeaders);
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            res.write(chunk);
          }
        }
        res.end();
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `Upstream proxy error: ${err.message}` },
          })
        );
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  return new Promise((resolveReady) => {
    server.listen(desiredPort, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const proxyBaseUrl = `http://127.0.0.1:${port}/v1`;
      try {
        const runtimePath = getRuntimeInfoPath();
        mkdirSync(dirname(runtimePath), { recursive: true });
        writeFileSync(
          runtimePath,
          JSON.stringify(
            {
              pid: process.pid,
              proxyPort: port,
              proxyBaseUrl,
              startedAt: new Date().toISOString(),
            },
            null,
            2
          ),
          'utf-8'
        );
      } catch {
        // Non-fatal if runtime info file cannot be written.
      }
      resolveReady({ server, port, proxyBaseUrl });
    });
  });
}

function cleanupRuntimeFile() {
  try {
    const runtimePath = getRuntimeInfoPath();
    if (existsSync(runtimePath)) unlinkSync(runtimePath);
  } catch {
    // Ignore cleanup errors.
  }
}

export async function startSidecar() {
  try {
    const initState = readState();
    const prevAgents = JSON.stringify(initState.managedAgentFiles);
    syncToAgentFiles(initState);
    if (
      existsSync(resolveConfigPath()) &&
      JSON.stringify(initState.managedAgentFiles) !== prevAgents
    ) {
      writeState(initState, { syncCustomModels: false, syncAgents: false });
    }
  } catch {
    // Non-fatal on startup if agents directory is unavailable.
  }
  const proxy = await startLoopbackOpenAIProxy();
  const app = new SidecarApp();

  app.page('/', () => {
    const indexPath = join(__dirname, 'index.html');
    if (!existsSync(indexPath)) {
      return '<!doctype html><html><body><h2>Local Agents UI not found</h2></body></html>';
    }
    return readFileSync(indexPath, 'utf-8');
  });

  const serveMonitorPage = () => {
    const monitorPath = join(__dirname, 'monitor.html');
    if (!existsSync(monitorPath)) {
      return '<!doctype html><html><body><h2>Local Subagents Monitor UI not found</h2></body></html>';
    }
    return readFileSync(monitorPath, 'utf-8');
  };
  app.page('/monitor.html', serveMonitorPage);
  app.page('/monitor', serveMonitorPage);

  app.api(
    '/api/font',
    (data) => {
      const rawName = typeof data?.name === 'string' ? data.name.trim() : '';
      if (!/^[a-z0-9\-]+\.woff2$/i.test(rawName)) {
        return jsonError(400, 'Invalid or missing font name');
      }
      const fontPath = resolve(FONTS_DIR, rawName);
      const rootPrefix = resolve(FONTS_DIR) + sep;
      if (!fontPath.startsWith(rootPrefix) || !existsSync(fontPath)) {
        return jsonError(404, 'Font not found');
      }
      return new Response(readFileSync(fontPath), {
        contentType: 'font/woff2',
        headers: { 'Cache-Control': 'public, max-age=31536000' },
      });
    },
    'GET'
  );

  app.api(
    '/api/config',
    () => {
      const redacted = redactStateForClient(readState());
      return {
        ...redacted,
        harnesses: redacted.harnesses || HARNESS_CATALOG,
        thinkingLevels: redacted.thinkingLevels || THINKING_LEVELS,
        agentSettings: redacted.agentSettings || {
          harness: 'auto',
          thinkingLevel: 'auto',
          verbose: true,
          uiMode: 'simple',
          maxThinkingLoops: 10,
        },
        proxyBaseUrl: proxy.proxyBaseUrl,
        proxyPort: proxy.proxyPort,
      };
    },
    'GET'
  );

  app.api(
    '/api/config',
    (data) => {
      try {
        const current = readState();
        const incoming = data || {};
        const nextUrl =
          typeof incoming.baseUrl === 'string'
            ? incoming.baseUrl.trim() === ''
              ? ''
              : normalizeBaseUrl(incoming.baseUrl)
            : current.activeEndpoint.baseUrl;
        const nextPreset =
          typeof incoming.preset === 'string' && incoming.preset.trim()
            ? incoming.preset.trim()
            : inferPresetFromUrl(nextUrl, current.activeEndpoint.preset);
        const switchingEndpoint =
          nextUrl !== current.activeEndpoint.baseUrl || nextPreset !== current.activeEndpoint.preset;
        const nextKey =
          typeof incoming.apiKey === 'string' && incoming.apiKey !== '••••••••'
            ? incoming.apiKey.trim()
            : switchingEndpoint
              ? findSavedEndpointKey(current, nextUrl, nextPreset)
              : current.activeEndpoint.apiKey;

        if (nextUrl && nextKey) {
          upsertSavedEndpoint(current, { preset: nextPreset, baseUrl: nextUrl, apiKey: nextKey });
        }

        const nextState = writeState(
          {
            ...current,
            activeEndpoint: {
              preset: nextPreset,
              baseUrl: nextUrl,
              apiKey: nextKey,
            },
          },
          { syncCustomModels: false }
        );
        return {
          ...redactStateForClient(nextState),
          proxyBaseUrl: proxy.proxyBaseUrl,
          proxyPort: proxy.proxyPort,
        };
      } catch (err) {
        return jsonError(400, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/discover',
    async (data) => {
      try {
        const current = readState();
        const rawUrl =
          typeof data?.baseUrl === 'string' && data.baseUrl.trim()
            ? data.baseUrl
            : current.activeEndpoint.baseUrl;
        const preset =
          typeof data?.preset === 'string' && data.preset.trim()
            ? data.preset.trim()
            : inferPresetFromUrl(rawUrl, current.activeEndpoint.preset);
        const rawUrlNorm = (() => {
          try {
            return normalizeBaseUrl(rawUrl);
          } catch {
            return rawUrl;
          }
        })();
        const sameAsActive = rawUrlNorm === current.activeEndpoint.baseUrl;
        const apiKey =
          typeof data?.apiKey === 'string' && data.apiKey !== '••••••••'
            ? data.apiKey.trim()
            : sameAsActive && current.activeEndpoint.apiKey
              ? current.activeEndpoint.apiKey
              : findSavedEndpointKey(current, rawUrlNorm, preset);

        const result = await discoverModels({ baseUrl: rawUrl, apiKey, preset });
        upsertSavedEndpoint(current, {
          preset: result.preset,
          baseUrl: result.resolvedBaseUrl,
          apiKey,
        });
        const nextState = writeState(
          {
            ...current,
            activeEndpoint: {
              preset: result.preset,
              baseUrl: result.resolvedBaseUrl,
              apiKey,
            },
            discovered: {
              baseUrl: result.resolvedBaseUrl,
              fetchedAt: result.fetchedAt,
              models: result.models,
            },
          },
          { syncCustomModels: false }
        );

        return {
          resolvedBaseUrl: result.resolvedBaseUrl,
          preset: result.preset,
          total: result.total,
          fetchedAt: result.fetchedAt,
          models: result.models,
          state: redactStateForClient(nextState),
        };
      } catch (err) {
        return jsonError(502, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/scan-local',
    async () => {
      const endpoints = await scanLocalEndpoints();
      return { endpoints };
    },
    'POST'
  );

  app.api(
    '/api/models/add',
    (data) => {
      try {
        const current = readState();
        const items = Array.isArray(data?.models) ? data.models : [data];
        if (items.length === 0) {
          return jsonError(400, 'No models provided to add');
        }
        const endpointBaseUrl =
          typeof data?.baseUrl === 'string' && data.baseUrl.trim()
            ? data.baseUrl
            : current.activeEndpoint.baseUrl;
        const endpointPreset =
          typeof data?.preset === 'string' && data.preset.trim()
            ? data.preset.trim()
            : current.activeEndpoint.preset;
        const sameBaseAsActive = (() => {
          try {
            return normalizeBaseUrl(endpointBaseUrl) === current.activeEndpoint.baseUrl;
          } catch {
            return false;
          }
        })();
        const endpointApiKey =
          typeof data?.apiKey === 'string' && data.apiKey !== '••••••••'
            ? data.apiKey.trim()
            : (sameBaseAsActive && current.activeEndpoint.apiKey) ||
              findSavedEndpointKey(current, endpointBaseUrl, endpointPreset);

        const res = addModels(items, {
          endpointOverrides: {
            baseUrl: endpointBaseUrl,
            apiKey: endpointApiKey,
            preset: endpointPreset,
          },
        });
        return {
          ...res,
          proxyBaseUrl: proxy.proxyBaseUrl,
        };
      } catch (err) {
        return jsonError(400, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/models/update',
    (data) => {
      try {
        if (!data?.id) return jsonError(400, 'Model id is required');
        const res = updateModel(data.id, data);
        return { ...res, proxyBaseUrl: proxy.proxyBaseUrl };
      } catch (err) {
        return jsonError(404, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/models/remove',
    (data) => {
      try {
        const target = data?.id || data?.modelId;
        if (!target) return jsonError(400, 'Model id is required');
        const res = removeModel(target);
        return { ...res, proxyBaseUrl: proxy.proxyBaseUrl };
      } catch (err) {
        return jsonError(404, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/models/test',
    async (data) => {
      try {
        const current = readState();
        const apiKey =
          typeof data?.apiKey === 'string' && data.apiKey !== '••••••••'
            ? data.apiKey
            : data?.id || data?.modelId
              ? undefined
              : current.activeEndpoint.apiKey;
        return await testModel({
          id: data?.id,
          modelId: data?.modelId,
          baseUrl: data?.baseUrl,
          apiKey,
          prompt: data?.prompt,
          harness: data?.harness,
          taskType: data?.taskType,
          thinkingLevel: data?.thinkingLevel,
          runId: data?.runId,
        });
      } catch (err) {
        return jsonError(502, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/direct-chat',
    (data) => {
      try {
        const res = setDirectChatConfig({
          enabled: data?.enabled,
          modelId: data?.modelId ?? data?.model ?? data?.id,
          mode: data?.mode,
        });
        return { ...res, proxyBaseUrl: proxy.proxyBaseUrl };
      } catch (err) {
        return jsonError(400, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/agent-settings',
    (data) => {
      try {
        const res = setAgentSettings({
          harness: data?.harness,
          thinkingLevel: data?.thinkingLevel,
          verbose: data?.verbose,
          uiMode: data?.uiMode,
          maxThinkingLoops: data?.maxThinkingLoops ?? data?.maxLoops ?? data?.maxSteps,
        });
        return { ...res, proxyBaseUrl: proxy.proxyBaseUrl };
      } catch (err) {
        return jsonError(400, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/models/chat',
    async (data) => {
      try {
        return await chatWithModel({
          modelId: data?.modelId || data?.id,
          baseUrl: data?.baseUrl,
          apiKey: data?.apiKey,
          messages: data?.messages,
          prompt: data?.prompt,
          systemPrompt: data?.systemPrompt,
          files: data?.files,
          sessionId: data?.sessionId,
          resetSession: Boolean(data?.resetSession),
          autoDiscover: data?.autoDiscover !== false,
          enableTools: data?.enableTools,
          cwd: data?.cwd,
          maxSteps: data?.maxSteps,
          maxThinkingLoops: data?.maxThinkingLoops,
          allowWrite: data?.allowWrite,
          temperature: data?.temperature,
          maxTokens: data?.maxTokens,
          harness: data?.harness,
          taskType: data?.taskType,
          thinkingLevel: data?.thinkingLevel,
          runId: data?.runId,
        });
      } catch (err) {
        return jsonError(502, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/models/hybrid',
    async (data) => {
      try {
        return await runHybridOrchestration({
          modelId: data?.modelId || data?.id,
          fileName: data?.fileName,
          sourceCode: data?.sourceCode,
          task: data?.task,
        });
      } catch (err) {
        return jsonError(502, err.message);
      }
    },
    'POST'
  );

  app.api(
    '/api/streams',
    (data) => {
      const limit = Number(data?.limit) || 12;
      return {
        runs: listRecentStreams({ streamsDir: getStreamsDir(), limit }),
      };
    },
    'GET'
  );

  app.api(
    '/api/streams/poll',
    (data) => {
      const runId = typeof data?.runId === 'string' ? data.runId.trim() : '';
      if (!runId) return jsonError(400, 'runId is required');
      const cursor = Number(data?.cursor) || 0;
      return readStreamEvents({ streamsDir: getStreamsDir(), runId, cursor });
    },
    'GET'
  );

  app.api(
    '/api/sdk',
    (data) => {
      const target = resolveConfiguredModel(data?.id || data?.modelId);
      const masked = target ? { ...target, hasApiKey: Boolean(target.apiKey) } : null;
      return generateSdkSnippets(masked, proxy.proxyBaseUrl);
    },
    'GET'
  );

  app.api(
    '/api/usage',
    async () => {
      const state = readState();
      const addedModels = (state.models || []).map((m) => ({
        id: m.id,
        label: m.displayName || m.modelId,
        modelId: m.modelId,
        baseUrl: m.baseUrl,
        preset: m.preset,
        enabled: m.enabled,
        isDefault: m.isDefault,
        hasApiKey: Boolean(m.apiKey),
        contextWindow: m.contextWindow,
        harness: m.harness || '',
        thinkingLevel: m.thinkingLevel || '',
      }));

      const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
      const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (!lsAddr || !csrf) {
        return {
          models: [],
          addedModels,
          agentSettings: state.agentSettings,
          planStatus: { planName: null },
          lsWarning: 'Language server unavailable',
        };
      }

      try {
        const res = await fetch(
          `http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-codeium-csrf-token': csrf,
            },
            body: '{}',
            signal: AbortSignal.timeout(4000),
          }
        );

        if (!res.ok) {
          return {
            models: [],
            addedModels,
            agentSettings: state.agentSettings,
            planStatus: { planName: null },
            lsWarning: `GetUserStatus failed: HTTP ${res.status}`,
          };
        }

        const payload = await res.json();
        const userStatus = payload?.userStatus ?? {};
        const rawConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
        const models = groupUsageModels(rawConfigs);
        const ps = userStatus?.planStatus ?? {};
        return {
          models,
          addedModels,
          agentSettings: state.agentSettings,
          planStatus: { planName: ps.planInfo?.planName ?? null },
        };
      } catch (err) {
        return {
          models: [],
          addedModels,
          agentSettings: state.agentSettings,
          planStatus: { planName: null },
          lsWarning: err.message,
        };
      }
    },
    'GET'
  );

  process.on('exit', cleanupRuntimeFile);
  process.on('SIGINT', () => {
    cleanupRuntimeFile();
    proxy.server.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanupRuntimeFile();
    proxy.server.close();
    process.exit(0);
  });

  await app.run();
  return { app, proxy };
}

const isEntrypoint =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  startSidecar().catch((err) => {
    console.error('[agy-local-agents] sidecar failed to start:', err);
    process.exit(1);
  });
}
