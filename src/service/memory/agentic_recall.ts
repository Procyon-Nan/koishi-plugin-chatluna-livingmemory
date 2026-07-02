import type { Context } from 'koishi'
import type {
    AgenticMemorySearchToolCallSummary,
    AgenticMemorySnapshotItem,
    AgenticMemorySnapshotMemoryItem,
    LivingMemoryConfig,
    LivingMemorySearchInput,
    LivingMemoryTranscriptMessage,
    MemoryScope
} from '../../types'
import { LivingMemoryMessageFormatter } from '../message_formatter'
import {
    buildAgenticRecallFinalPrompt,
    buildAgenticRecallPlanPrompt
} from '../prompts'
import { isModelConfigured, stringifyModelContent } from '../shared/utils'
import type { LivingMemoryRepository } from '../repository'
import { searchLivingMemoryEntries } from './search'
import type { DebugLogger } from './helpers'
import { livingMemorySearchInputSchema } from './search_contract'

const parseToolInputJson = (output: string): unknown => {
    return JSON.parse(output)
}

const parseToolInput = (parsed: unknown): LivingMemorySearchInput => {
    const input = livingMemorySearchInputSchema.parse(parsed)

    return {
        broadSearchTexts: input.broadSearchTexts,
        specificSearchTexts: input.specificSearchTexts,
        memoryTypes: input.memoryTypes
    }
}

const toPresetLabel = (scope: MemoryScope) => {
    return scope.presetLabel?.trim() || scope.presetId
}

const copyMatchedMemory = (
    item: AgenticMemorySnapshotMemoryItem
): AgenticMemorySnapshotMemoryItem => ({
    type: item.type,
    content: item.content,
    keywords: [...item.keywords],
    summary: item.summary,
    importance: item.importance,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    matchedBroadSearchTexts: [...item.matchedBroadSearchTexts],
    matchedSpecificSearchTexts: [...item.matchedSpecificSearchTexts]
})

const uniqueTexts = (groups: string[][]) => {
    return [...new Set(groups.flat())]
}

export interface LivingMemoryAgenticRecallTrace {
    planPrompt: string
    planOutput: string
    finalPrompt: string | null
    finalOutput: string | null
    item: AgenticMemorySnapshotItem
}

export class LivingMemoryAgenticRecallExecutor {
    private readonly formatter = new LivingMemoryMessageFormatter()

    constructor(
        private readonly ctx: Context,
        private readonly config: LivingMemoryConfig,
        private readonly repository: LivingMemoryRepository,
        private readonly debug: DebugLogger
    ) {}

    async run(
        scope: MemoryScope,
        currentMessage: LivingMemoryTranscriptMessage,
        historyMessages: LivingMemoryTranscriptMessage[]
    ): Promise<LivingMemoryAgenticRecallTrace> {
        if (!isModelConfigured(this.config.agenticRecallModel)) {
            throw new Error('agenticRecallModel is not configured.')
        }

        const model = await this.ctx.chatluna.createChatModel(
            this.config.agenticRecallModel
        )
        if (model.value == null) {
            throw new Error('agenticRecallModel is unavailable.')
        }

        const presetLabel = toPresetLabel(scope)
        const currentTranscript = this.formatter.toExtractionPayload([
            currentMessage
        ]).input
        const recentMessages = this.formatter.takeRecentRounds(
            historyMessages,
            this.config.recallHistoryWindowRounds
        )
        const history = recentMessages.length
            ? this.formatter.toExtractionPayload(recentMessages).input
            : '无'

        const planPrompt = buildAgenticRecallPlanPrompt({
            presetLabel,
            currentTranscript,
            history
        })
        const planResult = await model.value.invoke(planPrompt)
        const planOutput = stringifyModelContent(planResult.content).trim()
        this.debug(
            [
                `memory agentic recall plan: conversationId=${scope.conversationId}`,
                `presetId=${scope.presetId}`,
                planPrompt,
                'output:',
                planOutput
            ].join('\n')
        )

        const toolInputJson = parseToolInputJson(planOutput)
        this.debug(
            [
                'living_memory_search input:',
                `presetId=${scope.presetId}`,
                `conversationId=${scope.conversationId}`,
                `userId=${scope.userId ?? ''}`,
                'source=agentic-recall',
                JSON.stringify(toolInputJson, null, 2)
            ].join('\n')
        )

        const toolInput = parseToolInput(toolInputJson)
        const toolCallSummary: AgenticMemorySearchToolCallSummary = {
            broadSearchTexts: toolInput.broadSearchTexts,
            specificSearchTexts: toolInput.specificSearchTexts,
            memoryTypes: toolInput.memoryTypes,
            maxCandidates: this.config.memorySearchToolMaxResults
        }

        const entries = await this.repository.listEntriesByPreset(
            scope.presetId
        )

        const matchedMemories = searchLivingMemoryEntries(entries, {
            ...toolInput,
            maxCandidates: this.config.memorySearchToolMaxResults
        }).map(copyMatchedMemory)
        this.debug(
            [
                'living_memory_search output:',
                `presetId=${scope.presetId}`,
                `conversationId=${scope.conversationId}`,
                `userId=${scope.userId ?? ''}`,
                'source=agentic-recall',
                `resultCount=${matchedMemories.length}`,
                JSON.stringify(matchedMemories, null, 2)
            ].join('\n')
        )

        const matchedBroadSearchTexts = uniqueTexts(
            matchedMemories.map((item) => item.matchedBroadSearchTexts)
        )
        const matchedSpecificSearchTexts = uniqueTexts(
            matchedMemories.map((item) => item.matchedSpecificSearchTexts)
        )

        let finalPrompt: string | null = null
        let finalOutput: string | null = null
        let finalText = ''
        if (matchedMemories.length > 0) {
            finalPrompt = buildAgenticRecallFinalPrompt({
                presetLabel,
                currentTranscript,
                history,
                toolCallSummary,
                matchedMemories
            })
            const finalResult = await model.value.invoke(finalPrompt)
            finalOutput = stringifyModelContent(finalResult.content).trim()
            this.debug(
                [
                    `memory agentic recall final: conversationId=${scope.conversationId}`,
                    `presetId=${scope.presetId}`,
                    finalPrompt,
                    'output:',
                    finalOutput
                ].join('\n')
            )
            if (finalOutput.length === 0) {
                throw new Error('agentic recall final output is empty.')
            }
            finalText = finalOutput
        }

        return {
            planPrompt,
            planOutput,
            finalPrompt,
            finalOutput,
            item: {
                finalText,
                toolCallSummary,
                matchedBroadSearchTexts,
                matchedSpecificSearchTexts,
                matchedMemories
            }
        }
    }
}
