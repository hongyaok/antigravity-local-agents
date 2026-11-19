/**
 * Builds self-contained `mcp/stream-app.html` by bundling `mcp/stream-app-src/main.js`
 * with esbuild from a temporary node_modules directory (keeps plugin root dependency-free).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entryJs = join(__dirname, 'stream-app-src', 'main.js');
const outHtml = join(__dirname, 'stream-app.html');
const tempBuildDir = join(tmpdir(), 'agy-local-agents-ui-build');
const bundledJsPath = join(tempBuildDir, 'bundle.js');
const nodeModulesPath = join(tempBuildDir, 'node_modules');
const esbuildEntry = join(nodeModulesPath, 'esbuild', 'lib', 'main.js');

if (!existsSync(esbuildEntry)) {
  mkdirSync(tempBuildDir, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['init', '-y'], {
    cwd: tempBuildDir,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '@modelcontextprotocol/ext-apps', 'esbuild'],
    {
      cwd: tempBuildDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    }
  );
}

const esbuild = await import(pathToFileURL(esbuildEntry).href);
await esbuild.build({
  entryPoints: [entryJs],
  bundle: true,
  format: 'iife',
  minify: true,
  nodePaths: [nodeModulesPath],
  outfile: bundledJsPath,
});
await esbuild.stop?.();

const bundledJs = readFileSync(bundledJsPath, 'utf-8').replace(/<\/script>/gi, '<\\/script>');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local Agent Stream</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;background:transparent;color:var(--color-text-primary,#e5e7eb);font-family:var(--font-sans,system-ui,-apple-system,sans-serif);font-size:12px;line-height:1.45}
  .stream-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:8px;background:var(--color-background-secondary,rgba(24,24,30,.78));border:1px solid var(--color-border-primary,rgba(255,255,255,.12))}
  .tabs{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:6px;border-bottom:1px solid var(--color-border-primary,rgba(255,255,255,.08))}
  .tab{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:6px;border:1px solid var(--color-border-primary,rgba(255,255,255,.12));background:transparent;color:var(--color-text-secondary,#9ca3af);font:inherit;font-size:11px;cursor:pointer}
  .tab.active{background:var(--color-background-primary,rgba(255,255,255,.08));color:var(--color-text-primary,#f9fafb);border-color:var(--color-ring-primary,#60a5fa)}
  .head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .head-left,.head-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
  .dot{width:7px;height:7px;border-radius:50%;flex:none}
  .dot.live{background:#4ade80;box-shadow:0 0 0 2px rgba(74,222,128,.25);animation:pulse 1.2s ease-in-out infinite}
  .dot.done{background:#38bdf8}
  .dot.err{background:#f87171}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .status-txt{font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .model-txt{font-weight:600;color:var(--color-text-primary,#f3f4f6);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chip{padding:1px 6px;border-radius:4px;font-size:11px;font-family:var(--font-mono,ui-monospace,monospace);background:var(--color-background-primary,rgba(0,0,0,.25));border:1px solid var(--color-border-primary,rgba(255,255,255,.1));color:var(--color-text-secondary,#d1d5db)}
  .meta-txt{font-size:11px;font-family:var(--font-mono,ui-monospace,monospace);color:var(--color-text-secondary,#9ca3af)}
  .task-line{font-size:11px;color:var(--color-text-secondary,#9ca3af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tools-strip{display:flex;flex-wrap:wrap;gap:5px}
  .tool-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;font-size:11px;font-family:var(--font-mono,ui-monospace,monospace);background:var(--color-background-primary,rgba(0,0,0,.25));border:1px solid var(--color-border-primary,rgba(255,255,255,.1));color:var(--color-text-secondary,#d1d5db)}
  .tool-pill.is-ok{border-color:rgba(74,222,128,.35);color:#4ade80}
  .tool-pill.is-err{border-color:rgba(248,113,113,.35);color:#f87171}
  .tool-pill.is-run{border-color:rgba(56,189,248,.4);color:#38bdf8}
  details.block{border:1px solid var(--color-border-primary,rgba(255,255,255,.08));border-radius:6px;padding:6px 8px;background:var(--color-background-primary,rgba(0,0,0,.2))}
  details.block summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--color-text-secondary,#9ca3af);user-select:none}
  .stream-pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;line-height:1.45;max-height:140px;overflow-y:auto}
  .thinking-pre{color:var(--color-text-secondary,#9ca3af)}
  .response-box{border-top:1px solid var(--color-border-primary,rgba(255,255,255,.08));padding-top:6px}
  .response-pre{margin:0;max-height:180px;color:var(--color-text-primary,#f9fafb)}
  .waiting-line{font-size:11px;color:var(--color-text-secondary,#9ca3af);font-style:italic}
  .error-box{padding:6px 8px;border-radius:6px;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#f87171;font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;white-space:pre-wrap}
</style>
</head>
<body>
<div id="app"></div>
<script>${bundledJs}</script>
</body>
</html>
`;

writeFileSync(outHtml, html, 'utf-8');
try {
  rmSync(tempBuildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch {
  // Ignore transient Windows handle release delay.
}
console.log(`Built ${outHtml} (${Buffer.byteLength(html, 'utf-8')} bytes)`);
