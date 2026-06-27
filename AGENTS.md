# AGENTS.md

This file records repository-specific guidance for
`koishi-plugin-chatluna-livingmemory`. Keep it aligned with the current source
tree whenever architecture, data contracts, or workflow boundaries change.

## Project Map

- `src/index.ts` is the Koishi plugin entrypoint. It registers
  `ChatLunaLivingMemoryService`, the optional console WebUI, the main ChatLuna
  middleware, and the optional `chatluna_character` middleware.
- `src/types.ts` is the shared contract surface for memory entries, snapshots,
  jobs, user profiles, preset speakers, config, repository interfaces, Koishi
  table declarations, and console RPC events.
- `src/query.ts` contains list filtering and pagination helpers used by WebUI
  calls for memories, snapshots, jobs, and user profiles.
- `src/plugins/chat_middleware.ts` handles main ChatLuna events. It resolves
  preset scope, records preset speakers, injects snapshot/profile prompt
  sections, queues recall before chat, queues extraction after chat, and cleans
  conversation caches on history clear.
- `src/plugins/character_middleware.ts` handles ChatLuna Character events. It
  uses `characterPresetSuffix` from `src/service/memory/helpers.ts`, registers
  the `{living_memory}` prompt function provider, tracks speaker labels by
  scope, queues recall, and queues extraction with a character preset prompt
  override.
- `src/plugins/webui.ts` is the console RPC boundary. Keep it synchronized with
  `src/types.ts`, `client/api.ts`, and `client/dashboard.vue`.
- `client/api.ts`, `client/types.ts`, and `client/dashboard.vue` implement the
  WebUI surface for memories, user profiles, snapshots, jobs, Dream execution,
  and preset data cleanup.
- `src/service/memory/index.ts` is the service facade. It constructs the
  repository, retriever, extractor, recall query builder, user profile service,
  Dream service, job tracker, snapshot cache, preset catalog, and coordinators.
- `src/service/memory/*_coordinator.ts` contains async orchestration, job state
  handling, in-memory locks, snapshot cache refreshes, and extraction baselines.
- `src/service/repository.ts` owns Koishi database table definitions and all
  persistence methods.
- `src/service/recall_query.ts` and `src/service/retriever.ts` own query
  normalization/rewrite handling and embedding-rerank retrieval.
- `src/service/extractor.ts`, `src/service/message_formatter.ts`, and the
  transcript adapters convert chat history into extraction-ready records and
  parse model output.
- `src/service/dream/` owns Dream clustering, prompt parsing, operation
  execution, and stats. Dream processes active memories and archived memories,
  then regenerates user profiles when profile injection is enabled.
- `src/service/user_profile.ts` owns preset speaker normalization, user profile
  generation, profile rendering, and profile source-memory selection.
- `src/service/prompts/` and `src/service/prompts.ts` are the prompt/schema
  source of truth for extraction, recall rewrite, Dream, and user profiles.
- `lib/` and `dist/` are build outputs. Do not edit them unless the task
  explicitly asks for generated artifacts.
- `tmp/` is the local planning workspace for each new feature design or bug-fix
  investigation. Store temporary research notes, evidence, design options, and
  implementation plans there. This directory is intentionally ignored by Git and
  must not be used for source files or committed artifacts.

## Runtime Flows

- Startup defines five tables through `LivingMemoryRepository.defineTables()`:
  `living_memory_entry`, `living_memory_snapshot`, `living_memory_job`,
  `living_memory_user_profile`, and `living_memory_preset_speaker`.
- Service startup recovers stale pending/running jobs and emits config warnings.
  Job rows are audit records, not durable schedulers.
- Main ChatLuna `before-chat` builds a scope, records the current speaker, loads
  history only when needed, hydrates prompt sections, injects snapshot/profile
  text into ChatLuna core, and queues recall.
- Main ChatLuna `after-chat` converts history to transcript messages, reports
  diagnostics in debug mode, and queues extraction based on chat count.
- Character integration uses a separate preset id based on
  `characterPresetSuffix`. Character prompt injection happens through the
  `{living_memory}` function provider rather than ChatLuna core context
  injection.
- Recall is serialized per scope. Empty cleaned queries are skipped; disabled or
  failed rewrite paths record their reason and use the normalized current query
  when possible.
- Retrieval uses `embedding-rerank` only. Missing or unavailable embedding and
  rerank dependencies fail the recall job instead of switching strategy.
- Extraction uses an interval baseline per scope. Parse failures mark the job as
  failed; valid empty arrays mark a completed extraction with zero memories.
- Dream active-stage operations allow keep, update, merge, and archive. Archived
  stage operations allow keep, update, merge, and deleteSource.
- Dream-generated update and merge content must include complete metadata:
  type, content, summary, keywords, sentiment, and importance.
- User profile generation and rendering must honor `enableUserProfileInjection`.
  Speaker recording can still happen independently so future profile generation
  has an index to work from.

## Data And RPC Boundaries

- Any schema-affecting change must update `src/types.ts`,
  `src/service/repository.ts`, query helpers if list behavior changes, and the
  WebUI/client types when visible in the console.
- Any console RPC change must update all four surfaces together:
  `src/types.ts`, `src/plugins/webui.ts`, `client/api.ts`, and
  `client/dashboard.vue`.
- Any memory mutation that changes content, summary, or keywords must preserve
  embedding invalidation behavior so stale cached vectors are recomputed on
  demand.
- `clearPresetData()` intentionally clears entries, snapshots, jobs, user
  profiles, preset speakers, and snapshot cache for the preset.
- Snapshot operations should clear the snapshot cache when deleting or replacing
  data that can affect hydrated prompt output.

## Code Style Rules

- Prefer clear, direct code over clever abstractions.
- Keep changes narrowly scoped to the requested behavior.
- Follow existing module, naming, and formatting patterns in nearby files.
- Avoid unrelated refactors, formatting churn, and metadata changes.
- Prefer typed data structures and existing helper APIs over ad hoc string
  handling.
- Use the transcript adapters, message formatter, prompt helpers, and repository
  interfaces instead of duplicating conversion or persistence logic.
- Keep modules small and responsibilities explicit.
- Use async workflows in a non-blocking manner when adding background work.
- Handle recoverable failures without blocking the primary reply path.
- Add comments only when they clarify non-obvious logic.
- Use Chinese comments only for complex logic.
- Avoid comments that restate what the code already says.
- Do not introduce database schema changes unless explicitly required.
- Do not add new WebUI configuration unless explicitly required.
- When integration behavior is unclear, verify against local source code or
  documentation instead of guessing.

## Change Guidance

- For recall changes, distinguish rewrite-disabled, rewrite-failure,
  empty cleaned query, and empty final query behavior before editing.
- For extraction changes, preserve interval baseline handling, lock behavior,
  job state transitions, prompt rendering fallback, and parse-error semantics.
- For Dream changes, preserve stage-specific action allowlists, touched-memory
  guards, complete metadata validation, and profile regeneration gating.
- For user profile changes, keep speaker key normalization, selected memory
  limits, source memory id validation, and prompt rendering fallbacks explicit.
- For Character integration changes, keep the main ChatLuna and Character
  injection paths separate; do not assume one event payload shape applies to the
  other.
- For WebUI work, keep server RPCs, client API wrappers, Vue state, pagination,
  and type declarations in sync.

## Verification

- For documentation-only changes, run `git diff --check`.
- For source changes, run `yarn lint` and `git diff --check`.
- For type contract, repository, or RPC changes, also run
  `yarn exec tsc -p tsconfig.json --noEmit`.
- For WebUI changes, run `yarn build:client` when the change affects
  `client/`, console entries, or RPC payload shape.
- For server build or package-boundary changes, run `yarn build:server` or
  `yarn build` when appropriate.

## CodeGraph

- If `.codegraph/` exists, use CodeGraph before ad hoc text search for
  architecture, impact, caller/callee, or symbol-location work.
- Good starting points are `src/index.ts`, `ChatLunaLivingMemoryService`,
  `LivingMemoryRecallCoordinator`, `LivingMemoryExtractionCoordinator`,
  `LivingMemoryDreamService`, `LivingMemoryUserProfileService`,
  `LivingMemoryRepository`, and `src/plugins/webui.ts`.
