/**
 * Full Antigravity agentic environment & tool runtime for local/custom models.
 *
 * Gives OpenAI-compatible local models access to the same workspace files,
 * terminal commands, Antigravity skills, rules, and MCP servers as main Gemini models.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const MAX_READ_LINES = 500;
const MAX_READ_BYTES = 48 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 80;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_CMD_OUTPUT_CHARS = 16 * 1024;
const MAX_RULE_BYTES = 4096;
const MAX_TOTAL_RULES_BYTES = 12288;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);

function getAppDataDir() {
  return process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
}

function getGeminiConfigDir() {
  return process.env.AGY_GEMINI_CONFIG_DIR || join(homedir(), '.gemini', 'config');
}

function readDisabledPluginsMap() {
  const cfgPath = join(getGeminiConfigDir(), 'config.json');
  const map = new Map();
  if (!existsSync(cfgPath)) return map;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const plugins = parsed?.plugins;
    if (plugins && typeof plugins === 'object') {
      for (const [dir, val] of Object.entries(plugins)) {
        if (val && typeof val === 'object' && typeof val.enabled === 'boolean') {
          map.set(dir, val.enabled);
        }
      }
    }
  } catch {
    // Ignore malformed config.json.
  }
  return map;
}

function isPluginEnabled(pluginDirPath, dirName, enabledMap) {
  if (enabledMap.has(dirName)) {
    return enabledMap.get(dirName);
  }
  const manifestPath = join(pluginDirPath, 'plugin.json');
  if (existsSync(manifestPath)) {
    try {
      const text = readFileSync(manifestPath, 'utf-8');
      if (/"disabled"\s*:\s*true/.test(text)) {
        return false;
      }
    } catch {
      // Ignore parse errors.
    }
  }
  return true;
}

/**
 * Parses YAML frontmatter (`name` and `description`) from a SKILL.md string.
 */
export function parseSkillFrontmatter(markdown, fallbackName = '') {
  const text = String(markdown || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: fallbackName, description: '' };
  }
  const yaml = match[1];
  const lines = yaml.split(/\r?\n/);
  const fields = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    let val = keyMatch[2].trim();

    if (val === '>-' || val === '>' || val === '|-' || val === '|') {
      const collected = [];
      const preserveNewlines = val.startsWith('|');
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (/^[A-Za-z0-9_-]+\s*:/.test(nextLine)) break;
        if (nextLine.trim() === '' || /^\s+/.test(nextLine)) {
          collected.push(nextLine.trim());
          i += 1;
        } else {
          break;
        }
      }
      val = collected
        .filter((l, idx) => l !== '' || preserveNewlines || idx > 0)
        .join(preserveNewlines ? '\n' : ' ')
        .trim();
    } else if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    fields[key] = val;
  }

  return {
    name: (fields.name || fallbackName || '').trim(),
    description: (fields.description || '').trim(),
  };
}

function collectSkillsFromDir(skillsRoot, sourceLabel, targetList, seenNames) {
  if (!existsSync(skillsRoot)) return;
  let entries = [];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsRoot, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const content = readFileSync(skillFile, 'utf-8');
      const { name, description } = parseSkillFrontmatter(content, entry.name);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      targetList.push({
        name,
        description,
        path: skillFile,
        dir: skillDir,
        source: sourceLabel,
      });
    } catch {
      // Skip unreadable SKILL.md.
    }
  }
}

function stripJsoncComments(raw) {
  return String(raw || '')
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? '' : m))
    .replace(/,\s*([\]}])/g, '$1');
}

function readMcpServersFromFile(filePath, pluginDir, targetList, seenNames) {
  if (!existsSync(filePath)) return;
  try {
    const parsed = JSON.parse(stripJsoncComments(readFileSync(filePath, 'utf-8')));
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object' || cfg.disabled === true) continue;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      targetList.push({
        name,
        command: typeof cfg.command === 'string' ? cfg.command : '',
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
        env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : '',
        url: typeof cfg.url === 'string' ? cfg.url : '',
        headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
        pluginDir: pluginDir || '',
      });
    }
  } catch {
    // Ignore invalid MCP config.
  }
}

function appendRuleFile(filePath, rulesList, seenPaths, state) {
  const abs = resolve(filePath);
  if (seenPaths.has(abs) || !existsSync(abs)) return;
  if (state.totalBytes >= MAX_TOTAL_RULES_BYTES) return;
  try {
    const raw = readFileSync(abs, 'utf-8').trim();
    if (!raw) return;
    if (/^---\r?\n[\s\S]*?\btrigger:\s*manual\b[\s\S]*?\r?\n---/i.test(raw)) {
      return;
    }
    seenPaths.add(abs);
    const clipped =
      raw.length > MAX_RULE_BYTES
        ? `${raw.slice(0, MAX_RULE_BYTES)}\n... [truncated]`
        : raw;
    state.totalBytes += Buffer.byteLength(clipped, 'utf-8');
    rulesList.push({ path: abs, content: clipped });
  } catch {
    // Ignore unreadable rule file.
  }
}

/**
 * Discovers Antigravity skills, rules, and MCP servers across workspace,
 * global config, enabled plugins, and built-in directories.
 */
export function discoverAntigravityEnvironment({ cwd = process.cwd() } = {}) {
  const resolvedCwd = resolve(cwd || process.cwd());
  const geminiConfigDir = getGeminiConfigDir();
  const appDataDir = getAppDataDir();
  const enabledPlugins = readDisabledPluginsMap();

  const skills = [];
  const seenSkills = new Set();

  // 1. Workspace skills
  collectSkillsFromDir(join(resolvedCwd, '.agents', 'skills'), 'workspace', skills, seenSkills);
  collectSkillsFromDir(join(resolvedCwd, '.agent', 'skills'), 'workspace', skills, seenSkills);

  // 2. Global user skills
  collectSkillsFromDir(join(geminiConfigDir, 'skills'), 'global', skills, seenSkills);

  // 3. Installed plugins (skills, rules, MCP servers)
  const pluginsDir = join(geminiConfigDir, 'plugins');
  const activePluginDirs = [];
  if (existsSync(pluginsDir)) {
    try {
      for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pDir = join(pluginsDir, entry.name);
        if (!isPluginEnabled(pDir, entry.name, enabledPlugins)) continue;
        activePluginDirs.push({ name: entry.name, dir: pDir });
        collectSkillsFromDir(join(pDir, 'skills'), `plugin:${entry.name}`, skills, seenSkills);
      }
    } catch {
      // Ignore unreadable plugins directory.
    }
  }

  // 4. Built-in skills
  collectSkillsFromDir(join(appDataDir, 'builtin', 'skills'), 'builtin', skills, seenSkills);

  // Rules
  const rules = [];
  const seenRulePaths = new Set();
  const ruleBudget = { totalBytes: 0 };
  appendRuleFile(join(resolvedCwd, 'GEMINI.md'), rules, seenRulePaths, ruleBudget);
  appendRuleFile(join(resolvedCwd, 'AGENTS.md'), rules, seenRulePaths, ruleBudget);
  const wsRulesDir = join(resolvedCwd, '.agents', 'rules');
  if (existsSync(wsRulesDir)) {
    try {
      for (const f of readdirSync(wsRulesDir)) {
        if (f.endsWith('.md')) appendRuleFile(join(wsRulesDir, f), rules, seenRulePaths, ruleBudget);
      }
    } catch {
      // Ignore.
    }
  }
  appendRuleFile(join(homedir(), '.gemini', 'GEMINI.md'), rules, seenRulePaths, ruleBudget);
  appendRuleFile(join(homedir(), '.gemini', 'AGENTS.md'), rules, seenRulePaths, ruleBudget);
  for (const p of activePluginDirs) {
    const pRulesDir = join(p.dir, 'rules');
    if (!existsSync(pRulesDir)) continue;
    try {
      for (const f of readdirSync(pRulesDir)) {
        if (f.endsWith('.md')) appendRuleFile(join(pRulesDir, f), rules, seenRulePaths, ruleBudget);
      }
    } catch {
      // Ignore.
    }
  }

  // MCP Servers
  const mcpServers = [];
  const seenMcpNames = new Set();
  readMcpServersFromFile(join(resolvedCwd, '.agents', 'mcp_config.json'), '', mcpServers, seenMcpNames);
  readMcpServersFromFile(join(geminiConfigDir, 'mcp_config.json'), '', mcpServers, seenMcpNames);
  for (const p of activePluginDirs) {
    readMcpServersFromFile(join(p.dir, 'mcp_config.json'), p.dir, mcpServers, seenMcpNames);
  }

  return {
    cwd: resolvedCwd,
    skills,
    rules,
    mcpServers,
  };
}

/**
 * Returns OpenAI function-calling schemas exposed to local models.
 */
export function getLocalModelToolSchemas({ allowWrite = true } = {}) {
  const readOnlyTools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read lines from a text file on disk. Paths can be absolute or relative to the workspace cwd.',
        parameters: {
          type: 'object',
          properties: {
            Path: { type: 'string', description: 'File path to read.' },
            StartLine: { type: 'integer', description: 'Optional 1-based start line.' },
            EndLine: { type: 'integer', description: 'Optional 1-based end line (inclusive).' },
          },
          required: ['Path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List files and subdirectories in a directory.',
        parameters: {
          type: 'object',
          properties: {
            Path: { type: 'string', description: 'Directory path (defaults to workspace cwd).' },
            Recursive: { type: 'boolean', description: 'If true, list recursively.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search file names and text contents recursively under a directory.',
        parameters: {
          type: 'object',
          properties: {
            Query: { type: 'string', description: 'Text or substring to search for.' },
            Path: { type: 'string', description: 'Root directory to search (defaults to cwd).' },
            FilePattern: { type: 'string', description: 'Optional filename substring or extension (e.g. ".mjs").' },
          },
          required: ['Query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_skills',
        description: 'List available Antigravity skills, optionally filtered by keyword.',
        parameters: {
          type: 'object',
          properties: {
            Filter: { type: 'string', description: 'Optional substring filter.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'activate_skill',
        description:
          'Read the full SKILL.md instructions and bundled helper file paths for an Antigravity skill.',
        parameters: {
          type: 'object',
          properties: {
            SkillName: { type: 'string', description: 'Exact skill name or folder name.' },
          },
          required: ['SkillName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_mcp_tools',
        description: 'List available tools from configured Antigravity MCP servers.',
        parameters: {
          type: 'object',
          properties: {
            ServerName: {
              type: 'string',
              description: 'Optional MCP server name. Omit to inspect all configured servers.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'call_mcp_tool',
        description: 'Execute a tool on a configured Antigravity stdio MCP server.',
        parameters: {
          type: 'object',
          properties: {
            ServerName: { type: 'string', description: 'MCP server name.' },
            ToolName: { type: 'string', description: 'Tool name exposed by that server.' },
            Arguments: { type: 'object', description: 'JSON arguments for the tool.' },
          },
          required: ['ServerName', 'ToolName'],
        },
      },
    },
  ];

  const writeTools = [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create, overwrite, or append a text file.',
        parameters: {
          type: 'object',
          properties: {
            Path: { type: 'string', description: 'Target file path.' },
            Content: { type: 'string', description: 'File contents to write.' },
            Overwrite: { type: 'boolean', description: 'Allow overwriting existing file (default true).' },
            Append: { type: 'boolean', description: 'Append to end of file (default false).' },
          },
          required: ['Path', 'Content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace an exact Target string with Replacement in an existing file.',
        parameters: {
          type: 'object',
          properties: {
            Path: { type: 'string', description: 'Target file path.' },
            Target: { type: 'string', description: 'Exact existing text to replace.' },
            Replacement: { type: 'string', description: 'Replacement text.' },
          },
          required: ['Path', 'Target', 'Replacement'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command in the workspace and capture stdout/stderr/exitCode.',
        parameters: {
          type: 'object',
          properties: {
            CommandLine: { type: 'string', description: 'Shell command to execute.' },
            Cwd: { type: 'string', description: 'Optional working directory (defaults to cwd).' },
            TimeoutMs: { type: 'integer', description: 'Timeout in ms (default 30000).' },
          },
          required: ['CommandLine'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description:
          'Execute a shell/bash command in the workspace and capture exitCode, stdout, and stderr (mini-swe-agent compatible alias of run_command).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
            cwd: { type: 'string', description: 'Optional working directory (defaults to cwd).' },
            timeoutMs: { type: 'integer', description: 'Timeout in ms (default 30000).' },
          },
          required: ['command'],
        },
      },
    },
  ];

  return allowWrite ? [...readOnlyTools, ...writeTools] : readOnlyTools;
}

function resolveTargetPath(rawPath, cwd) {
  const base = resolve(cwd || process.cwd());
  if (!rawPath || String(rawPath).trim() === '') return base;
  return resolve(base, String(rawPath).trim());
}

function listFilesRecursive(dirPath, rootBase, limit, results, skipDirs = SKIP_DIRS) {
  if (results.length >= limit) return;
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) break;
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const full = join(dirPath, entry.name);
    const rel = relative(rootBase, full).replace(/\\/g, '/') || entry.name;
    if (entry.isDirectory()) {
      results.push({ path: rel, type: 'dir' });
      listFilesRecursive(full, rootBase, limit, results, skipDirs);
    } else {
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        // Ignore.
      }
      results.push({ path: rel, type: 'file', size });
    }
  }
}

function runShellAsync(commandLine, cwd, timeoutMs = 30000) {
  return new Promise((resolveDone) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'powershell.exe' : 'sh';
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', commandLine]
      : ['-c', commandLine];

    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    }, Math.min(120000, Math.max(1000, Number(timeoutMs) || 30000)));

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CMD_OUTPUT_CHARS) {
        stdout += chunk.toString('utf-8');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CMD_OUTPUT_CHARS) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolveDone({ exitCode: 1, stdout: '', stderr: err.message, timedOut: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolveDone({
        exitCode: typeof code === 'number' ? code : timedOut ? 124 : 1,
        stdout: stdout.slice(0, MAX_CMD_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_CMD_OUTPUT_CHARS),
        timedOut,
      });
    });
  });
}

function encodeMcpMessage(msg) {
  return JSON.stringify(msg) + '\n';
}

function queryStdioMcpServer(server, calls, timeoutMs = 10000) {
  return new Promise((resolveDone, rejectDone) => {
    if (!server.command) {
      rejectDone(new Error(`MCP server "${server.name}" does not expose a stdio command.`));
      return;
    }

    const workDir = server.cwd || server.pluginDir || process.cwd();
    const env = {
      ...process.env,
      ...(server.pluginDir ? { PLUGIN_ROOT: server.pluginDir } : {}),
      ...(server.env || {}),
    };

    const child = spawn(server.command, server.args || [], {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Map();
    let buffer = Buffer.alloc(0);
    let stderrText = '';

    const cleanup = () => {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      rejectDone(new Error(`MCP server "${server.name}" timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const dispatch = (rawJson) => {
      let msg;
      try {
        msg = JSON.parse(rawJson);
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolver = pending.get(msg.id);
        pending.delete(msg.id);
        resolver(msg);
      }
    };

    child.stderr.on('data', (c) => {
      if (stderrText.length < 4000) stderrText += c.toString('utf-8');
    });

    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        const preview = buffer.toString('utf-8', 0, Math.min(buffer.length, 64));
        if (/^\s*Content-Length:/i.test(preview)) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          const altEnd = headerEnd >= 0 ? headerEnd : buffer.indexOf('\n\n');
          const sepLen = headerEnd >= 0 ? 4 : 2;
          if (altEnd < 0) break;
          const header = buffer.subarray(0, altEnd).toString('utf-8');
          const m = header.match(/Content-Length:\s*(\d+)/i);
          if (!m) {
            buffer = buffer.subarray(altEnd + sepLen);
            continue;
          }
          const len = Number.parseInt(m[1], 10);
          const start = altEnd + sepLen;
          if (buffer.length < start + len) break;
          const body = buffer.subarray(start, start + len).toString('utf-8');
          buffer = buffer.subarray(start + len);
          dispatch(body);
        } else {
          const nl = buffer.indexOf('\n');
          if (nl < 0) break;
          const line = buffer.subarray(0, nl).toString('utf-8').trim();
          buffer = buffer.subarray(nl + 1);
          if (line) dispatch(line);
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      rejectDone(new Error(`Failed to start MCP server "${server.name}": ${err.message}`));
    });

    let nextId = 1;
    const rpc = (method, params = {}) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', id, method, params }));
      });

    (async () => {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agy-local-agents', version: '0.2.0' },
      });
      child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }));

      const results = [];
      for (const call of calls) {
        results.push(await rpc(call.method, call.params));
      }
      clearTimeout(timer);
      cleanup();
      resolveDone(results);
    })().catch((err) => {
      clearTimeout(timer);
      cleanup();
      rejectDone(new Error(`${err.message}${stderrText ? ` (${stderrText.trim()})` : ''}`));
    });
  });
}

/**
 * Executes a single Antigravity tool call on behalf of a local model.
 */
export async function executeLocalModelTool(name, rawArgs = {}, context = {}) {
  const cwd = resolve(context.cwd || process.cwd());
  const allowWrite = context.allowWrite !== false;
  const env = context.env || discoverAntigravityEnvironment({ cwd });
  const args =
    typeof rawArgs === 'string'
      ? (() => {
          try {
            return JSON.parse(rawArgs);
          } catch {
            return {};
          }
        })()
      : rawArgs || {};

  switch (name) {
    case 'read_file': {
      const rawPath = args.Path ?? args.path;
      if (!rawPath) return { error: 'Path is required' };
      const target = resolveTargetPath(rawPath, cwd);
      if (!existsSync(target)) return { error: `File not found: ${rawPath}` };
      const content = readFileSync(target, 'utf-8');
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, Number(args.StartLine ?? args.startLine) || 1);
      const requestedEnd = Number(args.EndLine ?? args.endLine) || start + MAX_READ_LINES - 1;
      const end = Math.min(lines.length, Math.min(requestedEnd, start + MAX_READ_LINES - 1));

      const numbered = [];
      let byteCount = 0;
      let truncatedByBytes = false;
      for (let i = start; i <= end; i += 1) {
        const formatted = `${i}: ${lines[i - 1]}`;
        const bytes = Buffer.byteLength(formatted, 'utf-8') + 1;
        if (byteCount + bytes > MAX_READ_BYTES && numbered.length > 0) {
          truncatedByBytes = true;
          break;
        }
        numbered.push(formatted);
        byteCount += bytes;
      }
      return {
        path: target,
        totalLines: lines.length,
        startLine: start,
        endLine: start + numbered.length - 1,
        truncated: truncatedByBytes || end < lines.length,
        content: numbered.join('\n'),
      };
    }

    case 'write_file': {
      if (!allowWrite) return { error: 'Write tools are disabled in read-only mode.' };
      const rawPath = args.Path ?? args.path;
      if (!rawPath) return { error: 'Path is required' };
      const target = resolveTargetPath(rawPath, cwd);
      const overwrite = args.Overwrite !== false;
      const append = Boolean(args.Append);
      const text = String(args.Content ?? args.content ?? '');

      if (existsSync(target) && !overwrite && !append) {
        return { error: `File already exists and Overwrite is false: ${rawPath}` };
      }
      mkdirSync(dirname(target), { recursive: true });
      if (append && existsSync(target)) {
        const prev = readFileSync(target, 'utf-8');
        writeFileSync(target, prev + text, 'utf-8');
      } else {
        writeFileSync(target, text, 'utf-8');
      }
      return {
        ok: true,
        path: target,
        bytesWritten: Buffer.byteLength(text, 'utf-8'),
      };
    }

    case 'edit_file': {
      if (!allowWrite) return { error: 'Write tools are disabled in read-only mode.' };
      const rawPath = args.Path ?? args.path;
      const targetText = args.Target ?? args.target;
      const replacement = String(args.Replacement ?? args.replacement ?? '');
      if (!rawPath || typeof targetText !== 'string' || !targetText.length) {
        return { error: 'Path and non-empty Target are required' };
      }
      const targetPath = resolveTargetPath(rawPath, cwd);
      if (!existsSync(targetPath)) return { error: `File not found: ${rawPath}` };
      const current = readFileSync(targetPath, 'utf-8');
      if (!current.includes(targetText)) {
        return { error: `Target string not found in ${rawPath}` };
      }
      const parts = current.split(targetText);
      const replacements = parts.length - 1;
      writeFileSync(targetPath, parts.join(replacement), 'utf-8');
      return { ok: true, path: targetPath, replacements };
    }

    case 'list_dir': {
      const target = resolveTargetPath(args.Path ?? args.path ?? '.', cwd);
      if (!existsSync(target)) return { error: `Directory not found: ${target}` };
      const recursive = Boolean(args.Recursive ?? args.recursive);
      if (recursive) {
        const entries = [];
        listFilesRecursive(target, target, MAX_LIST_ENTRIES, entries);
        return { path: target, entries, truncated: entries.length >= MAX_LIST_ENTRIES };
      }
      const items = readdirSync(target, { withFileTypes: true })
        .slice(0, MAX_LIST_ENTRIES)
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
        }));
      return { path: target, entries: items };
    }

    case 'search_files': {
      const query = String(args.Query ?? args.query ?? '').trim();
      if (!query) return { error: 'Query is required' };
      const rootDir = resolveTargetPath(args.Path ?? args.path ?? '.', cwd);
      if (!existsSync(rootDir)) return { error: `Directory not found: ${rootDir}` };
      const filePattern = String(args.FilePattern ?? args.filePattern ?? '').trim().toLowerCase();
      const patternRegex = filePattern
        ? new RegExp(
            '^' +
              filePattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.') +
              '$',
            'i'
          )
        : null;

      const allEntries = [];
      listFilesRecursive(rootDir, rootDir, 1500, allEntries);
      const queryLower = query.toLowerCase();
      const matches = [];

      for (const item of allEntries) {
        if (item.type !== 'file') continue;
        if (filePattern) {
          const base = basename(item.path).toLowerCase();
          const matchesGlob = patternRegex?.test(base) || patternRegex?.test(item.path);
          const matchesSubstr = item.path.toLowerCase().includes(filePattern);
          if (!matchesGlob && !matchesSubstr) continue;
        }
        if (item.size > MAX_SEARCH_FILE_BYTES) continue;
        const full = join(rootDir, item.path);
        let text;
        try {
          text = readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            matches.push(`${item.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= MAX_SEARCH_MATCHES) {
              return { root: rootDir, matches, truncated: true };
            }
          }
        }
      }
      return { root: rootDir, matches, truncated: false };
    }

    case 'bash':
    case 'run_command': {
      if (!allowWrite) return { error: `${name} is disabled in read-only mode.` };
      const commandLine = String(
        args.CommandLine ?? args.commandLine ?? args.command ?? args.cmd ?? ''
      ).trim();
      if (!commandLine) {
        return { error: name === 'bash' ? 'command is required' : 'CommandLine is required' };
      }
      const targetCwd = resolveTargetPath(args.Cwd ?? args.cwd ?? '.', cwd);
      const timeoutMs = Number(args.TimeoutMs ?? args.timeoutMs) || 30000;
      return await runShellAsync(commandLine, targetCwd, timeoutMs);
    }

    case 'list_skills': {
      const filter = String(args.Filter ?? args.filter ?? '').trim().toLowerCase();
      const matched = env.skills
        .filter((s) => {
          if (!filter) return true;
          return (
            s.name.toLowerCase().includes(filter) ||
            s.description.toLowerCase().includes(filter)
          );
        })
        .map((s) => ({
          name: s.name,
          description: s.description,
          source: s.source,
          path: s.path,
        }));
      return { total: matched.length, skills: matched };
    }

    case 'activate_skill': {
      const targetName = String(args.SkillName ?? args.skillName ?? args.name ?? '').trim();
      if (!targetName) return { error: 'SkillName is required' };
      const lower = targetName.toLowerCase();
      const skill =
        env.skills.find((s) => s.name.toLowerCase() === lower) ||
        env.skills.find((s) => basename(s.dir).toLowerCase() === lower) ||
        env.skills.find((s) => s.name.toLowerCase().includes(lower));
      if (!skill) {
        return {
          error: `Skill "${targetName}" not found. Call list_skills to inspect available skills.`,
        };
      }
      const content = readFileSync(skill.path, 'utf-8');
      const bundledFiles = [];
      for (const sub of ['scripts', 'references', 'examples', 'resources']) {
        const subDir = join(skill.dir, sub);
        if (!existsSync(subDir)) continue;
        try {
          for (const f of readdirSync(subDir)) {
            bundledFiles.push(join(subDir, f).replace(/\\/g, '/'));
          }
        } catch {
          // Ignore.
        }
      }
      return {
        name: skill.name,
        source: skill.source,
        path: skill.path.replace(/\\/g, '/'),
        skillDir: skill.dir.replace(/\\/g, '/'),
        bundledFiles,
        content,
      };
    }

    case 'list_mcp_tools': {
      const targetServer = String(args.ServerName ?? args.serverName ?? '').trim();
      const targets = targetServer
        ? env.mcpServers.filter((s) => s.name === targetServer)
        : env.mcpServers;
      if (targetServer && targets.length === 0) {
        return { error: `MCP server "${targetServer}" not found.` };
      }

      const servers = [];
      for (const srv of targets) {
        if (!srv.command) {
          servers.push({
            name: srv.name,
            transport: srv.url ? 'http' : 'unknown',
            url: srv.url || undefined,
            note: 'Remote HTTP MCP servers are not invoked directly by stdio bridge.',
          });
          continue;
        }
        try {
          const [res] = await queryStdioMcpServer(srv, [{ method: 'tools/list', params: {} }]);
          const tools = Array.isArray(res?.result?.tools) ? res.result.tools : [];
          servers.push({
            name: srv.name,
            transport: 'stdio',
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.inputSchema || {},
            })),
          });
        } catch (err) {
          servers.push({ name: srv.name, transport: 'stdio', error: err.message });
        }
      }
      return { servers };
    }

    case 'call_mcp_tool': {
      const serverName = String(args.ServerName ?? args.serverName ?? '').trim();
      const toolName = String(args.ToolName ?? args.toolName ?? '').trim();
      const toolArgs = args.Arguments ?? args.arguments ?? {};
      if (!serverName || !toolName) {
        return { error: 'ServerName and ToolName are required' };
      }
      const srv = env.mcpServers.find((s) => s.name === serverName);
      if (!srv) return { error: `MCP server "${serverName}" not found.` };
      const [res] = await queryStdioMcpServer(
        srv,
        [{ method: 'tools/call', params: { name: toolName, arguments: toolArgs } }],
        30000
      );
      if (res?.error) {
        return { error: res.error.message || JSON.stringify(res.error) };
      }
      return res?.result || res;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Builds the Antigravity system prompt with tools, skills, MCP servers, and rules.
 */
export function buildAgenticSystemPrompt({
  cwd = process.cwd(),
  env = discoverAntigravityEnvironment({ cwd }),
  systemPrompt = '',
  allowWrite = true,
} = {}) {
  const skillsLines = env.skills
    .map((s) => {
      const desc = s.description ? s.description.slice(0, 180) : '';
      return `- ${s.name}: ${desc}${s.description.length > 180 ? '...' : ''}`;
    })
    .join('\n');

  const mcpLines = env.mcpServers
    .map((s) => `- ${s.name} (${s.command ? `${s.command} ${s.args.join(' ')}`.trim() : s.url || 'configured'})`)
    .join('\n');

  const rulesBlock = env.rules
    .map((r) => `Rule (${basename(r.path)}):\n${r.content}`)
    .join('\n\n');

  const sections = [
    `You are an AI assistant running inside Antigravity with access to workspace tools, Antigravity skills, rules, and MCP servers.`,
    `Workspace cwd: ${env.cwd}\nOS: ${process.platform}\nWrite/Command access: ${allowWrite ? 'enabled' : 'read-only'}`,
    [
      '## Tools & Progressive Skill Usage',
      '- Use the provided function tools (`read_file`, `list_dir`, `search_files`, `list_skills`, `activate_skill`, `list_mcp_tools`, `call_mcp_tool`' +
        (allowWrite ? ', `write_file`, `edit_file`, `run_command`, `bash`' : '') +
        ') whenever inspecting files, running commands, or verifying facts. Do not invent file contents or command output.',
      '- If a task matches an available skill below, call `activate_skill` with its exact `SkillName` before following its instructions.',
      '- If your model endpoint does not support native `tool_calls`, emit a JSON tool call wrapped in `<tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>`.',
    ].join('\n'),
  ];

  if (skillsLines) {
    sections.push(`<skills>\n${skillsLines}\n</skills>`);
  }
  if (mcpLines) {
    sections.push(`<mcp_servers>\n${mcpLines}\n</mcp_servers>`);
  }
  if (rulesBlock) {
    sections.push(`<rules>\n${rulesBlock}\n</rules>`);
  }
  if (systemPrompt) {
    sections.push(String(systemPrompt).trim());
  }

  return sections.join('\n\n');
}

export const KNOWN_LOCAL_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'search_files',
  'run_command',
  'bash',
  'list_skills',
  'activate_skill',
  'list_mcp_tools',
  'call_mcp_tool',
]);

/**
 * Extracts fallback `<tool_call>...</tool_call>` or fenced `tool_call` JSON blocks
 * when a model emits tool calls in plain text instead of OpenAI `tool_calls`.
 */
export function parseTextToolCalls(content) {
  const text = String(content || '');
  if (!text) return [];
  const calls = [];

  const patterns = [
    { regex: /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, strictJsonFence: false },
    { regex: /```tool_call\s*\r?\n([\s\S]*?)\r?\n```/gi, strictJsonFence: false },
    { regex: /```json\s*\r?\n([\s\S]*?)\r?\n```/gi, strictJsonFence: true },
  ];

  for (const { regex, strictJsonFence } of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const rawJson = m[1].trim();
      if (!rawJson.startsWith('{') && !rawJson.startsWith('[')) continue;
      try {
        const parsed = JSON.parse(rawJson);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || typeof item.name !== 'string' || !item.name.trim()) continue;
          const toolName = item.name.trim();
          if (
            strictJsonFence &&
            (!KNOWN_LOCAL_TOOL_NAMES.has(toolName) || item.arguments === undefined)
          ) {
            continue;
          }
          calls.push({
            id: `text_call_${calls.length + 1}`,
            name: toolName,
            arguments:
              item.arguments && typeof item.arguments === 'object'
                ? item.arguments
                : typeof item.arguments === 'string'
                  ? (() => {
                      try {
                        return JSON.parse(item.arguments);
                      } catch {
                        return {};
                      }
                    })()
                  : {},
          });
        }
      } catch {
        // Ignore non-tool JSON blocks.
      }
    }
    if (calls.length > 0) break;
  }

  return calls;
}
