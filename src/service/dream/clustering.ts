import { Context } from 'koishi'
import type {
    LivingMemoryConfig,
    MemoryEntryRecord,
    MemoryEntryType
} from '../../types'
import type { LivingMemoryRepository } from '../repository'
import { ensureEntryEmbeddings } from '../shared/embeddings'
import {
    cosineSimilarity,
    isModelConfigured,
    summarizeError
} from '../shared/utils'
import type { CandidateGroup, DreamCluster } from './types'
import {
    EMBEDDING_SIMILARITY_THRESHOLD,
    keywordOverlap,
    MAX_BUCKET_SIZE,
    MAX_CLUSTER_SIZE,
    MAX_DREAM_CLUSTERS,
    neutralSentiments,
    normalizeTerm,
    STRONG_KEYWORD_OVERLAP,
    toMonthBucket,
    toTimestamp,
    UnionFind,
    unique
} from './util'

export class DreamClusterer {
    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly repository: LivingMemoryRepository,
        private readonly debug: (message: string) => void
    ) {}

    async buildClusters(entries: MemoryEntryRecord[]): Promise<DreamCluster[]> {
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
            const embeddings = await this.ctx.chatluna.createEmbeddings(
                this.config.embeddingModel
            )
            if (embeddings?.value == null) {
                this.debug(
                    'memory dream embedding unavailable, fallback to keyword clusters'
                )
                return null
            }

            const entries = unique(groups.flatMap((group) => group.entries))

            // Dream 无天然查询向量作维度锚，用一条代表性条目现算一次以探测当前
            // 模型的输出维度，使维度不一致的旧缓存向量失效重算（详见 ensureEntryEmbeddings）。
            let expectedDimension = 0
            const probeEntry = entries[0]
            if (probeEntry != null) {
                try {
                    const probeVector = await embeddings.value.embedQuery(
                        probeEntry.content
                    )
                    expectedDimension = probeVector.length
                } catch (error) {
                    this.debug(
                        `memory dream embedding dimension probe failed: ${summarizeError(error)}`
                    )
                }
            }

            const vectorById = await ensureEntryEmbeddings(
                embeddings.value,
                this.repository,
                this.config.embeddingModel,
                entries,
                {
                    logger: this.ctx.logger('chatluna-livingmemory'),
                    debug: (message) => this.debug(message),
                    expectedDimension
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
                            similarity >= EMBEDDING_SIMILARITY_THRESHOLD ||
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
}
