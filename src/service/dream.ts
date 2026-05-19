import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    MemoryEntryRecord,
    MemoryEntryType,
    MemoryMutationInput
} from '../types'
import { memoryEntryTypes } from '../types'
import type { LivingMemoryRepository } from './repository'
import { ensureEntryEmbeddings } from './shared/embeddings'
import {
    cosineSimilarity,
    isModelConfigured,
    stringifyModelContent,
    summarizeError
} from './shared/utils'

const MAX_CLUSTER_SIZE = 8
const MAX_BUCKET_SIZE = 64
const MAX_DREAM_CLUSTERS = 32
const EMBEDDING_SIMILARITY_THRESHOLD = 0.84
const STRONG_KEYWORD_OVERLAP = 2

const neutralSentiments = new Set([
    '中性',
    '无',
    '无明显情绪',
    'none',
    'neutral'
])

const normalizeText = (value: string) => value.trim()

const normalizeTerm = (value: string) => value.trim().toLowerCase()

const unique = <T>(items: T[]) => Array.from(new Set(items))

const parseImportance = (value: unknown): number | undefined => {
    const importance =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim().length > 0
              ? Number(value.trim())
              : Number.NaN

    if (!Number.isFinite(importance)) {
        return undefined
    }

    return Math.min(1, Math.max(0, importance))
}

const isMemoryEntryType = (value: string): value is MemoryEntryType => {
    return (memoryEntryTypes as readonly string[]).includes(value)
}

const toTimestamp = (value: Date | string | number) => {
    const timestamp = +new Date(value)
    return Number.isFinite(timestamp) ? timestamp : 0
}

const toMonthBucket = (value: Date | string | number) => {
    const date = new Date(value)
    if (!Number.isFinite(+date)) {
        return 'unknown'
    }

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        '0'
    )}`
}

const toIsoString = (value: Date | string | number) => {
    const date = new Date(value)
    return Number.isFinite(+date) ? date.toISOString() : ''
}

const toPromptEntry = (entry: MemoryEntryRecord) => {
    return [
        `id=${entry.id}`,
        `type=${entry.type}`,
        `status=${entry.status}`,
        `createdAt=${toIsoString(entry.createdAt)}`,
        `updatedAt=${toIsoString(entry.updatedAt)}`,
        `sentiment=${entry.sentiment ?? ''}`,
        `importance=${entry.importance ?? ''}`,
        `keywords=${entry.keywords.join('、')}`,
        `summary=${entry.summary ?? ''}`,
        'content:',
        entry.content
    ].join('\n')
}

const keywordSet = (entry: MemoryEntryRecord) => {
    return new Set(entry.keywords.map(normalizeTerm).filter(Boolean))
}

const keywordOverlap = (left: MemoryEntryRecord, right: MemoryEntryRecord) => {
    const leftKeywords = keywordSet(left)
    if (leftKeywords.size === 0) {
        return 0
    }

    let count = 0
    for (const keyword of keywordSet(right)) {
        if (leftKeywords.has(keyword)) {
            count++
        }
    }

    return count
}

interface CandidateGroup {
    reason: string
    entries: MemoryEntryRecord[]
}

interface DreamCluster {
    id: string
    reason: string
    entries: MemoryEntryRecord[]
}

interface DreamOperationStats {
    kept: number
    merged: number
    updated: number
    archived: number
    deleted: number
    skipped: number
}

export interface DreamRunResult extends DreamOperationStats {
    entryCount: number
    clusterCount: number
    skippedReason?: string
    detail: string
}

type DreamStage = 'active' | 'archived'

type DreamAction = 'keep' | 'merge' | 'update' | 'archive' | 'deleteSource'

interface DreamStageResult extends DreamOperationStats {
    stage: DreamStage
    entryCount: number
    clusterCount: number
    detail: string
}

interface DreamOperation {
    action: DreamAction
    memoryId?: string
    memoryIds?: string[]
    targetMemoryId?: string
    sourceMemoryIds?: string[]
    memory?: Record<string, unknown>
    reason?: string
}

class UnionFind {
    private readonly parent = new Map<string, string>()

    constructor(ids: string[]) {
        ids.forEach((id) => this.parent.set(id, id))
    }

    find(id: string): string {
        const parent = this.parent.get(id)
        if (parent == null || parent === id) {
            return id
        }

        const root = this.find(parent)
        this.parent.set(id, root)
        return root
    }

    union(left: string, right: string) {
        const leftRoot = this.find(left)
        const rightRoot = this.find(right)
        if (leftRoot !== rightRoot) {
            this.parent.set(rightRoot, leftRoot)
        }
    }

    groups(entries: MemoryEntryRecord[]) {
        const byRoot = new Map<string, MemoryEntryRecord[]>()
        for (const entry of entries) {
            const root = this.find(entry.id)
            const group = byRoot.get(root) ?? []
            group.push(entry)
            byRoot.set(root, group)
        }

        return [...byRoot.values()].filter((group) => group.length >= 2)
    }
}

export class LivingMemoryDreamService {
    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly repository: LivingMemoryRepository,
        private readonly debug: (message: string) => void
    ) {}

    async run(presetId: string): Promise<DreamRunResult> {
        const entries = await this.repository.listEntriesByPreset(presetId)
        if (entries.length < 2) {
            return this.createResult(entries.length, 0, {
                detail: `dream skipped: only ${entries.length} memories`
            })
        }

        const activeEntries = entries.filter(
            (entry) => entry.status === 'active'
        )

        if (!isModelConfigured(this.config.dreamModel)) {
            return this.createResult(entries.length, 0, {
                skippedReason: 'model-not-configured',
                detail: 'dream skipped: model-not-configured'
            })
        }

        return this.ctx.chatluna.withUsageSource(
            'chatluna-livingmemory',
            async () => {
                const model = await this.ctx.chatluna.createChatModel(
                    this.config.dreamModel
                )
                if (model.value == null) {
                    return this.createResult(entries.length, 0, {
                        skippedReason: 'model-unavailable',
                        detail: 'dream skipped: model-unavailable'
                    })
                }

                const chatModel = model.value
                const invokeModel = async (prompt: string) => {
                    const result = await chatModel.invoke(prompt)
                    return stringifyModelContent(result.content)
                }

                const activeResult = await this.runStage(
                    presetId,
                    'active',
                    activeEntries,
                    invokeModel
                )
                const refreshedEntries =
                    await this.repository.listEntriesByPreset(presetId)
                const archivedEntries = refreshedEntries.filter(
                    (entry) => entry.status === 'archived'
                )
                const archivedResult = await this.runStage(
                    presetId,
                    'archived',
                    archivedEntries,
                    invokeModel
                )
                const stats = this.sumStats([activeResult, archivedResult])
                const detail = [
                    activeResult.detail,
                    archivedResult.detail
                ].join('\n')

                this.debug(
                    [
                        `memory dream execution summary: presetId=${presetId}`,
                        detail
                    ].join('\n')
                )

                return {
                    entryCount: entries.length,
                    clusterCount:
                        activeResult.clusterCount +
                        archivedResult.clusterCount,
                    ...stats,
                    detail
                }
            }
        )
    }

    private async runStage(
        presetId: string,
        stage: DreamStage,
        entries: MemoryEntryRecord[],
        invokeModel: (prompt: string) => Promise<string>
    ): Promise<DreamStageResult> {
        if (entries.length < 2) {
            return this.createEmptyStageResult(stage, entries.length)
        }

        const clusters = await this.buildClusters(entries)
        this.debug(
            [
                `memory dream clusters: presetId=${presetId}`,
                `stage=${stage}`,
                `entryCount=${entries.length}`,
                `clusterCount=${clusters.length}`,
                clusters
                    .map(
                        (cluster) =>
                            `${cluster.id} reason=${cluster.reason} ids=${cluster.entries
                                .map((entry) => entry.id)
                                .join(',')}`
                    )
                    .join('\n')
            ].join('\n')
        )

        const touchedMemoryIds = new Set<string>()
        const stats = this.createEmptyStats()

        for (const cluster of clusters) {
            const prompt = this.buildPrompt(presetId, cluster, stage)
            this.debug(
                [
                    `memory dream llm input: presetId=${presetId}`,
                    `stage=${stage}`,
                    `clusterId=${cluster.id}`,
                    prompt
                ].join('\n')
            )

            let output: string
            try {
                output = await invokeModel(prompt)
            } catch (error) {
                stats.skipped++
                this.debug(
                    [
                        `memory dream cluster skipped: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        'reason=invoke-failed',
                        `error=${summarizeError(error)}`
                    ].join(' ')
                )
                continue
            }

            this.debug(
                [
                    `memory dream llm output: presetId=${presetId}`,
                    `stage=${stage}`,
                    `clusterId=${cluster.id}`,
                    output
                ].join('\n')
            )

            const operations = this.parseOperations(output)
            if (operations.length === 0) {
                stats.skipped++
                this.debug(
                    [
                        `memory dream cluster skipped: presetId=${presetId}`,
                        `stage=${stage}`,
                        `clusterId=${cluster.id}`,
                        'reason=empty-or-invalid-operations'
                    ].join(' ')
                )
                continue
            }

            const result = await this.executeOperations(
                stage,
                cluster,
                operations,
                touchedMemoryIds
            )
            this.addStats(stats, result)
        }

        return {
            stage,
            entryCount: entries.length,
            clusterCount: clusters.length,
            ...stats,
            detail: this.formatStageDetail(
                stage,
                entries.length,
                clusters.length,
                stats
            )
        }
    }

    private createEmptyStats(): DreamOperationStats {
        return {
            kept: 0,
            merged: 0,
            updated: 0,
            archived: 0,
            deleted: 0,
            skipped: 0
        }
    }

    private createEmptyStageResult(
        stage: DreamStage,
        entryCount: number
    ): DreamStageResult {
        const stats = this.createEmptyStats()
        return {
            stage,
            entryCount,
            clusterCount: 0,
            ...stats,
            detail: this.formatStageDetail(stage, entryCount, 0, stats)
        }
    }

    private addStats(target: DreamOperationStats, source: DreamOperationStats) {
        target.kept += source.kept
        target.merged += source.merged
        target.updated += source.updated
        target.archived += source.archived
        target.deleted += source.deleted
        target.skipped += source.skipped
    }

    private sumStats(items: DreamOperationStats[]) {
        const stats = this.createEmptyStats()
        for (const item of items) {
            this.addStats(stats, item)
        }
        return stats
    }

    private formatStageDetail(
        stage: DreamStage,
        entryCount: number,
        clusterCount: number,
        stats: DreamOperationStats
    ) {
        if (stage === 'active') {
            return [
                `dream active: scanned ${entryCount}`,
                `clusters ${clusterCount}`,
                `merged ${stats.merged}`,
                `updated ${stats.updated}`,
                `archived ${stats.archived}`,
                `skipped ${stats.skipped}`
            ].join(', ')
        }

        return [
            `dream archived: scanned ${entryCount}`,
            `clusters ${clusterCount}`,
            `merged ${stats.merged}`,
            `updated ${stats.updated}`,
            `deleted ${stats.deleted}`,
            `skipped ${stats.skipped}`
        ].join(', ')
    }

    private async buildClusters(
        entries: MemoryEntryRecord[]
    ): Promise<DreamCluster[]> {
        const cheapGroups = this.limitCandidateGroups(
            this.buildCheapGroups(entries)
        )
        const embeddingGroups = await this.tryBuildEmbeddingGroups(cheapGroups)
        return this.toDreamClusters(embeddingGroups ?? cheapGroups)
    }

    private buildCheapGroups(entries: MemoryEntryRecord[]): CandidateGroup[] {
        const buckets = new Map<string, MemoryEntryRecord[]>()
        const addBucket = (key: string, entry: MemoryEntryRecord) => {
            const bucket = buckets.get(key) ?? []
            bucket.push(entry)
            buckets.set(key, bucket)
        }

        for (const entry of entries) {
            for (const keyword of entry.keywords.map(normalizeTerm)) {
                if (keyword.length >= 2) {
                    addBucket(`type:${entry.type}:keyword:${keyword}`, entry)
                }
            }

            const sentiment = normalizeTerm(entry.sentiment ?? '')
            if (sentiment.length > 0 && !neutralSentiments.has(sentiment)) {
                addBucket(`type:${entry.type}:sentiment:${sentiment}`, entry)
            }

            addBucket(
                `type:${entry.type}:month:${toMonthBucket(entry.updatedAt)}`,
                entry
            )
        }

        const groups: CandidateGroup[] = []
        for (const [key, bucket] of buckets) {
            this.pushChunkedGroups(groups, key, bucket)
        }

        const entriesByType = new Map<MemoryEntryType, MemoryEntryRecord[]>()
        for (const entry of entries) {
            const group = entriesByType.get(entry.type) ?? []
            group.push(entry)
            entriesByType.set(entry.type, group)
        }

        for (const [type, group] of entriesByType) {
            const sorted = [...group].sort(
                (left, right) =>
                    toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt)
            )
            for (let index = 0; index < sorted.length - 1; index += 4) {
                const window = sorted.slice(index, index + MAX_CLUSTER_SIZE)
                this.pushGroup(groups, `type:${type}:time-window`, window)
            }
        }

        return this.dedupeGroups(groups)
    }

    private pushChunkedGroups(
        groups: CandidateGroup[],
        reason: string,
        entries: MemoryEntryRecord[]
    ) {
        const sorted = unique(entries).sort(
            (left, right) =>
                toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt)
        )
        if (sorted.length > MAX_BUCKET_SIZE) {
            return
        }

        for (
            let index = 0;
            index < sorted.length - 1;
            index += MAX_CLUSTER_SIZE
        ) {
            this.pushGroup(
                groups,
                reason,
                sorted.slice(index, index + MAX_CLUSTER_SIZE)
            )
        }
    }

    private pushGroup(
        groups: CandidateGroup[],
        reason: string,
        entries: MemoryEntryRecord[]
    ) {
        const uniqueEntries = unique(entries)
        if (uniqueEntries.length >= 2) {
            groups.push({ reason, entries: uniqueEntries })
        }
    }

    private dedupeGroups(groups: CandidateGroup[]): CandidateGroup[] {
        const seen = new Set<string>()
        const deduped: CandidateGroup[] = []

        for (const group of groups) {
            const key = group.entries
                .map((entry) => entry.id)
                .sort()
                .join('|')
            if (seen.has(key)) {
                continue
            }

            seen.add(key)
            deduped.push(group)
        }

        return deduped
    }

    private limitCandidateGroups(groups: CandidateGroup[]) {
        return groups
            .map((group) => ({
                group,
                score: this.scoreCandidateGroup(group)
            }))
            .sort((left, right) => right.score - left.score)
            .slice(0, MAX_DREAM_CLUSTERS * 3)
            .map((item) => item.group)
    }

    private scoreCandidateGroup(group: CandidateGroup) {
        const reasonScore = group.reason.includes(':keyword:')
            ? 4
            : group.reason.includes(':sentiment:')
              ? 3
              : group.reason.includes(':month:')
                ? 2
                : 1
        const importanceScore =
            group.entries.reduce(
                (sum, entry) => sum + (entry.importance ?? 0.5),
                0
            ) / group.entries.length
        const latestTimestamp = Math.max(
            ...group.entries.map((entry) => toTimestamp(entry.updatedAt))
        )

        return reasonScore * 10 + importanceScore + latestTimestamp / 1e15
    }

    private async tryBuildEmbeddingGroups(
        groups: CandidateGroup[]
    ): Promise<CandidateGroup[] | null> {
        if (
            !isModelConfigured(this.config.embeddingModel) ||
            groups.length === 0
        ) {
            return null
        }

        try {
            return await this.ctx.chatluna.withUsageSource(
                'chatluna-livingmemory',
                async () => {
                    const embeddings = await this.ctx.chatluna.createEmbeddings(
                        this.config.embeddingModel
                    )
                    if (embeddings?.value == null) {
                        this.debug(
                            'memory dream embedding unavailable, fallback to keyword clusters'
                        )
                        return null
                    }

                    const entries = unique(
                        groups.flatMap((group) => group.entries)
                    )
                    const vectorById = await ensureEntryEmbeddings(
                        embeddings.value,
                        this.repository,
                        this.config.embeddingModel,
                        entries,
                        {
                            logger: this.ctx.logger('chatluna-livingmemory'),
                            debug: (message) => this.debug(message)
                        }
                    )

                    const refined: CandidateGroup[] = []
                    for (const group of groups) {
                        const unionFind = new UnionFind(
                            group.entries.map((entry) => entry.id)
                        )

                        for (
                            let leftIndex = 0;
                            leftIndex < group.entries.length;
                            leftIndex++
                        ) {
                            for (
                                let rightIndex = leftIndex + 1;
                                rightIndex < group.entries.length;
                                rightIndex++
                            ) {
                                const left = group.entries[leftIndex]
                                const right = group.entries[rightIndex]
                                const similarity = cosineSimilarity(
                                    vectorById.get(left.id) ?? [],
                                    vectorById.get(right.id) ?? []
                                )

                                if (
                                    similarity >=
                                        EMBEDDING_SIMILARITY_THRESHOLD ||
                                    (left.type === right.type &&
                                        keywordOverlap(left, right) >=
                                            STRONG_KEYWORD_OVERLAP)
                                ) {
                                    unionFind.union(left.id, right.id)
                                }
                            }
                        }

                        for (const entries of unionFind.groups(group.entries)) {
                            refined.push({
                                reason: `embedding:${group.reason}`,
                                entries
                            })
                        }
                    }

                    return this.dedupeGroups(refined)
                }
            )
        } catch (error) {
            this.debug(
                [
                    'memory dream embedding failed, fallback to keyword clusters',
                    `error=${summarizeError(error)}`
                ].join(' ')
            )
            return null
        }
    }

    private toDreamClusters(groups: CandidateGroup[]): DreamCluster[] {
        const clusters: DreamCluster[] = []
        const seen = new Set<string>()

        for (const group of groups) {
            const sorted = [...group.entries].sort(
                (left, right) =>
                    toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt)
            )
            for (
                let index = 0;
                index < sorted.length - 1;
                index += MAX_CLUSTER_SIZE
            ) {
                const entries = sorted.slice(index, index + MAX_CLUSTER_SIZE)
                const key = entries
                    .map((entry) => entry.id)
                    .sort()
                    .join('|')
                if (seen.has(key)) {
                    continue
                }

                seen.add(key)
                clusters.push({
                    id: `cluster-${clusters.length + 1}`,
                    reason: group.reason,
                    entries
                })
                if (clusters.length >= MAX_DREAM_CLUSTERS) {
                    return clusters
                }
            }
        }

        return clusters
    }

    private buildPrompt(
        presetId: string,
        cluster: DreamCluster,
        stage: DreamStage
    ) {
        const activeOperationGuide = [
            '可执行操作：',
            '- keep：记忆彼此不重复，保持不变。',
            '- update：某条 active 记忆需要补充信息增量，保持同一条记忆的基本身份。',
            '- merge：多条 active 记忆描述同一对象、同一状态或同一关系画像时，选择一条作为 target，写成更完整的新正文；其余 source 会被代码层自动改为 archived 历史记录。',
            '- archive：某条 active 记忆已经过时或与新状态冲突，把它改写为历史阶段记录。',
            '- active 阶段禁止物理删除记忆。'
        ]
        const archivedOperationGuide = [
            '可执行操作：',
            '- keep：历史记录彼此不重复，保持不变。',
            '- update：某条 archived 历史记录需要补充归档语义，仍然保持 archived。',
            '- merge：多条 archived 历史记录描述同一历史阶段、同一对象或同一关系变化时，选择一条作为 target，压缩成更完整的 archived 历史档案；其余 source 会被代码层物理删除。',
            '- deleteSource：只用于声明 merge 的 source 可以删除；代码层只会删除成功 merge 的 source，独立 deleteSource 会被跳过。',
            '- archived 阶段禁止恢复为 active，也禁止使用 archive 操作。'
        ]
        const activeFormat = [
            '{"operations":[',
            '{"action":"keep","memoryIds":["..."],"reason":"..."},',
            '{"action":"update","memoryId":"...","memory":',
            '{"type":"fact","content":"...","summary":"...",',
            '"keywords":["..."],"sentiment":"...","importance":0.5},',
            '"reason":"..."},',
            '{"action":"merge","targetMemoryId":"...",',
            '"sourceMemoryIds":["..."],"memory":',
            '{"type":"fact","content":"...","summary":"...",',
            '"keywords":["..."],"sentiment":"...","importance":0.8},',
            '"reason":"..."},',
            '{"action":"archive","memoryId":"...","memory":',
            '{"content":"...","summary":"...",',
            '"keywords":["..."],"sentiment":"...",',
            '"importance":0.3},"reason":"..."}]}'
        ].join('')
        const archivedFormat = [
            '{"operations":[',
            '{"action":"keep","memoryIds":["..."],"reason":"..."},',
            '{"action":"update","memoryId":"...","memory":',
            '{"type":"fact","content":"...","summary":"...",',
            '"keywords":["..."],"sentiment":"...","importance":0.4},',
            '"reason":"..."},',
            '{"action":"merge","targetMemoryId":"...",',
            '"sourceMemoryIds":["..."],"memory":',
            '{"type":"fact","content":"...","summary":"...",',
            '"keywords":["..."],"sentiment":"...","importance":0.5},',
            '"reason":"..."},',
            '{"action":"deleteSource","targetMemoryId":"...",',
            '"sourceMemoryIds":["..."],',
            '"reason":"merge source 已压缩进 target"}]}'
        ].join('')

        return [
            '你是长期记忆 Dream 档案员。',
            '你的任务是整理同一 preset 下已有的记忆条目，而不是重新创作新记忆。',
            '你只能基于下面给出的记忆条目做判断，禁止引入条目之外的新事实。',
            stage === 'active'
                ? '当前阶段只处理 active 记忆：目标是软整理当前可召回记忆，保留关系演化痕迹。'
                : '当前阶段只处理 archived 历史记录：目标是真正压缩历史档案，减少重复归档。',
            '',
            `presetId=${presetId}`,
            `stage=${stage}`,
            `clusterId=${cluster.id}`,
            `clusterReason=${cluster.reason}`,
            '',
            ...(stage === 'active'
                ? activeOperationGuide
                : archivedOperationGuide),
            '',
            '合并判断依据：',
            '1. 事实一致性：同一对象同一状态的信息应合并。',
            '2. 信息增量：新记忆提供旧记忆没有的维度时，应补充而不是丢弃。',
            '3. 时间权重与冲突：出现矛盾时以较新的状态为有效值，旧状态应 archive 为 archived。',
            '4. importance 越高越应保留为 target 或被认真整合；sentiment 用于判断情绪和关系阶段。',
            '',
            '输出必须是可解析 JSON，不要解释，不要 Markdown。',
            '格式：',
            stage === 'active' ? activeFormat : archivedFormat,
            '',
            '字段要求：',
            '- content 是最终会注入给 preset 的记忆正文，应保持第一人称关系视角。字数保持在100字以内。',
            '- summary 是检索友好的简短摘要，不要写成角色台词。',
            '- keywords 是短词数组，最多 12 个。',
            '- 不要在 content、summary 或 keywords 中写入“历史记录”、“已合并”等状态或整理标记；归档状态由 status 字段表达。',
            '- sentiment 是简短自由文本。',
            '- importance 必须是 0 到 1 的数字。',
            '- 所有 memoryId、targetMemoryId、sourceMemoryIds 必须来自下面的 id。',
            stage === 'archived'
                ? '- archived 阶段输出的 memory 不能包含 active 状态；即使包含也会被代码层强制保持 archived。'
                : '- active 阶段的 update / merge target 会被代码层强制保持 active。',
            '',
            '记忆条目：',
            cluster.entries.map(toPromptEntry).join('\n\n---\n\n')
        ].join('\n')
    }

    private parseOperations(output: string): DreamOperation[] {
        const parsed = this.parseJson(output)
        const operations = Array.isArray(parsed)
            ? parsed
            : parsed != null &&
                typeof parsed === 'object' &&
                Array.isArray((parsed as Record<string, unknown>).operations)
              ? (parsed as { operations: unknown[] }).operations
              : []

        return operations
            .map((operation): DreamOperation | null => {
                if (operation == null || typeof operation !== 'object') {
                    return null
                }

                const record = operation as Record<string, unknown>
                if (
                    record.action !== 'keep' &&
                    record.action !== 'merge' &&
                    record.action !== 'update' &&
                    record.action !== 'archive' &&
                    record.action !== 'deleteSource'
                ) {
                    return null
                }

                return record as unknown as DreamOperation
            })
            .filter(
                (operation): operation is DreamOperation => operation != null
            )
    }

    private parseJson(output: string): unknown {
        const normalized = output.trim()
        const objectStart = normalized.indexOf('{')
        const objectEnd = normalized.lastIndexOf('}')
        const arrayStart = normalized.indexOf('[')
        const arrayEnd = normalized.lastIndexOf(']')

        const useObject =
            objectStart >= 0 &&
            objectEnd > objectStart &&
            (arrayStart < 0 || objectStart < arrayStart)

        const raw = useObject
            ? normalized.slice(objectStart, objectEnd + 1)
            : arrayStart >= 0 && arrayEnd > arrayStart
              ? normalized.slice(arrayStart, arrayEnd + 1)
              : ''

        if (raw.length === 0) {
            return null
        }

        try {
            return JSON.parse(raw)
        } catch {
            return null
        }
    }

    private async executeOperations(
        stage: DreamStage,
        cluster: DreamCluster,
        operations: DreamOperation[],
        touchedMemoryIds: Set<string>
    ): Promise<DreamOperationStats> {
        const stats = this.createEmptyStats()
        const entryById = new Map(
            cluster.entries.map((entry) => [entry.id, entry])
        )
        const mergeDeletedSourceIds = new Set<string>()

        for (const operation of operations) {
            if (
                !this.isActionAllowed(stage, operation.action) ||
                !this.operationIdsWithinCluster(operation, entryById)
            ) {
                stats.skipped++
                continue
            }

            switch (operation.action) {
                case 'keep':
                    stats.kept++
                    break
                case 'update':
                    await this.executeUpdate(
                        stage,
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats
                    )
                    break
                case 'archive':
                    await this.executeArchive(
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats
                    )
                    break
                case 'merge':
                    await this.executeMerge(
                        stage,
                        operation,
                        entryById,
                        touchedMemoryIds,
                        stats,
                        mergeDeletedSourceIds
                    )
                    break
                case 'deleteSource':
                    this.executeDeleteSource(
                        operation,
                        mergeDeletedSourceIds,
                        stats
                    )
                    break
            }
        }

        return stats
    }

    private isActionAllowed(stage: DreamStage, action: DreamAction) {
        if (stage === 'active') {
            return (
                action === 'keep' ||
                action === 'update' ||
                action === 'merge' ||
                action === 'archive'
            )
        }

        return (
            action === 'keep' ||
            action === 'update' ||
            action === 'merge' ||
            action === 'deleteSource'
        )
    }

    private operationIdsWithinCluster(
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>
    ) {
        return this.extractOperationIds(operation).every((id) =>
            entryById.has(id)
        )
    }

    private extractOperationIds(operation: DreamOperation) {
        return unique(
            [
                operation.memoryId,
                operation.targetMemoryId,
                ...(Array.isArray(operation.memoryIds)
                    ? operation.memoryIds
                    : []),
                ...(Array.isArray(operation.sourceMemoryIds)
                    ? operation.sourceMemoryIds
                    : [])
            ].filter((id): id is string => typeof id === 'string')
        )
    }

    private executeDeleteSource(
        operation: DreamOperation,
        mergeDeletedSourceIds: Set<string>,
        stats: DreamOperationStats
    ) {
        const sourceIds = Array.isArray(operation.sourceMemoryIds)
            ? operation.sourceMemoryIds.filter(
                  (id): id is string => typeof id === 'string'
              )
            : []
        if (
            sourceIds.length === 0 ||
            !sourceIds.every((id) => mergeDeletedSourceIds.has(id))
        ) {
            stats.skipped++
        }
    }

    private async executeUpdate(
        stage: DreamStage,
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null || touchedMemoryIds.has(entry.id)) {
            stats.skipped++
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory, entry)
        if (Object.keys(patch).length === 0) {
            stats.skipped++
            return
        }

        await this.repository.updateMemory(
            entry.id,
            this.prepareStagePatch(stage, patch)
        )
        touchedMemoryIds.add(entry.id)
        stats.updated++
    }

    private async executeArchive(
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats
    ) {
        const memoryId = operation.memoryId
        const entry =
            typeof memoryId === 'string' ? entryById.get(memoryId) : null
        if (entry == null || touchedMemoryIds.has(entry.id)) {
            stats.skipped++
            return
        }

        await this.archiveMemory(
            entry,
            touchedMemoryIds,
            this.sanitizeMemoryPatch(operation.memory, entry)
        )
        stats.archived++
    }

    private async executeMerge(
        stage: DreamStage,
        operation: DreamOperation,
        entryById: Map<string, MemoryEntryRecord>,
        touchedMemoryIds: Set<string>,
        stats: DreamOperationStats,
        mergeDeletedSourceIds: Set<string>
    ) {
        const targetId = operation.targetMemoryId
        const target =
            typeof targetId === 'string' ? entryById.get(targetId) : null
        const sourceIds = unique(
            [
                ...(Array.isArray(operation.sourceMemoryIds)
                    ? operation.sourceMemoryIds
                    : []),
                ...(Array.isArray(operation.memoryIds)
                    ? operation.memoryIds
                    : []),
                targetId
            ].filter((id): id is string => typeof id === 'string')
        )
        const sources = sourceIds
            .map((id) => entryById.get(id))
            .filter((entry): entry is MemoryEntryRecord => entry != null)

        if (
            target == null ||
            sources.length < 2 ||
            sources.some((entry) => touchedMemoryIds.has(entry.id))
        ) {
            stats.skipped++
            return
        }

        const patch = this.sanitizeMemoryPatch(operation.memory, target)
        if (patch.content == null || patch.content.trim().length === 0) {
            stats.skipped++
            return
        }
        patch.importance = Math.max(
            patch.importance ?? 0,
            ...sources.map((source) => source.importance ?? 0.5)
        )
        patch.keywords = unique([
            ...(patch.keywords ?? []),
            ...sources.flatMap((source) => source.keywords)
        ]).slice(0, 12)

        await this.repository.updateMemory(
            target.id,
            this.prepareStagePatch(stage, patch)
        )
        touchedMemoryIds.add(target.id)
        stats.merged++

        for (const source of sources) {
            if (source.id === target.id || touchedMemoryIds.has(source.id)) {
                continue
            }

            if (stage === 'archived') {
                await this.repository.deleteMemory(source.id)
                touchedMemoryIds.add(source.id)
                mergeDeletedSourceIds.add(source.id)
                stats.deleted++
            } else {
                await this.archiveMemory(source, touchedMemoryIds, {
                    status: 'archived',
                    content: source.content,
                    summary: source.summary,
                    keywords: source.keywords,
                    sentiment: source.sentiment,
                    importance: Math.min(source.importance ?? 0.5, 0.35)
                })
                stats.archived++
            }
        }
    }

    private async archiveMemory(
        entry: MemoryEntryRecord,
        touchedMemoryIds: Set<string>,
        patch: Partial<MemoryMutationInput>
    ) {
        await this.repository.updateMemory(entry.id, {
            ...patch,
            status: 'archived',
            content: normalizeText(patch.content ?? entry.content),
            summary:
                patch.summary ?? entry.summary ?? entry.content.slice(0, 80),
            keywords: unique(
                patch.keywords?.length ? patch.keywords : entry.keywords
            ).slice(0, 12),
            sentiment: patch.sentiment ?? entry.sentiment,
            importance:
                patch.importance ?? Math.min(entry.importance ?? 0.5, 0.35)
        })
        touchedMemoryIds.add(entry.id)
    }

    private prepareStagePatch(
        stage: DreamStage,
        patch: Partial<MemoryMutationInput>
    ): Partial<MemoryMutationInput> {
        if (stage === 'active') {
            return {
                ...patch,
                status: 'active'
            }
        }

        return {
            ...patch,
            status: 'archived'
        }
    }

    private sanitizeMemoryPatch(
        memory: Record<string, unknown> | undefined,
        fallback: MemoryEntryRecord
    ): Partial<MemoryMutationInput> {
        if (memory == null || typeof memory !== 'object') {
            return {}
        }

        const patch: Partial<MemoryMutationInput> = {}
        if (typeof memory.type === 'string' && isMemoryEntryType(memory.type)) {
            patch.type = memory.type
        }

        if (typeof memory.content === 'string') {
            const content = normalizeText(memory.content)
            if (content.length > 0) {
                patch.content = content
            }
        }

        if (typeof memory.summary === 'string') {
            const summary = normalizeText(memory.summary)
            patch.summary = summary.length > 0 ? summary : null
        }

        if (Array.isArray(memory.keywords)) {
            const keywords = unique(
                memory.keywords
                    .filter(
                        (keyword): keyword is string =>
                            typeof keyword === 'string'
                    )
                    .map(normalizeText)
                    .filter(Boolean)
            ).slice(0, 12)
            if (keywords.length > 0) {
                patch.keywords = keywords
            }
        }

        if (typeof memory.sentiment === 'string') {
            const sentiment = normalizeText(memory.sentiment)
            patch.sentiment = sentiment.length > 0 ? sentiment : null
        }

        if (Object.prototype.hasOwnProperty.call(memory, 'importance')) {
            patch.importance = parseImportance(memory.importance)
        }

        if (patch.content != null && patch.keywords == null) {
            patch.keywords = fallback.keywords
        }

        return patch
    }

    private createResult(
        entryCount: number,
        clusterCount: number,
        options: {
            detail: string
            skippedReason?: string
        }
    ): DreamRunResult {
        return {
            entryCount,
            clusterCount,
            kept: 0,
            merged: 0,
            updated: 0,
            archived: 0,
            deleted: 0,
            skipped: 0,
            skippedReason: options.skippedReason,
            detail: options.detail
        }
    }
}
