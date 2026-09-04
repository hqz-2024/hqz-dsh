# Agent Note: Photoshop CS6 automation skill

Status: implemented

English | [中文](2026-08-19-photoshop-cs6-automation-skill.zh.md)

## Problem

The user wants the agent to operate their desktop Photoshop CS6 (13.0, 64-bit, installed at `D:\Program Files\photoshop\Adobe Photoshop CS6 (64 Bit)`) for single-image editing, design generation, batch processing, and PSD manipulation. CS6 predates UXP and has no HTTP surface; the agent previously had no path to drive it. UI automation would be fragile, and the deployment's model cannot read images (see the [minimal read-image tool](2026-08-10-minimal-read-image-tool.md)), so the channel must return structured data and visual output must be verifiable without vision.

## Decision

Ship a repo-level skill, [`.agents/skills/photoshop-cs6/`](../../../skills/photoshop-cs6/SKILL.md), that drives the already-registered COM server (`Photoshop.Application` → `Photoshop.exe /Automation`) with an ExtendScript engine:

- **`ps6.ps1`** — PowerShell 5.1+ CLI, the only entry point. Subcommands `status` `selftest` `doc` `save-as` `export` `layer` `text` `resize` `canvas` `adjust` `filter` `selection` `flatten` `batch` `eval` `run` `quit`; every invocation prints exactly one JSON object, failures print `{ok:false,error,hint}` and exit 1, and each COM call runs under a `Start-Job`/`Wait-Job` timeout (default 90 s, `--timeout`).
- **`jsx/lib/helpers.jsx`** — CS6 ExtendScript (ES3) has no built-in JSON, so this file supplies a depth-capped `JSON.stringify`, an UTF-8 result writer, and path utilities.
- **`jsx/engine.jsx`** — pure-ASCII operation engine. Per invocation, `ps6.ps1` writes a temporary UTF-8-no-BOM driver that `#include`s helpers and engine, embeds the request as a JS object literal, and calls `ps6Execute(req, resultPath)`; the engine writes the payload to a temp `result.json` that the CLI reads and then cleans up. Each execution sets ruler/type units to pixels and `displayDialogs = NO`, restores the prior preferences afterwards, and catches every op error into the payload.
- **`SKILL.md`** (Chinese) — command table, task recipes (batch, watermark, poster, PSD text edits), an ExtendScript snippet library, and safety rules.

`eval` (one line of ExtendScript) and `run` (a self-contained `.jsx`) are deliberate escape hatches: any capability the v1 op set misses is reachable without adding commands.

The skill-filesystem provider auto-discovers `.agents/skills/*` (source `project-agents`, rank 200) and hot-refreshes the catalog on host mutation ([skill catalog hot refresh](2026-07-27-skill-catalog-hot-refresh.md)), so the skill became visible in the running session with no composition edit, rebuild, or restart — persistent source, immediate effect.

### Verification without vision

`selftest` runs the whole channel (new document → Chinese text layer → PNG export) and checks the byte-level artifact. Visual output is verified programmatically with `System.Drawing` pixel sampling: canvas size, background color, and per-color text pixel counts. Both ran green on this machine: a 800×600 poster with three text layers (white/orange/gray-blue pixels all present), a watermarked JPG export, and a 3-file batch resize to 400×300.

### Safety rules

`quit` refuses while any open document is unsaved and otherwise requires `--force`; `doc close` defaults to no-save; `batch` writes to a separate output directory; `eval`/`run` are restricted by SKILL.md to Photoshop-internal operations. The skill never auto-quits an instance the user is using.

## Alternatives considered

**A Python Click harness with pywin32/comtypes (the cli-anything standard).** Rejected: `pywin32` is not installed and installing it needs network access, while PowerShell COM had already proven out in-session; the same ExtendScript DOM is reachable through `eval` regardless of driver language.

**Pure ExtendScript via the ExtendScript Toolkit `-run` CLI.** Rejected: ESTK CS6 command-line automation is known to be flaky, and it offers no structured output channel back to the agent.

**Windows UI Automation.** Rejected: coordinate- and tree-based clicking against a layout-heavy desktop app is fragile and unmaintainable.

**A native `packages/` tool package in the harness.** Rejected: that binds the harness build to one desktop application on one machine. Skill assets under `.agents/skills/` are the right plane — zero build coupling, hot-loaded, and still repo-persistent per the user's "persistent source upgrade" request.

## Testing

`ps6.ps1 selftest` is the channel-level self-check (COM attach, UTF-8 round trip, text, PNG export). The three end-to-end demos (poster, watermark, batch) were verified with pixel sampling. `pnpm run verify-skill-invocation-metadata` and the Agent Note gates (`verify-agent-note-format`, `verify-agent-note-classification`, `verify-translation-pairing`) pass.

## Consequences

- Single-machine scope: Windows with CS6 at the known path and `Photoshop.Application` registered. Moving machines re-runs `selftest` and updates SKILL.md.
- Each command pays a job-process spawn (~1–2 s) plus COM attach; `batch` is serial per file.
- Document, active-layer, and selection state persists inside the Photoshop instance across CLI calls — multi-step edits are command sequences, not single calls.
- The ExtendScript JSON serializer is depth-capped and skips functions; DOM objects serialize as `{}`, so `eval` results must be plain JS values (SKILL.md shows the wrapper pattern).
- `run` does not support `#include`; `resize` does not preserve aspect ratio; filters and adjustments are a curated subset — all bypassable via `eval`.
- `ps6.ps1` must keep its UTF-8 BOM (Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI); `engine.jsx` must stay pure ASCII; the driver is UTF-8 without BOM.
- No AI image generation: design-generation assets come from the user or from Photoshop-native drawing.
