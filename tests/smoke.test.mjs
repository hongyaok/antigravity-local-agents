/**
 * End-to-end smoke test for agy-local-agents:
 * - Model store, discovery, custom_models.json migration, agents sync (no local-subagent.md, has orchestrator-to-local.md)
 * - Auto harness classification (coding -> mini-swe-agent, knowledge -> native)
 * - Live NDJSON stream bus, MCP server (ui:// MCP App, notifications/progress, structuredContent, stream watch/poll)
 * - CLI live token streaming (`[Thinking]` + `[Response]`), `stream` subcommand, and PreInvocation hook
 * - Sidecar HTTP, Simple/Advanced UI mode, /api/streams, and loopback OpenAI proxy
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

function startMockOpenAIServer({ requireKey = 'secret-test-key', onChat = null } = {}) {
  const chatRequests = [];
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization || '';
    if (requireKey && auth !== `Bearer ${requireKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'gemma4:26b', owned_by: 'google', context_length: 65536 },
            { id: 'qwen2.5-coder:14b', owned_by: 'alibaba', context_length: 32768 },
          ],
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      chatRequests.push(body);
      if (typeof onChat === 'function') {
        const custom = await onChat(body, chatRequests, res);
        if (custom === 'HANDLED') return;
        if (custom) {
          res.writeHead(custom.status || 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(custom.json));
          return;
        }
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userText = messages.at(-1)?.content || '';
      const hasToolResult = messages.some((m) => m.role === 'tool');

      if (!hasToolResult && Array.isArray(body.tools) && userText.includes('USE_TOOL_READ_SAMPLE:')) {
        const match = userText.match(/USE_TOOL_READ_SAMPLE:([^\s]+)/);
        const targetPath = match ? match[1] : 'sample.txt';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-tool-1',
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_read_sample',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ Path: targetPath }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
          })
        );
        return;
      }

      if (hasToolResult) {
        const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-tool-2',
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: `Verified tool output for ${body.model}: ${toolMsg?.content || ''}`,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
          })
        );
        return;
      }

      const isCritic = userText.includes('Candidate 1') && userText.includes('Candidate 2');
      const reply = isCritic
        ? '2 - Defensive hardening and input validation preserve public signature.'
        : `OK from ${body.model}: ${userText.slice(0, 40)}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          model: body.model,
          choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        })
      );
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        chatRequests,
        baseUrl: `http://127.0.0.1:${port}`,
        v1Url: `http://127.0.0.1:${port}/v1`,
      });
    });
  });
}

test('store discovery, custom_models migration, agents sync (no local-subagent.md), chat, and hybrid orchestration', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-local-agents-test-'));
  const cfgPath = join(tempDir, 'config.json');
  const customModelsPath = join(tempDir, 'custom_models.json');
  const agentsDir = join(tempDir, 'agents');
  const sessionsDir = join(tempDir, 'sessions');
  const streamsDir = join(tempDir, 'streams');

  mkdirSync(agentsDir, { recursive: true });
  // Pre-seed legacy `local-subagent.md` to ensure sync deletes it
  writeFileSync(
    join(agentsDir, 'local-subagent.md'),
    '<!-- [agy-add-models-managed-agent] -->\nlegacy\n',
    'utf-8'
  );

  // Seed unrelated user model + legacy agy-add-models entry
  writeFileSync(
    customModelsPath,
    JSON.stringify({
      models: [
        {
          name: 'models/existing-user-model',
          provider: 'openai',
          apiUrl: 'https://api.openai.com/v1',
          externalModelName: 'gpt-4o-mini',
        },
        {
          name: 'models/agy-legacy-old',
          description: 'Added via agy-add-models (http://127.0.0.1:11434/v1) [agy-add-models]',
          provider: 'ollama',
          apiUrl: 'http://127.0.0.1:11434/v1',
          externalModelName: 'old-model',
        },
      ],
    })
  );

  process.env.AGY_LOCAL_AGENTS_CONFIG_PATH = cfgPath;
  process.env.AGY_CUSTOM_MODELS_PATH = customModelsPath;
  process.env.AGY_LOCAL_AGENTS_AGENTS_DIR = agentsDir;
  process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR = sessionsDir;
  process.env.AGY_LOCAL_AGENTS_STREAMS_DIR = streamsDir;

  const mock = await startMockOpenAIServer({ requireKey: 'secret-test-key' });
  const store = await import('../sidecars/agents/store.mjs');

  try {
    await assert.rejects(
      () => store.discoverModels({ baseUrl: mock.v1Url, apiKey: '' }),
      /Invalid API key|401/
    );

    const disc = await store.discoverModels({
      baseUrl: mock.baseUrl,
      apiKey: 'secret-test-key',
    });
    assert.equal(disc.resolvedBaseUrl, mock.v1Url);
    assert.equal(disc.models.length, 2);

    const added = store.addModels([disc.models[0]], {
      endpointOverrides: { baseUrl: disc.resolvedBaseUrl, apiKey: 'secret-test-key', preset: 'ollama' },
    });
    assert.equal(added.added.length, 1);
    assert.equal(added.added[0].isDefault, true);
    assert.equal(added.added[0].agentName, 'local-gemma4-26b');

    // Verify custom_models.json kept user model, replaced legacy agy-add-models entry with [agy-local-agents]
    const customSaved = JSON.parse(readFileSync(customModelsPath, 'utf-8'));
    assert.equal(customSaved.models.length, 2);
    assert.ok(customSaved.models.some((m) => m.name === 'models/existing-user-model'));
    assert.ok(customSaved.models.some((m) => m.description?.includes('[agy-local-agents]')));
    assert.equal(
      customSaved.models.some((m) => m.name === 'models/agy-legacy-old'),
      false
    );

    // Verify Main Agent files synced: orchestrator-to-local.md present, local-subagent.md REMOVED
    assert.equal(existsSync(join(agentsDir, 'local-subagent.md')), false);
    const orchestratorMd = readFileSync(join(agentsDir, 'orchestrator-to-local.md'), 'utf-8');
    assert.match(orchestratorMd, /mainAgent: true/);
    assert.match(orchestratorMd, /agy_local_subagent/);
    assert.match(orchestratorMd, /agy_local_stream_watch/);
    assert.match(readFileSync(join(agentsDir, 'local-model-chat.md'), 'utf-8'), /mainAgent: true/);
    assert.match(readFileSync(join(agentsDir, 'local-gemma4-26b.md'), 'utf-8'), /mainAgent: true/);

    const chatRes = await store.testModel({ id: added.added[0].id });
    assert.equal(chatRes.ok, true);
    assert.match(chatRes.reply, /OK from gemma4:26b/);

    const hybrid = await store.runHybridOrchestration({
      modelId: 'gemma4:26b',
      fileName: 'auth.py',
      sourceCode: 'import os\nSECRET = "sk-123"\ndef get_key():\n    return os.environ.get("K", SECRET)\n',
      task: 'Remove hardcoded fallback secret.',
    });
    assert.equal(hybrid.candidates.length, 2);
    assert.equal(hybrid.winner.builder, 'defensive');

    const snippets = store.generateSdkSnippets(added.added[0], 'http://127.0.0.1:55555/v1');
    assert.equal(snippets.usesAuthProxy, true);
    assert.match(snippets.basic, /agy-local-agents/);

    store.removeModel(added.added[0].id);
    assert.equal(existsSync(join(agentsDir, 'local-gemma4-26b.md')), false);
    assert.equal(existsSync(join(agentsDir, 'orchestrator-to-local.md')), true);
  } finally {
    mock.server.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.AGY_LOCAL_AGENTS_CONFIG_PATH;
    delete process.env.AGY_CUSTOM_MODELS_PATH;
    delete process.env.AGY_LOCAL_AGENTS_AGENTS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_STREAMS_DIR;
  }
});

test('auto harness classification (coding -> mini-swe-agent, knowledge -> native) and precedence', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-local-agents-auto-'));
  process.env.AGY_LOCAL_AGENTS_CONFIG_PATH = join(tempDir, 'config.json');
  process.env.AGY_CUSTOM_MODELS_PATH = join(tempDir, 'custom_models.json');
  process.env.AGY_LOCAL_AGENTS_AGENTS_DIR = join(tempDir, 'agents');
  process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR = join(tempDir, 'sessions');
  process.env.AGY_LOCAL_AGENTS_STREAMS_DIR = join(tempDir, 'streams');

  const harnesses = await import('../sidecars/agents/harnesses.mjs');
  const store = await import('../sidecars/agents/store.mjs');

  // Unit checks
  assert.deepEqual(harnesses.classifyTaskForAutoHarness({ text: 'Summarize notes', taskType: 'coding' }), {
    harness: 'mini-swe-agent',
    taskType: 'coding',
    reason: 'caller:coding',
  });
  assert.deepEqual(harnesses.classifyTaskForAutoHarness({ text: 'Refactor auth.ts', taskType: 'knowledge' }), {
    harness: 'native',
    taskType: 'knowledge',
    reason: 'caller:knowledge',
  });
  assert.equal(
    harnesses.classifyTaskForAutoHarness({ text: 'Debug the failing unit test in auth.ts' }).harness,
    'mini-swe-agent'
  );
  assert.equal(
    harnesses.classifyTaskForAutoHarness({ text: 'Summarize our quarterly meeting notes and draft an email' }).harness,
    'native'
  );
  assert.equal(
    harnesses.classifyTaskForAutoHarness({ text: 'Compare these two ideas briefly' }).harness,
    'native'
  );
  assert.equal(
    harnesses.classifyTaskForAutoHarness({ text: 'Review this file', files: ['src/app.ts'] }).harness,
    'mini-swe-agent'
  );

  // Explicit model/global override beats auto
  const effPin = harnesses.resolveEffectiveAgentConfig(
    { agentSettings: { harness: 'auto', thinkingLevel: 'auto' } },
    { harness: 'native', thinkingLevel: '' }
  );
  assert.equal(effPin.harness, 'native');
  assert.equal(effPin.harnessSource, 'model');

  const mock = await startMockOpenAIServer({ requireKey: '' });
  try {
    store.addModels([{ id: 'qwen2.5-coder:14b', baseUrl: mock.v1Url, isDefault: true }]);

    // Coding task in default `auto` mode -> resolves to mini-swe-agent
    const codingRes = await store.runLocalSubagent({
      task: 'Debug the failing unit test in auth.ts',
      cwd: tempDir,
      maxSteps: 3,
    });
    assert.equal(codingRes.configuredHarness, 'auto');
    assert.equal(codingRes.harness, 'mini-swe-agent');
    assert.equal(codingRes.harnessAutoReason, 'auto:coding');
    assert.match(mock.chatRequests.at(-1).messages[0].content, /mini-SWE-agent/);

    // Knowledge task in default `auto` mode -> resolves to native
    const knowledgeRes = await store.runLocalSubagent({
      task: 'Summarize the project architecture and draft executive notes',
      cwd: tempDir,
      maxSteps: 3,
    });
    assert.equal(knowledgeRes.configuredHarness, 'auto');
    assert.equal(knowledgeRes.harness, 'native');
    assert.equal(knowledgeRes.harnessAutoReason, 'auto:knowledge');

    // Explicit taskType override
    const explicitKnowledge = await store.runLocalSubagent({
      task: 'Explain auth.ts in simple prose',
      taskType: 'knowledge',
      cwd: tempDir,
      maxSteps: 3,
    });
    assert.equal(explicitKnowledge.harness, 'native');
    assert.equal(explicitKnowledge.harnessAutoReason, 'caller:knowledge');
  } finally {
    mock.server.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.AGY_LOCAL_AGENTS_CONFIG_PATH;
    delete process.env.AGY_CUSTOM_MODELS_PATH;
    delete process.env.AGY_LOCAL_AGENTS_AGENTS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_STREAMS_DIR;
  }
});

test('MCP stdio server: agy_local_* tools, ui:// MCP App resource, notifications/progress, structuredContent, stream watch/poll, legacy aliases', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-local-agents-mcp-'));
  const cfgPath = join(tempDir, 'config.json');
  const customModelsPath = join(tempDir, 'custom_models.json');
  const agentsDir = join(tempDir, 'agents');
  const sessionsDir = join(tempDir, 'sessions');
  const streamsDir = join(tempDir, 'streams');
  const mcpCheckScript = join(tempDir, 'mcp-check.mjs');
  writeFileSync(mcpCheckScript, "console.log('MCP_BASH_OK');\n", 'utf-8');

  const mock = await startMockOpenAIServer({
    requireKey: '',
    onChat: (body) => {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = messages.some((m) => m.role === 'tool');
      const allText = messages.map((m) => String(m.content || '')).join('\n');
      if (!allText.includes('MINI_SWE_MCP_TASK')) return null;

      if (!hasToolResult) {
        return {
          status: 200,
          json: {
            id: 'chatcmpl-mcp-mswe-1',
            model: body.model,
            choices: [
              {
                message: {
                  role: 'assistant',
                  reasoning_content: 'Planning to execute check script.',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_mcp_bash_1',
                      type: 'function',
                      function: {
                        name: 'bash',
                        arguments: JSON.stringify({ command: 'node mcp-check.mjs' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 18, completion_tokens: 12, total_tokens: 30 },
          },
        };
      }

      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      return {
        status: 200,
        json: {
          id: 'chatcmpl-mcp-mswe-2',
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\nMCP mini-SWE observed: ${String(lastTool?.content || '').includes('MCP_BASH_OK')}`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 22, completion_tokens: 14, total_tokens: 36 },
        },
      };
    },
  });

  const child = spawn('node', [join(PLUGIN_ROOT, 'mcp', 'server.mjs')], {
    env: {
      ...process.env,
      AGY_LOCAL_AGENTS_CONFIG_PATH: cfgPath,
      AGY_CUSTOM_MODELS_PATH: customModelsPath,
      AGY_LOCAL_AGENTS_AGENTS_DIR: agentsDir,
      AGY_LOCAL_AGENTS_SESSIONS_DIR: sessionsDir,
      AGY_LOCAL_AGENTS_STREAMS_DIR: streamsDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = new Map();
  const notifications = [];
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf-8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && responses.has(msg.id)) {
        responses.get(msg.id)(msg);
        responses.delete(msg.id);
      } else if (msg.method) {
        notifications.push(msg);
      }
    }
  });

  function rpc(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 8000);
      responses.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'agy-local-agents');
    assert.ok(init.result.capabilities.resources);

    const resList = await rpc(11, 'resources/list');
    assert.equal(resList.result.resources[0].uri, 'ui://agy-local-agents/stream.html');
    assert.equal(resList.result.resources[0].mimeType, 'text/html;profile=mcp-app');

    const resRead = await rpc(12, 'resources/read', { uri: 'ui://agy-local-agents/stream.html' });
    const appHtml = resRead.result.contents[0].text;
    assert.equal(resRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(appHtml, /ui\/initialize/);
    assert.equal(/https?:\/\/cdn|unpkg|fonts\.googleapis/.test(appHtml), false);

    const toolsList = await rpc(2, 'tools/list');
    const tools = toolsList.result.tools;
    const names = tools.map((t) => t.name);
    for (const expected of [
      'agy_local_list',
      'agy_local_discover',
      'agy_local_add',
      'agy_local_chat',
      'agy_local_subagent',
      'agy_local_stream_watch',
      'agy_local_stream_poll',
      'agy_local_agent_settings',
    ]) {
      assert.ok(names.includes(expected), `Missing tool ${expected}`);
    }

    const subTool = tools.find((t) => t.name === 'agy_local_subagent');
    assert.equal(subTool._meta.ui.resourceUri, 'ui://agy-local-agents/stream.html');
    assert.ok(subTool.inputSchema.properties.taskType);

    const pollTool = tools.find((t) => t.name === 'agy_local_stream_poll');
    assert.deepEqual(pollTool._meta.ui.visibility, ['app']);

    await rpc(3, 'tools/call', {
      name: 'agy_local_add',
      arguments: { modelId: 'qwen2.5-coder:14b', baseUrl: mock.v1Url, isDefault: true },
    });

    const listCall = await rpc(4, 'tools/call', {
      name: 'agy_local_list',
      arguments: {},
    });
    const listData = JSON.parse(listCall.result.content[0].text);
    assert.equal(listData.agentSettings.harness, 'auto');
    assert.equal(listData.agentSettings.uiMode, 'simple');
    assert.equal(listData.harnesses.length, 3);

    // Legacy alias still works
    const legacyCall = await rpc(41, 'tools/call', {
      name: 'agy_models_list',
      arguments: {},
    });
    assert.equal(JSON.parse(legacyCall.result.content[0].text).total, 1);

    // Direct call follows agentSettings.maxThinkingLoops; orchestrator override wins when provided
    const asSet = await rpc(42, 'tools/call', {
      name: 'agy_local_agent_settings',
      arguments: { maxThinkingLoops: 4 },
    });
    assert.equal(JSON.parse(asSet.result.content[0].text).agentSettings.maxThinkingLoops, 4);

    const subCall = await rpc(5, 'tools/call', {
      name: 'agy_local_subagent',
      arguments: {
        task: 'MINI_SWE_MCP_TASK',
        taskType: 'coding',
        runId: 'mcp-run-1',
        cwd: tempDir,
      },
      _meta: { progressToken: 'prog-1' },
    });
    const subData = subCall.result.structuredContent;
    assert.equal(subData.runId, 'mcp-run-1');
    assert.equal(subData.harness, 'mini-swe-agent');
    assert.equal(subData.harnessAutoReason, 'caller:coding');
    assert.equal(subData.maxThinkingLoops, 4);
    assert.equal(subData.submitted, true);
    const progNotes = notifications.filter(
      (n) => n.method === 'notifications/progress' && n.params.progressToken === 'prog-1'
    );
    assert.ok(progNotes.length > 0);
    for (const pn of progNotes) {
      assert.equal(pn.params.total, undefined, 'notifications/progress must omit total so no progress bar is shown');
    }

    // Orchestrator explicit maxThinkingLoops override takes precedence over agentSettings
    const orchOverrideCall = await rpc(51, 'tools/call', {
      name: 'agy_local_subagent',
      arguments: {
        task: 'MINI_SWE_MCP_TASK',
        taskType: 'coding',
        maxThinkingLoops: 7,
        runId: 'mcp-run-orch',
        cwd: tempDir,
      },
    });
    assert.equal(orchOverrideCall.result.structuredContent.maxThinkingLoops, 7);

    const watchCall = await rpc(6, 'tools/call', {
      name: 'agy_local_stream_watch',
      arguments: { runId: 'mcp-run-1', title: 'Watch test' },
    });
    assert.equal(watchCall.result.structuredContent.watching, true);
    assert.equal(watchCall.result.structuredContent.runs[0].status, 'done');

    const pollCall = await rpc(7, 'tools/call', {
      name: 'agy_local_stream_poll',
      arguments: { runId: 'mcp-run-1', cursors: { 'mcp-run-1': 0 } },
    });
    const polledEvents = pollCall.result.structuredContent.runs[0].events;
    assert.ok(polledEvents.some((e) => e.type === 'run_start'));
    assert.ok(polledEvents.some((e) => e.type === 'tool_start' && e.tool === 'bash'));
    assert.ok(polledEvents.some((e) => e.type === 'run_end'));
  } finally {
    child.kill();
    mock.server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI live SSE streaming ([Thinking] + [Response]), stream subcommand, and PreInvocation hook', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-local-agents-cli-'));
  const cfgPath = join(tempDir, 'config.json');
  const customModelsPath = join(tempDir, 'custom_models.json');
  const agentsDir = join(tempDir, 'agents');
  const sessionsDir = join(tempDir, 'sessions');
  const streamsDir = join(tempDir, 'streams');

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const hasToolRes = (body.messages || []).some((m) => m.role === 'tool');

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sendSse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (!hasToolRes && Array.isArray(body.tools)) {
        sendSse({ id: 's1', model: body.model, choices: [{ index: 0, delta: { reasoning_content: 'Checking dir. ' } }] });
        sendSse({
          id: 's1',
          model: body.model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"Path":"."}' } }] }, finish_reason: 'tool_calls' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      sendSse({ id: 's2', model: body.model, choices: [{ index: 0, delta: { content: '<think>Ready to answer.</think>STREAM_ANSWER_OK' }, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'j1',
        model: body.model,
        choices: [{ message: { role: 'assistant', reasoning_content: 'Hook thought', content: 'HOOK_OK' }, finish_reason: 'stop' }],
      })
    );
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const v1Url = `http://127.0.0.1:${server.address().port}/v1`;
  const env = {
    ...process.env,
    AGY_LOCAL_AGENTS_CONFIG_PATH: cfgPath,
    AGY_CUSTOM_MODELS_PATH: customModelsPath,
    AGY_LOCAL_AGENTS_AGENTS_DIR: agentsDir,
    AGY_LOCAL_AGENTS_SESSIONS_DIR: sessionsDir,
    AGY_LOCAL_AGENTS_STREAMS_DIR: streamsDir,
  };
  const cliPath = join(PLUGIN_ROOT, 'skills', 'local-models', 'scripts', 'local-model.mjs');
  const hookPath = join(PLUGIN_ROOT, 'mcp', 'direct-chat-hook.mjs');

  const runCli = async (args) => {
    const { stdout } = await execFileAsync('node', [cliPath, ...args], { env, encoding: 'utf-8' });
    return stdout;
  };
  const runHook = (payload) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c.toString('utf-8'); });
      child.stderr.on('data', (c) => { err += c.toString('utf-8'); });
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      child.stdin.end(JSON.stringify(payload));
    });

  try {
    await runCli(['add', '--model', 'coder-iq1_m', '--url', v1Url, '--default', '--json']);

    const { stdout: cliOut } = await execFileAsync(
      'node',
      [cliPath, 'subagent', '--run-id', 'cli-stream-1', '--task-type', 'knowledge', '--cwd', tempDir, '--task', 'Check dir'],
      { env, encoding: 'utf-8' }
    );
    assert.match(cliOut, /runId=cli-stream-1/);
    assert.match(cliOut, /harness=native \(caller:knowledge\)/);
    assert.match(cliOut, /\[Thinking\]/);
    assert.match(cliOut, /Checking dir\./);
    assert.match(cliOut, /-> Tool: list_dir/);
    assert.match(cliOut, /\[Response\]/);
    assert.match(cliOut, /STREAM_ANSWER_OK/);
    // Ensure streamed final reply isn't printed twice
    assert.equal(cliOut.match(/STREAM_ANSWER_OK/g)?.length, 1);

    const streamList = JSON.parse(await runCli(['stream', 'list', '--json']));
    assert.ok(streamList.runs.some((r) => r.runId === 'cli-stream-1' && r.status === 'done'));

    await runCli(['direct-chat', 'on', '--model', 'coder-iq1_m', '--json']);

    // `/orchestrator-to-local` must bypass Direct Chat so Gemini orchestrates
    const orchBypass = await runHook({
      conversationId: 'c1',
      initialNumSteps: 0,
      lastUserInput: '/orchestrator-to-local split this across local subagents',
    });
    assert.deepEqual(orchBypass, {});

    // Normal message uses Direct Chat + Auto harness
    const directRes = await runHook({
      conversationId: 'c1',
      initialNumSteps: 1,
      lastUserInput: 'Summarize project notes',
    });
    assert.equal(directRes.terminationBehavior, 'terminate');
    assert.match(directRes.injectSteps[0].systemMessage.metadata.user_markdown, /\[native \(auto\) · auto\]/);
  } finally {
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('sidecar HTTP endpoints, Simple/Advanced UI HTML, /api/streams, and loopback proxy', async () => {
  let canLoadSidecar = false;
  try {
    await import('sidecar_sdk');
    canLoadSidecar = true;
  } catch {
    canLoadSidecar = false;
  }
  assert.equal(canLoadSidecar, true, 'sidecar_sdk must be resolvable');

  const tempDir = mkdtempSync(join(tmpdir(), 'agy-local-agents-sidecar-'));
  const mock = await startMockOpenAIServer({ requireKey: 'sidecar-bearer-key' });

  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const webPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-test';
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = String(webPort);
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'ui-test-token';
  process.env.AGY_LOCAL_AGENTS_CONFIG_PATH = join(tempDir, 'config.json');
  process.env.AGY_CUSTOM_MODELS_PATH = join(tempDir, 'custom_models.json');
  process.env.AGY_LOCAL_AGENTS_AGENTS_DIR = join(tempDir, 'agents');
  process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR = join(tempDir, 'sessions');
  process.env.AGY_LOCAL_AGENTS_STREAMS_DIR = join(tempDir, 'streams');

  const { startSidecar } = await import('../sidecars/agents/main.mjs');
  const { app, proxy } = await startSidecar();

  try {
    const html = await fetch(`http://127.0.0.1:${webPort}/`).then((r) => r.text());
    assert.match(html, /Local Agents/);
    assert.match(html, /id="ui-mode-toggle"/);
    assert.match(html, /id="simple-nav"/);
    assert.match(html, /id="live-streams-strip"/);
    assert.match(html, /id="monitor-chip"/);
    assert.match(html, /id="harness-grid"/);
    assert.match(html, /id="thinking-pills"/);
    assert.match(html, /id="max-loops-input"/);

    const monitorHtml = await fetch(`http://127.0.0.1:${webPort}/monitor.html`).then((r) => r.text());
    assert.match(monitorHtml, /Local Subagents/);
    assert.match(monitorHtml, /id="agents-grid"/);
    assert.match(monitorHtml, /id="inspector-card"/);
    assert.match(monitorHtml, /Pixelify Sans/);

    const cfgInit = await fetch(`http://127.0.0.1:${webPort}/api/config`).then((r) => r.json());
    assert.equal(cfgInit.harnesses.length, 3);
    assert.equal(cfgInit.harnesses[0].id, 'auto');
    assert.deepEqual(cfgInit.agentSettings, {
      harness: 'auto',
      thinkingLevel: 'auto',
      verbose: true,
      uiMode: 'simple',
      maxThinkingLoops: 10,
    });

    const asUpdate = await fetch(`http://127.0.0.1:${webPort}/api/agent-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'ui-test-token' },
      body: JSON.stringify({
        harness: 'mini-swe-agent',
        thinkingLevel: 'high',
        verbose: false,
        uiMode: 'advanced',
        maxThinkingLoops: 6,
      }),
    }).then((r) => r.json());
    assert.deepEqual(asUpdate.agentSettings, {
      harness: 'mini-swe-agent',
      thinkingLevel: 'high',
      verbose: false,
      uiMode: 'advanced',
      maxThinkingLoops: 6,
    });

    const discRes = await fetch(`http://127.0.0.1:${webPort}/api/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'ui-test-token' },
      body: JSON.stringify({ baseUrl: mock.v1Url, apiKey: 'sidecar-bearer-key' }),
    }).then((r) => r.json());
    assert.equal(discRes.total, 2);

    const addRes = await fetch(`http://127.0.0.1:${webPort}/api/models/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'ui-test-token' },
      body: JSON.stringify({ models: [discRes.models[0]] }),
    }).then((r) => r.json());
    assert.equal(addRes.added.length, 1);

    const chatRes = await fetch(`http://127.0.0.1:${webPort}/api/models/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'ui-test-token' },
      body: JSON.stringify({
        id: addRes.added[0].id,
        runId: 'local-subagent-1',
        prompt: 'Sidecar chat test',
        taskType: 'knowledge',
        enableTools: true,
        maxThinkingLoops: 5,
        harness: 'auto',
      }),
    }).then((r) => r.json());
    assert.equal(chatRes.ok, true);
    assert.equal(chatRes.harness, 'native');
    assert.equal(chatRes.maxThinkingLoops, 5);

    const streamsRes = await fetch(`http://127.0.0.1:${webPort}/api/streams`).then((r) => r.json());
    assert.ok(streamsRes.runs.length >= 1);
    const runMeta = streamsRes.runs.find((r) => r.runId === 'local-subagent-1');
    assert.ok(runMeta);
    assert.equal(runMeta.taskType, 'knowledge');
    assert.equal(runMeta.maxThinkingLoops, 5);

    const pollRes = await fetch(
      `http://127.0.0.1:${webPort}/api/streams/poll?runId=local-subagent-1&cursor=0`
    ).then((r) => r.json());
    assert.equal(pollRes.exists, true);
    assert.ok(pollRes.events.length >= 2);

    // Reusing sequential runId resets stream cleanly without appending stale events
    await fetch(`http://127.0.0.1:${webPort}/api/models/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': 'ui-test-token' },
      body: JSON.stringify({
        id: addRes.added[0].id,
        runId: 'local-subagent-1',
        prompt: 'Reused sequential runId test',
        taskType: 'coding',
        enableTools: true,
        maxThinkingLoops: 3,
      }),
    }).then((r) => r.json());
    const resetPoll = await fetch(
      `http://127.0.0.1:${webPort}/api/streams/poll?runId=local-subagent-1&cursor=99`
    ).then((r) => r.json());
    assert.equal(resetPoll.reset, true);
    assert.equal(resetPoll.meta.taskType, 'coding');
    assert.equal(resetPoll.meta.maxThinkingLoops, 3);

    const proxyChat = await fetch(`${proxy.proxyBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4:26b', messages: [{ role: 'user', content: 'Hello proxy' }] }),
    }).then((r) => r.json());
    assert.match(proxyChat.choices[0].message.content, /OK from gemma4:26b/);
  } finally {
    await app.close();
    proxy.server.close();
    mock.server.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    delete process.env.AGY_LOCAL_AGENTS_CONFIG_PATH;
    delete process.env.AGY_CUSTOM_MODELS_PATH;
    delete process.env.AGY_LOCAL_AGENTS_AGENTS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_STREAMS_DIR;
  }
});

test('mini-swe-agent elision, mswea_bash_command, format_error_template, and reasoning_effort fallback', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-local-agents-mswe-'));
  process.env.AGY_LOCAL_AGENTS_CONFIG_PATH = join(tempDir, 'config.json');
  process.env.AGY_CUSTOM_MODELS_PATH = join(tempDir, 'custom_models.json');
  process.env.AGY_LOCAL_AGENTS_AGENTS_DIR = join(tempDir, 'agents');
  process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR = join(tempDir, 'sessions');
  process.env.AGY_LOCAL_AGENTS_STREAMS_DIR = join(tempDir, 'streams');

  writeFileSync(join(tempDir, 'submit.mjs'), "console.log('COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nMSWE_OK');\n", 'utf-8');

  const harnesses = await import('../sidecars/agents/harnesses.mjs');
  const store = await import('../sidecars/agents/store.mjs');

  const longObs = harnesses.formatMiniSweObservation({
    returncode: 0,
    stdout: 'H'.repeat(5000) + 'X'.repeat(2500) + 'T'.repeat(5000),
  });
  assert.match(longObs, /2500 characters elided/);
  assert.equal(longObs.includes('X'), false);

  let stepIdx = 0;
  const mock = await startMockOpenAIServer({
    requireKey: '',
    onChat: (body) => {
      if (body.reasoning_effort !== undefined) {
        return {
          status: 400,
          json: { error: { message: `Unrecognized request argument: reasoning_effort` } },
        };
      }
      stepIdx += 1;
      if (stepIdx === 1) {
        return {
          status: 200,
          json: {
            id: 'm1',
            model: body.model,
            choices: [{ message: { role: 'assistant', content: 'No action block' }, finish_reason: 'stop' }],
          },
        };
      }
      return {
        status: 200,
        json: {
          id: 'm2',
          model: body.model,
          choices: [
            {
              message: { role: 'assistant', content: '```mswea_bash_command\nnode submit.mjs\n```' },
              finish_reason: 'stop',
            },
          ],
        },
      };
    },
  });

  try {
    store.addModels([{ id: 'qwen2.5-coder:14b', baseUrl: mock.v1Url, isDefault: true }]);
    const res = await store.runLocalSubagent({
      task: 'Run mswea check',
      cwd: tempDir,
      harness: 'mini-swe-agent',
      thinkingLevel: 'high',
      maxSteps: 4,
    });
    assert.equal(res.submitted, true);
    assert.equal(res.formatErrors, 1);
    assert.equal(res.reply, 'MSWE_OK');
  } finally {
    mock.server.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.AGY_LOCAL_AGENTS_CONFIG_PATH;
    delete process.env.AGY_CUSTOM_MODELS_PATH;
    delete process.env.AGY_LOCAL_AGENTS_AGENTS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_SESSIONS_DIR;
    delete process.env.AGY_LOCAL_AGENTS_STREAMS_DIR;
  }
});
