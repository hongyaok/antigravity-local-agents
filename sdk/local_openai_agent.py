"""Run any added OpenAI-compatible model via Google Antigravity SDK.

Follows https://antigravity.google/docs/sdk/local-models/ using
LocalOpenAIAgentConfig(model=..., base_url=...).lightweight().

Reads your added models directly from sidecars/agents/cache/config.json, and
automatically routes API-key-protected endpoints through the running sidecar
proxy (sidecars/agents/cache/runtime.json) when present.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PLUGIN_ROOT / "sidecars" / "agents" / "cache" / "config.json"
RUNTIME_PATH = PLUGIN_ROOT / "sidecars" / "agents" / "cache" / "runtime.json"


def load_added_model(target: str | None = None) -> dict:
  if not CONFIG_PATH.exists():
    raise FileNotFoundError(
        f"No agy-local-agents config found at {CONFIG_PATH}. Add a model in the sidecar UI first."
    )
  data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
  models = [m for m in data.get("models", []) if m.get("enabled", True)]
  if not models:
    raise RuntimeError("No enabled models found in agy-local-agents config.")

  if target:
    for m in models:
      if target in (m.get("id"), m.get("modelId"), m.get("displayName")):
        return m
    raise KeyError(f"Model '{target}' not found among added models.")

  for m in models:
    if m.get("isDefault"):
      return m
  return models[0]


def resolve_effective_base_url(model_entry: dict) -> str:
  if model_entry.get("apiKey") and RUNTIME_PATH.exists():
    runtime = json.loads(RUNTIME_PATH.read_text(encoding="utf-8"))
    if runtime.get("proxyBaseUrl"):
      return runtime["proxyBaseUrl"]
  return model_entry["baseUrl"]


async def run_agent(model_ref: str | None, prompt: str, dry_run: bool) -> int:
  entry = load_added_model(model_ref)
  base_url = resolve_effective_base_url(entry)
  model_id = entry["modelId"]

  print("=" * 64)
  print("Antigravity Local Agents — LocalOpenAIAgentConfig Runner")
  print("=" * 64)
  print(f"  Model ID:   {model_id}")
  print(f"  Base URL:   {base_url}")
  print(f"  Lightweight:{entry.get('lightweight', True)}")
  print("=" * 64)

  if dry_run:
    print("[Dry Run] Resolved added model cleanly.")
    return 0

  from google.antigravity import Agent, LocalOpenAIAgentConfig  # pylint: disable=import-outside-toplevel

  config = LocalOpenAIAgentConfig(
      model=model_id,
      base_url=base_url,
  )
  if entry.get("lightweight", True):
    config = config.lightweight()

  async with Agent(config=config) as agent:
    response = await agent.chat(prompt)
    async for token in response:
      print(token, end="", flush=True)
    print()
  return 0


def main() -> int:
  parser = argparse.ArgumentParser(
      description="Run an Antigravity SDK agent using a model added via agy-local-agents."
  )
  parser.add_argument("--model", help="Added model ID, display name, or internal id (defaults to default model).")
  parser.add_argument(
      "--prompt",
      default="Summarize the current workspace and check if tests are present.",
      help="Prompt to send to the agent.",
  )
  parser.add_argument("--dry-run", action="store_true", help="Print resolved config without running inference.")
  args = parser.parse_args()
  return asyncio.run(run_agent(args.model, args.prompt, args.dry_run))


if __name__ == "__main__":
  sys.exit(main())
