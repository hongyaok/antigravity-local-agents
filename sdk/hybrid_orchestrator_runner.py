"""Hybrid Cloud Architect + Added OpenAI-Compatible Builder/Critic Orchestrator.

Adapts the google-gemma/cookbook/apps/antigravity-hybrid-orchestrator pattern
to run with any OpenAI-compatible model added via agy-local-agents and
LocalOpenAIAgentConfig.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
from pathlib import Path
import random
import sys

from local_openai_agent import load_added_model, resolve_effective_base_url


def extract_public_skeleton(file_path: Path) -> str:
  """Extracts imports, global names, and def/class signatures (0 body bytes)."""
  source = file_path.read_text(encoding="utf-8")
  tree = ast.parse(source, filename=str(file_path))
  imports: list[str] = []
  globals_list: list[str] = []
  defs: list[str] = []

  for node in tree.body:
    if isinstance(node, ast.Import):
      imports.extend(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
      mod = node.module or ""
      names = ", ".join(alias.name for alias in node.names)
      imports.append(f"from {mod} import {names}")
    elif isinstance(node, ast.Assign):
      for t in node.targets:
        if isinstance(t, ast.Name):
          globals_list.append(t.id)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
      args = [a.arg for a in node.args.args]
      defs.append(f"def {node.name}({', '.join(args)})")
    elif isinstance(node, ast.ClassDef):
      defs.append(f"class {node.name}")

  return (
      f"{file_path.name}: imports=[{', '.join(imports)}] "
      f"globals=[{', '.join(globals_list)}] defs=[{'; '.join(defs)}]"
  )


async def run_hybrid(file_path: Path, task: str, model_ref: str | None, dry_run: bool) -> int:
  entry = load_added_model(model_ref)
  base_url = resolve_effective_base_url(entry)
  model_id = entry["modelId"]
  skeleton = extract_public_skeleton(file_path)

  print(f"[1/2] Public AST Skeleton (0 body bytes sent to Cloud Architect):")
  print(f"      {skeleton}")
  print(f"[2/2] Target Builder/Critic Model: {model_id} @ {base_url}")

  if dry_run:
    return 0

  from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig, LocalOpenAIAgentConfig  # pylint: disable=import-outside-toplevel

  architect_cfg = LocalAgentConfig(
      system_instructions=(
          "You are a Cloud Chief Architect. Given an AST skeleton and task, "
          "return JSON with keys: role, strategy, invariant."
      ),
      capabilities=CapabilitiesConfig(enabled_tools=[]),
  )

  async with Agent(config=architect_cfg) as architect:
    blueprint_raw = await (
        await architect.chat(f"Task: {task}\nSkeleton: {skeleton}")
    ).text()

  worker_cfg = LocalOpenAIAgentConfig(
      model=model_id,
      base_url=base_url,
      system_instructions="You are a terse senior engineer. Output only Python code.",
      capabilities=CapabilitiesConfig(enabled_tools=[]),
  ).lightweight()

  source_code = file_path.read_text(encoding="utf-8")
  builders = {
      "minimal": "Make the smallest possible edit preserving all public APIs.",
      "defensive": "Harden input validation and error handling while preserving all public APIs.",
  }

  candidates: list[tuple[str, str]] = []
  async with Agent(config=worker_cfg) as worker:
    for name, instruction in builders.items():
      worker.conversation.clear_history()
      prompt = (
          f"{instruction}\n\nBlueprint:\n{blueprint_raw}\n\n"
          f"File {file_path.name}:\n```python\n{source_code}\n```"
      )
      reply = await (await worker.chat(prompt)).text()
      candidates.append((name, reply))
      print(f"  > Builder ({name}) produced {len(reply.splitlines())} lines")

    random.shuffle(candidates)
    worker.conversation.clear_history()
    verdict = await (
        await worker.chat(
            f"Judge Candidate 1 vs Candidate 2 for {file_path.name}:\n"
            f"Blueprint: {blueprint_raw}\n\n"
            f"Candidate 1:\n{candidates[0][1]}\n\n"
            f"Candidate 2:\n{candidates[1][1]}\n\n"
            "Reply with '1' or '2', then a dash, then under 12 words."
        )
    ).text()
    print(f"  = Blind Critic verdict: {verdict.strip()}")

  return 0


def main() -> int:
  parser = argparse.ArgumentParser(description="Hybrid Orchestrator using agy-local-agents")
  parser.add_argument("--file", required=True, help="Target Python file")
  parser.add_argument("--task", default="Fix security and concurrency defects.", help="Audit/remediation goal")
  parser.add_argument("--model", help="Added model id or modelId")
  parser.add_argument("--dry-run", action="store_true", help="Print AST skeleton and resolved model only")
  args = parser.parse_args()
  return asyncio.run(run_hybrid(Path(args.file), args.task, args.model, args.dry_run))


if __name__ == "__main__":
  sys.exit(main())
