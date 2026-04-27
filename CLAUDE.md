# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a ChatLuna dependency plugin for `koishi-plugin-chatluna-livingmemory`.

It is currently transitioning from a minimal Koishi scaffold into a ChatLuna-native living-memory plugin.

Important project direction:
- The target behavior is inspired by `C:\Users\31899\Desktop\test\astrbot_plugin_livingmemory`, but do **not** copy AstrBot host-specific features.
- Ignore ChatLuna's existing built-in long-memory plugin as a product reference; this project has its own MVP design.
- When implementing ChatLuna integration, consult the external ChatLuna codebase and docs under:
  - `C:\Users\31899\Desktop\test\chatluna`
  - `C:\Users\31899\Desktop\test\chatluna-doc`
- Also consult Koishi docs under:
  - `C:\Users\31899\Desktop\test\koishi-docs`
- Do not infer ChatLuna or Koishi APIs from memory when the reference code/docs above are available.

## Current implementation status

The plugin has a working MVP structure (~1650 LOC across 10 files):

- `src/index.ts` — Plugin entrypoint, config schema, service/plugin wiring
- `src/types.ts` — Domain types: `MemoryEntry`, `MemorySnapshot`, `MemoryJob`, config, DB table declarations
- `src/query.ts` — Paginated query types for WebUI list endpoints
- `src/service/memory.ts` — `ChatLunaLivingMemoryService` (Koishi Service): orchestrates recall, extraction, snapshot lifecycle
- `src/service/repository.ts` — SQLite persistence via Koishi ORM (`memory_entry`, `memory_snapshot`, `memory_job` tables)
- `src/service/extractor.ts` — LLM-driven memory extraction from dialogue rounds with JSON schema validation
- `src/service/retriever.ts` — Pluggable retrieval: keyword matching or embedding+rerank strategies
- `src/service/message_formatter.ts` — Formats LangChain `BaseMessage[]` into dialogue text for extraction prompts
- `src/plugins/chat_middleware.ts` — ChatLuna `before-chat`/`after-chat` hooks: injects `{living_memory}` variable, triggers async recall/extraction
- `src/plugins/webui.ts` — Console DataService endpoints for memory/snapshot/job browsing

Required services: `chatluna`, `database`. Optional: `console` (for WebUI).
Config includes: `extractModel`, `embeddingModel`, `rerankModel`, extraction intervals/rounds, recall top-K, strategy selection (`keyword` | `embedding-rerank`).

## MVP product constraints

These constraints were decided before implementation and should guide future work:

- Memory scope is **preset-only**.
- Plugin currently targets **private chat only**; non-private chat should not trigger recall/extraction.
- Automatic **recall** is required and runs asynchronously during the current request.
- Recall input is only the **current user request text**.
- Recall writes a persistent `mem` snapshot cache for the **next** request.
- If recall fails or is slow, continue using the previous successful `mem` snapshot.
- Automatic **extraction** is required and runs independently/asynchronously so it does not block replies.
- Extraction input is the latest **N complete dialogue rounds** (`1 round = 1 user message + 1 assistant reply`).
- Extraction triggers at a fixed interval (for example every N rounds once threshold is reached), not on every turn.
- Manual memory management is handled in **WebUI**, not chat commands.
- WebUI manages both stored memories and prompt-injected `mem` snapshots.
- Storage backend is **SQLite**.
- Extraction output must use a **strongly constrained schema** and be validated before persistence.
- Extraction appends new memory entries instead of mutating existing ones.
- Duplicate memories are acceptable for now; later consolidation can be handled by a scheduled “dream” process.
- Retrieval strategy should be pluggable; MVP should support:
  - embedding retrieval + reranker ordering
  - keyword/text matching + simple sorting
- Async recall/extraction jobs should have explicit status records for observability and WebUI display.

## Architecture

Module layout follows the pattern below. Keep the design efficient and direct; avoid premature abstractions.

- `src/index.ts` — plugin entrypoint, config schema, service/plugin wiring
- `src/types.ts` — shared domain types and Koishi ORM table declarations
- `src/query.ts` — paginated query/filter types for WebUI endpoints
- `src/service/` — plugin-local services: memory lifecycle (`memory.ts`), SQLite persistence (`repository.ts`), extraction (`extractor.ts`), retrieval (`retriever.ts`), formatting (`message_formatter.ts`)
- `src/plugins/` — ChatLuna/Koishi integration: chat hooks (`chat_middleware.ts`), WebUI data service (`webui.ts`)

## ChatLuna integration notes

Relevant ChatLuna patterns confirmed from the reference code/docs:
- `ChatLunaPlugin` is the standard plugin wrapper when integrating with ChatLuna services.
- `chatluna/before-chat` can inject prompt variables before generation.
- `chatluna/after-chat` can observe completed turns after generation.
- ChatLuna provides a prompt render service with function/variable providers (`registerFunctionProvider`, `registerVariableProvider`).
- Koishi `inject` / `ctx.inject()` should be used correctly for required vs optional services.
- Koishi custom services are the right boundary for cross-module plugin state.

Implementation should follow ChatLuna-native seams rather than copying AstrBot internals.

## Common commands

Run from repository root.

- Install dependencies: `yarn install`
- Lint source: `yarn lint`
- Auto-fix lint issues: `yarn lint-fix`
- Build (server + client): `yarn build`
- Build server only: `yarn build:server`
- Build WebUI client only: `yarn build:client`

## Verification policy for this repository

Current user preference for active implementation work:
- Prioritize **type checking and format/lint checking**.
- Do **not** rely on runtime/manual integration testing unless the user explicitly asks for it.
- Do **not** claim runtime validation was performed if only static checks were run.

Because this repository currently has no dedicated test script, verify changes primarily through the available lint/build/type-oriented tooling unless the user later introduces a test harness.

## Code style expectations

- Code should prioritize **efficiency, readability, and performance** together.
- Add **Chinese comments only when necessary** to explain non-obvious logic.
- Prefer small, explicit modules over oversized files.
- Avoid adding host-platform features that belong to AstrBot rather than this plugin.
- Avoid designing for hypothetical future scenarios beyond the agreed MVP.

## Reference files worth consulting during implementation

ChatLuna:
- `C:\Users\31899\Desktop\test\chatluna\packages\core\src\services\chat.ts`
- `C:\Users\31899\Desktop\test\chatluna\packages\core\src\services\prompt_renderer.ts`
- `C:\Users\31899\Desktop\test\chatluna\packages\extension-long-memory\src\index.ts`
- `C:\Users\31899\Desktop\test\chatluna\packages\extension-long-memory\src\plugin.ts`
- `C:\Users\31899\Desktop\test\chatluna\packages\extension-long-memory\src\plugins\chat_middleware.ts`
- `C:\Users\31899\Desktop\test\chatluna\packages\extension-long-memory\src\service\memory.ts`
- `C:\Users\31899\Desktop\test\chatluna-doc\docs\development\api-reference\chatluna-plugin.md`
- `C:\Users\31899\Desktop\test\chatluna-doc\docs\development\api-reference\chatluna-events.md`

Koishi:
- `C:\Users\31899\Desktop\test\koishi-docs\en-US\guide\plugin\service.md`
- `C:\Users\31899\Desktop\test\koishi-docs\en-US\guide\plugin\schema.md`
- `C:\Users\31899\Desktop\test\koishi-docs\en-US\guide\basic\events.md`

AstrBot reference behavior:
- `C:\Users\31899\Desktop\test\astrbot_plugin_livingmemory`

## Repository-specific notes

- `package.json` uses Yarn scripts and Yakumo for build orchestration.
- TypeScript compiles from `src/` to `lib/`.
- `tsconfig.json` uses `moduleResolution: "Bundler"` and `jsxImportSource: "@satorijs/element"`.
- `koishi` and `koishi-plugin-chatluna` are peer dependencies; this package is meant to be loaded inside a host Koishi + ChatLuna environment.
