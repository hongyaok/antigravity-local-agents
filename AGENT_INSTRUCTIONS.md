# Agent Installation Instructions — `agy-local-agents`

> **For Human Users:**
> Copy the prompt in the box below and paste it directly into your **Google Antigravity** chat. Your agent will automatically download, install, verify, and open **Antigravity Local Agents** on your device (Windows, macOS, or Linux).

### Copy-Paste Prompt for Your Antigravity Agent

```text
Please install the agy-local-agents plugin from https://github.com/hongyaok/agy-local-agents.git by reading and following https://raw.githubusercontent.com/hongyaok/agy-local-agents/main/AGENT_INSTRUCTIONS.md
```

---

## Instructions for the Antigravity Agent

When a user asks you to install, update, or set up **`agy-local-agents`** (`https://github.com/hongyaok/agy-local-agents.git`), execute the following steps autonomously using your `run_command` tool.

### Step 1: Check Prerequisites

Verify that `git` and `node` (Node.js 18+ recommended) are available in the user's environment:

```bash
git --version
node --version
```

### Step 2: Clone or Update the Plugin into the Global Antigravity Plugins Directory

Antigravity loads user plugins from `~/.gemini/config/plugins/<plugin-name>`. Install **`agy-local-agents`** into that exact directory:

#### On Windows (PowerShell)

```powershell
$pluginsDir = Join-Path $HOME ".gemini\config\plugins"
$targetDir  = Join-Path $pluginsDir "agy-local-agents"
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

if (Test-Path (Join-Path $targetDir ".git")) {
  git -C $targetDir pull --ff-only
} elseif (Test-Path $targetDir) {
  Write-Host "Directory $targetDir already exists. Backing up and cloning fresh..."
  Move-Item $targetDir "$targetDir.backup.$(Get-Date -Format 'yyyyMMddHHmmss')"
  git clone https://github.com/hongyaok/agy-local-agents.git $targetDir
} else {
  git clone https://github.com/hongyaok/agy-local-agents.git $targetDir
}
```

#### On macOS / Linux (Bash / Zsh)

```bash
PLUGINS_DIR="$HOME/.gemini/config/plugins"
TARGET_DIR="$PLUGINS_DIR/agy-local-agents"
mkdir -p "$PLUGINS_DIR"

if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" pull --ff-only
elif [ -d "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "${TARGET_DIR}.backup.$(date +%Y%m%d%H%M%S)"
  git clone https://github.com/hongyaok/agy-local-agents.git "$TARGET_DIR"
else
  git clone https://github.com/hongyaok/agy-local-agents.git "$TARGET_DIR"
fi
```

### Step 3: Initialize Core Agent Files & Run Smoke Verification

Run the built-in zero-dependency smoke test suite and sync the default agent markdown files (`orchestrator-to-local.md`, `local-model-chat.md`, `local-model-worker.md`) for the current machine's paths:

#### On Windows (PowerShell)

```powershell
$targetDir = Join-Path $HOME ".gemini\config\plugins\agy-local-agents"
Push-Location $targetDir
node --test tests/smoke.test.mjs
node skills/local-models/scripts/local-model.mjs list
Pop-Location
```

#### On macOS / Linux (Bash / Zsh)

```bash
cd "$HOME/.gemini/config/plugins/agy-local-agents"
node --test tests/smoke.test.mjs
node skills/local-models/scripts/local-model.mjs list
```

### Step 4: (Optional) Auto-Discover Running Local Model Servers

If the user already has a local OpenAI-compatible server running (such as **Ollama** on `:11434`, **LM Studio** on `:1234`, **vLLM** on `:8000`, or a custom port they mentioned), probe and add models automatically:

```bash
# Example: Discover models from Ollama (http://localhost:11434/v1)
node "$HOME/.gemini/config/plugins/agy-local-agents/skills/local-models/scripts/local-model.mjs" discover --preset ollama

# Or add all models from a specific OpenAI-compatible URL:
node "$HOME/.gemini/config/plugins/agy-local-agents/skills/local-models/scripts/local-model.mjs" add --url http://localhost:11434/v1 --all --set-default
```

### Step 5: Present One-Click UI Links to the User

Once Steps 1–3 succeed, report completion to the user and include these exact clickable Antigravity links in your response so they can enable or open the plugin panels with a single click:

1. **Enable / Manage Plugin in Customizations:**
   `[Antigravity Local Agents](customization://agy-local-agents)`
2. **Open Local Agents Management Sidecar (Models, Harness & Provider Discovery):**
   `[Local Agents](sidecar://agy-local-agents/agents/)`
3. **Open Local Subagents Live Monitor Sidecar:**
   `[Local Subagents](sidecar://agy-local-agents/agents/monitor.html)`

> **Note for the Agent:** Never hand-edit `~/.gemini/config/config.json` or call restricted state-mutation RPCs from `run_command`. Providing the `[Antigravity Local Agents](customization://agy-local-agents)` and `sidecar://` links above allows the user to toggle and open the plugin live without restarting Antigravity.
