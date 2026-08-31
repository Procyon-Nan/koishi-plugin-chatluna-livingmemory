# AGENTS.md

Repository-specific guidance for `koishi-plugin-chatluna-livingmemory`.

## Project Structure

- `src/index.ts` is the Koishi plugin entrypoint. It registers the Living Memory
  service, ChatLuna and Character integrations, model-facing tools, and the
  optional Console WebUI.
- `src/contracts/` owns shared memory, workflow, and RPC contracts.
  `src/integrations/koishi-augmentations.ts` owns Koishi declaration merging,
  while `src/types.ts` is the compatibility re-export entry.
- `src/plugins/` contains integration boundaries:
    - `chat_middleware.ts` handles the main ChatLuna lifecycle and request-scoped
      prompt injection.
    - `character_middleware.ts` handles Character events and the
      `{living_memory}` prompt function.
    - `living_memory_tools.ts` registers `living_memory_search` and
      `living_memory_get_messages`.
    - `webui.ts` exposes Console RPC listeners.
- `src/service/app/living_memory_service.ts` is the application facade. The
  other files under `src/service/app/` own configuration status, scope
  construction, prompt hydration, and query projections.
- `src/service/workflows/` owns recall, extraction, Dream, job tracking, and the
  shared structured-output protocol.
- `src/service/prompts/` is the source of truth for workflow prompts and Zod
  output schemas. `prompt_format.ts` owns System/Human prompt composition and
  escaping of dynamic XML blocks.
- `src/service/memory/` owns memory field normalization, source origins,
  snapshot rendering/cache behavior, preset discovery, and reusable tool
  implementations.
- `src/service/transcript/` owns ChatLuna and Character transcript adapters,
  rendering, formatting, and source-message serialization.
- `src/service/persistence/` owns table definitions and table-focused
  repositories. `repository.ts` is the persistence facade.
- `client/` contains the Vue Console dashboard, RPC wrappers, browser-safe
  contract mirrors, paged-resource composables, components, and scoped styles.
- `tests/` contains workflow, prompt, persistence, middleware, tool, query, and
  client-state tests. `docs/` contains user-facing guides.
- `lib/` and `dist/` are generated outputs. Do not edit them unless generated
  artifacts are explicitly requested. Use ignored `tmp/` for temporary plans
  and investigation notes.

## Important Boundaries

- Long-term memory entries are isolated by preset. Recall snapshots are
  isolated by preset and conversation.
- Keep the main ChatLuna and Character paths separate. They use different event
  payloads, transcript adapters, preset identifiers, and injection mechanisms.
- Recall is asynchronous. The current request injects the previously hydrated
  snapshot; a snapshot produced by the current recall is used by later turns.
  `embedding-rerank` snapshots contain memory references, while
  `agentic-recall` snapshots contain rendered final text and search trace data.
- Extraction is driven by completed user/assistant rounds. Preserve its
  per-scope in-memory buffering, serialized execution, trigger-boundary
  consumption, and required preset-prompt resolver.
- Structured result tools are invocation-scoped internal tools. Keep prompt
  output rules, Zod schemas, validation, retry behavior, and workflow failure
  handling aligned.
- Dream only processes active memories. Preserve action allowlists,
  touched-memory guards, complete generated metadata, and atomic merge
  persistence through `applyDreamMerge()`; archive and merge actions may move
  processed active memories into the archived history.
- User profile generation and rendering must honor
  `enableUserProfileInjection`; speaker discovery remains independent from that
  gate.
- Memory mutations that change content, summary, or keywords must invalidate
  stale embeddings. Snapshot mutations must clear the affected snapshot cache.
- Schema changes must update contracts, table definitions, persistence, and any
  exposed RPC/client types together.
- RPC changes must keep `src/contracts/rpc.ts`, Koishi augmentations,
  `src/plugins/webui.ts`, `client/api.ts`, `client/types.ts`, and the affected
  Vue state synchronized.

## Code Style

- Follow the existing module boundaries, naming, formatting, and nearby
  implementation patterns.
- Prefer small, direct, typed modules and caller-specific capability interfaces
  over broad concrete dependencies or duplicate abstractions.
- Reuse transcript adapters, prompt helpers, memory normalizers, tool contracts,
  and repository capabilities instead of duplicating conversion or validation
  logic.
- Keep changes narrowly scoped. Avoid unrelated refactors, formatting churn,
  speculative compatibility paths, database changes, or new WebUI configuration.
- Keep background workflows non-blocking and preserve existing error and audit
  semantics.
- Add comments only for non-obvious logic. Use Chinese for complex explanatory
  comments and avoid comments that restate the code.
- Verify uncertain ChatLuna, Koishi, database, model, or tool behavior against
  local source or documentation before changing integrations.

## Verification

- Documentation only: `git diff --check`.
- Server source: `yarn lint` and `git diff --check`.
- Contract, repository, or RPC changes: also run
  `yarn atsc -p tsconfig.json --noEmit`.
- Client or Console changes: also run `yarn build:client`.
- Server build or package-boundary changes: run `yarn build:server` or
  `yarn build` as appropriate.

## CodeGraph

If `.codegraph/` exists, use CodeGraph before ad hoc text search for
architecture, symbol location, call paths, or impact analysis. Useful entry
points include `src/index.ts`, `ChatLunaLivingMemoryService`, the recall,
extraction, and Dream coordinators, `LivingMemoryRepository`, and
`src/plugins/webui.ts`.
