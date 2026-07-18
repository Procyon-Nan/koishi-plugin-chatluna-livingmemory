# AGENTS.md

This file records repository-specific guidance for
`koishi-plugin-chatluna-livingmemory`. Keep it aligned with the current source
tree whenever architecture, data contracts, or workflow boundaries change.

## Project Map

- `src/index.ts` is the Koishi plugin entrypoint. It registers
  `ChatLunaLivingMemoryService`, the optional console WebUI, the main ChatLuna
  middleware, and the optional `chatluna_character` middleware.
- `src/contracts/memory.ts` owns memory-domain records, source messages,
  snapshots, jobs, profiles, search payloads, and mutation inputs.
- `src/contracts/workflows.ts` owns workflow configuration, status results, and
  repository capability interfaces.
- `src/contracts/rpc.ts` owns pagination, WebUI query payloads, and console RPC
  event contracts.
- `src/integrations/koishi-augmentations.ts` owns Koishi service/table and
  console event declaration merging.
- `src/types.ts` is the compatibility re-export entry for the contract modules.
- `src/query.ts` contains list filtering and pagination helpers used by WebUI
  calls for memories, snapshots, jobs, and user profiles.
- `src/plugins/chat_middleware.ts` handles main ChatLuna events. It resolves
  preset scope, records preset speakers, keeps request-scoped user profile and
  memory snapshot injections active across the main agent's tool-call turns,
  queues recall before chat, queues extraction after chat, and cleans
  conversation caches on history clear.
- `src/plugins/character_middleware.ts` handles ChatLuna Character events. It
  uses `characterPresetSuffix` from `src/service/memory/helpers.ts`, registers
  the `{living_memory}` prompt function provider, tracks speaker labels by
  scope, queues recall, and queues extraction with a character preset prompt
  override.
- `src/plugins/webui.ts` is the console RPC boundary. Keep it synchronized with
  `src/contracts/rpc.ts`, `src/integrations/koishi-augmentations.ts`,
  `client/api.ts`, `client/types.ts`, and the affected dashboard component.
- `src/plugins/living_memory_tools.ts` registers the model-facing
  living-memory tools with ChatLuna, including `living_memory_search` and
  `living_memory_get_messages`.
- `client/dashboard.vue` is the WebUI shell for preset selection, warnings,
  global actions, tabs, and cross-tab refresh coordination.
- `client/components/` owns the memories, user profiles, snapshots, and jobs
  tabs plus memory-editor and snapshot-detail dialogs.
- `client/composables/` owns client-side paged-resource and memory-list state;
  `client/utils/display.ts` owns shared display-only formatters and labels.
- `client/styles/` owns scoped dashboard, tab, card, table, and dialog styles.
- `client/api.ts` and `client/types.ts` own the client RPC wrappers and local
  browser-safe contract mirror.
- `src/service/app/living_memory_service.ts` is the service facade. It
  constructs the repository, retriever, extractor, recall query builder,
  agentic recall executor, user profile service, Dream service, job tracker,
  snapshot cache, preset catalog, and coordinators.
- `src/service/app/config_status.ts` owns config warning generation and service
  status assembly.
- `src/service/app/scope.ts` owns `MemoryScope` construction.
- `src/service/app/prompt_hydration.ts` owns prompt hydration composition for
  memory snapshots and user profiles.
- `src/service/app/query_projections.ts` owns complex application query
  projections, including source-message output and resolved snapshot pages.
- `src/service/workflows/` contains async workflow orchestration for recall,
  extraction, and Dream. Coordinators own job state handling, in-memory locks,
  snapshot cache refreshes, and extraction baselines.
- `src/service/workflows/recall/` owns embedding-rerank retrieval, recall query
  rewrite, and the agentic-recall executor.
- `src/service/workflows/extraction/` owns memory extraction orchestration and
  extraction model parsing.
- `src/service/workflows/dream/` owns Dream clustering, prompt parsing,
  operation execution, stats, and Dream coordination. Dream processes active
  memories and archived memories, then attempts user profile regeneration when
  profile injection is enabled. Profile regeneration failures are recorded in
  the completed Dream detail without failing the preceding Dream operations.
- `src/service/workflows/job_tracker.ts` owns Dream workflow job lifecycle
  status updates. Recall and extraction only create a single persisted failed
  audit row when their execution pipeline throws or extraction parsing fails.
- `src/service/memory/entry_fields.ts` owns shared memory field normalization
  rules and limits used by extraction, Dream, and persistence writes.
- `src/service/memory/tools/search_contract.ts` centralizes lexical
  memory-search tool names, query text length limits, and schema rules used by
  the tools, agentic recall, prompts, and search implementation.
- `src/service/memory/tools/search_tool.ts` owns the reusable
  `living_memory_search` tool implementation.
- `src/service/memory/tools/get_messages_tool.ts` owns the
  `living_memory_get_messages` tool implementation for retrieving source
  conversation messages by memory id.
- `src/service/memory/tools/tool_runtime.ts` owns shared model-facing tool
  runtime behavior, including runtime scope resolution and debug logging.
- `src/service/memory/tools/search.ts` owns lexical memory search scoring and
  result assembly.
- `src/service/memory/snapshot/` owns snapshot hydration/cache helpers and
  snapshot item type guards.
- `src/service/memory/origins/source_origins.ts` owns creation, cloning,
  normalization, and deterministic merge helpers for memory source-origin
  groups.
- `src/service/transcript/` owns ChatLuna/Character transcript adapters,
  message formatting, transcript rendering, and source-message serialization.
- `src/service/persistence/repository.ts` owns the `LivingMemoryRepository`
  facade, table registration, cross-table maintenance, and delegation to the
  table-focused persistence modules.
- `src/service/persistence/entries.ts` owns memory entry queries and mutations,
  source-origin migration, embedding updates, and transactional Dream merges.
- `src/service/persistence/jobs.ts` owns job lifecycle, stale-job recovery, and
  retention cleanup.
- `src/service/persistence/snapshots.ts` owns snapshot queries, replacement,
  duplicate cleanup, and deletion.
- `src/service/persistence/user_profiles.ts` owns preset speaker and user
  profile persistence.
- `src/service/persistence/tables.ts` owns Koishi database table definitions.
- `src/service/persistence/normalizers.ts` owns persistence record
  normalization helpers.
- `src/service/user_profile.ts` owns preset speaker normalization, user profile
  generation, profile rendering, and profile source-memory selection.
- `src/service/prompts/` is the prompt/schema source of truth for extraction,
  recall rewrite, agentic recall, Dream, and user profiles.
- `src/service/prompts/prompt_format.ts` owns the shared System/Human prompt
  message contract, XML text escaping and block formatting, and prompt trace
  serialization used by model workflows.
- `lib/` and `dist/` are build outputs. Do not edit them unless the task
  explicitly asks for generated artifacts.
- `tmp/` is the local planning workspace for each new feature design or bug-fix
  investigation. Store temporary research notes, evidence, design options, and
  implementation plans there. This directory is intentionally ignored by Git and
  must not be used for source files or committed artifacts.

## Runtime Flows

- Startup defines six tables through `LivingMemoryRepository.defineTables()`:
  `living_memory_entry`, `living_memory_snapshot`, `living_memory_job`,
  `living_memory_user_profile`, `living_memory_preset_speaker`, and
  `living_memory_migration`.
- Service startup runs versioned persistence migrations before recovering stale
  jobs. The `source-origins-array-v1` migration repairs legacy non-array
  `sourceOrigins` values to `[]`.
- Service startup recovers stale pending/running lifecycle rows and emits config
  warnings. New pending/running rows normally belong to Dream; legacy Recall or
  Extraction rows may also be recovered. Job rows are audit records, not durable
  schedulers.
- Main ChatLuna `before-chat` builds a scope, records the current speaker, loads
  history only when needed, hydrates prompt sections, activates request-scoped
  user profiles as a system-role block after system prompts, activates
  request-scoped memory snapshots as an assistant-role block after history and
  before the current user input, and queues recall. These request-scoped
  injections remain available across the main agent's tool-call turns and are
  cleared on `after-chat`, `after-chat-error`, or history clear.
- Main ChatLuna `after-chat` converts history to transcript messages and queues
  extraction based on chat count with a required lazy resolver for the active
  preset system prompt.
- Character integration uses a separate preset id based on
  `characterPresetSuffix`. Character prompt injection happens through the
  `{living_memory}` function provider rather than ChatLuna core context
  injection. Character extraction resolves its preset system prompt from the
  required preset snapshot carried by the event payload.
- Recall is serialized per scope and remains asynchronous: the current chat turn
  injects the previous hydrated snapshot, while the recall snapshot produced by the
  current turn is used by later turns. Successful, skipped, empty, and
  `<NO_MEMORY>` Recall runs do not create Job rows.
- `embedding-rerank` recall uses query rewrite when enabled. Empty cleaned
  queries are skipped; disabled or failed rewrite paths record their reason and
  use the normalized current query when possible. Rewrite rules are sent as a
  System message, while escaped transcript inputs are sent as XML-blocked Human
  data.
- `agentic-recall` recall is a separate selectable strategy. It uses
  `recallHistoryWindowRounds` for its history window, has its own
  `agenticRecallModel`, and delegates tool-call parsing, protocol handling, and
  recoverable loop errors to ChatLuna `AgentRunner`. Static role, tool, and
  output rules are sent as a System message; escaped transcript inputs are sent
  as XML-blocked Human data. Each run allows at most six model calls: the first
  five may call `living_memory_search`, while the sixth is a tool-free
  finalization call. Exhausting this budget degrades to `<NO_MEMORY>`;
  model-service and search-service runtime errors remain hard failures.
  Successful runs write agentic snapshot items containing final memory text
  plus the raw search parameters and matched memories captured before
  AgentRunner decorates observations.
- When agentic recall finishes with `<NO_MEMORY>`, no Job or snapshot is written
  or hydrated. The previous snapshot remains the next injectable memory context.
- `living_memory_job.recallStrategy` records the selected Recall strategy for
  failed Recall audit rows. Non-Recall jobs and pre-existing rows may have
  `null`.
- `living_memory_snapshot.strategy` distinguishes snapshot item semantics:
  `embedding-rerank` stores memory references, while `agentic-recall`
  stores agentic snapshot items rendered directly as final memory text.
- Preset system prompts are runtime invariants for extraction and user-profile
  generation. Do not add empty, missing, or unavailable-prompt fallbacks; preset
  lookup and rendering failures indicate an integration error and must propagate
  through the owning workflow's existing failure semantics.
- Extraction uses an interval baseline per scope. Payload construction, preset
  prompt resolution, model, parse, and persistence failures create one failed
  audit row; successful and skipped runs, including valid empty arrays, do not
  create Job rows.
- Dream active-stage operations allow keep, update, merge, and archive. Archived
  stage operations allow keep, update, merge, and deleteSource.
- Dream merge preserves source-origin groups by combining the target memory
  first, then source memories in operation order. Dream update and archive do
  not change source-origin groups.
- Each Dream merge is committed through one repository transaction: the target
  metadata and source origins are updated together with all source archives or
  deletions. Dream jobs remain non-atomic across separate operations and
  clusters, so failed jobs clear the preset snapshot cache.
- Automatic Dream is optional and preset-scoped. When enabled, successful
  memory creation checks how many entries were created for that preset after
  the latest `dream` job; if the configured threshold is reached, it reuses the
  normal Dream coordinator for that preset instead of running a global schedule.
- Dream-generated update and merge content must include complete metadata:
  type, content, summary, keywords, sentiment, and importance.
- User profile generation and rendering must honor `enableUserProfileInjection`.
  Speaker recording can still happen independently so future profile generation
  has an index to work from.
- Dream attempts user profile regeneration only after its active and archived
  stages finish. User profile failures must not change a completed Dream into a
  failed job, while Dream-stage failures keep their existing failure semantics.
- Dream sends static operation and output rules as a System message, while
  escaped preset, stage, cluster, and memory-entry data is sent as XML-blocked
  Human input.
- User profile generation sends static role-identity, first-person perspective,
  fact, update, and output rules as a System message. The System role directly
  identifies the escaped assistant label, binds “我” to that role, and requires
  supported subjective impressions rather than a neutral third-party profile.
  Escaped assistant label, preset context, existing profile, source ids, and
  memory entries remain XML-blocked Human input.

## Data And RPC Boundaries

- Any schema-affecting change must update `src/contracts/memory.ts`,
  `src/service/persistence/tables.ts`,
  the affected table-focused persistence module,
  `src/service/persistence/repository.ts` when its public facade changes, query
  helpers if list behavior changes, and the WebUI/client types when visible in
  the console.
- Workflow classes should depend on caller-specific repository capability
  types instead of the concrete `LivingMemoryRepository`. Compose the contracts
  from `src/contracts/workflows.ts` where possible.
- Any console RPC change must update all affected surfaces together:
  `src/contracts/rpc.ts`, `src/integrations/koishi-augmentations.ts`,
  `src/plugins/webui.ts`, and the corresponding `client/api.ts`,
  `client/types.ts`, component, or composable surface.
- Memory list RPC responses include preset-wide status/type facets computed
  before query pagination. Do not restore client-side pseudo-full-list requests
  for filter counts.
- Any memory mutation that changes content, summary, or keywords must preserve
  embedding invalidation behavior so stale cached vectors are recomputed on
  demand.
- Dream merge writes must use the `applyDreamMerge()` repository capability;
  do not split target updates and source disposition into independent writes.
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
  empty cleaned query, empty final query, and agentic `<NO_MEMORY>` behavior
  before editing.
- For `living_memory_search` changes, keep
  `src/service/memory/tools/search_contract.ts`,
  `src/service/memory/tools/search_tool.ts`,
  `src/service/memory/tools/search.ts`, `src/plugins/living_memory_tools.ts`,
  and agentic recall prompt rules aligned.
- For `living_memory_get_messages` changes, keep
  `src/service/memory/tools/search_contract.ts`,
  `src/service/memory/tools/get_messages_tool.ts`,
  `src/service/memory/tools/tool_runtime.ts`,
  `src/plugins/living_memory_tools.ts`, and persistence repository
  source-origin contracts aligned.
- For extraction changes, preserve interval baseline handling, lock behavior,
  job state transitions, the required preset-prompt resolver contract, and
  parse-error semantics. Do not restore null, empty, unavailable, or
  render-failure prompt fallbacks.
- For Dream changes, preserve stage-specific action allowlists, touched-memory
  guards, complete metadata validation, source-origin merge behavior, and
  profile regeneration gating.
- For user profile changes, keep speaker key normalization, selected memory
  limits, source memory id validation, and direct preset prompt retrieval
  explicit. Preset lookup and rendering errors must propagate to the caller.
- For Character integration changes, keep the main ChatLuna and Character
  injection paths separate; do not assume one event payload shape applies to the
  other.
- For WebUI work, keep server RPCs, client API wrappers, Vue state, pagination,
  type declarations, tab component refresh behavior, and scoped styles in sync.

## Verification

- For documentation-only changes, run `git diff --check`.
- For source changes, run `yarn lint` and `git diff --check`.
- For type contract, repository, or RPC changes, also run
  `yarn atsc -p tsconfig.json --noEmit`.
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
