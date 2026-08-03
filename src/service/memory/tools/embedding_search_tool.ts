import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxTextCount,
    searchTextRule
} from './search_contract'
import {
    getLivingMemoryToolConfigurable,
    LivingMemoryToolRuntime
} from './tool_runtime'
import type {
    EmbeddingSearchCache,
    LivingMemoryEmbeddingSearchEngine
} from '../../workflows/recall/embedding_search_engine'

type LivingMemorySearchToolConfig = Pick<
    LivingMemoryConfig,
    'debug' | 'memorySearchToolMaxResults'
>

export const livingMemorySearchToolDescription = [
    '在当前预设中按语义相似度搜索活跃记忆。',
    '',
    '当你需要按含义查找已有记忆、而非精确匹配措辞时使用此工具。',
    `- searchTexts：必填 JSON 数组，包含 1 到 ${memorySearchMaxTextCount} 条语义查询短语。` +
        `每条短语在去除首尾空白后须为 ${formatSearchTextLengthRange(searchTextRule)} 个字符。` +
        '使用宽泛的话题、具体的描述或事实性表述。',
    '- memoryTypes：必填 JSON 数组，包含记忆类别；也可传 ["all"] 搜索全部类别。',
    '- 直接传递数组，禁止把数组编码成 JSON 字符串。',
    '- 本工具基于嵌入向量余弦相似度搜索当前预设拥有的活跃记忆。',
    '- 结果按所有查询文本中的最高相似度得分排序。'
].join('\n')

type LivingMemorySearchToolInput = z.infer<typeof livingMemorySearchInputSchema>

export class LivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemorySearchToolDescription

    schema = livingMemorySearchInputSchema
    private readonly runtime: LivingMemoryToolRuntime

    constructor(
        private readonly engine: LivingMemoryEmbeddingSearchEngine,
        private readonly cache: EmbeddingSearchCache,
        ctx: Context,
        private readonly config: LivingMemorySearchToolConfig
    ) {
        super({ verboseParsingErrors: true })
        this.runtime = new LivingMemoryToolRuntime({
            toolName: livingMemorySearchToolName,
            logger: ctx.logger('chatluna-livingmemory'),
            isDebugEnabled: () => this.config.debug
        })
    }

    async _call(
        input: LivingMemorySearchToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = getLivingMemoryToolConfigurable(runConfig)
        const presetId = configurable?.preset

        this.runtime.logInput(configurable, input)

        if (typeof presetId !== 'string' || presetId.length === 0) {
            throw new Error('Missing preset in the current tool call.')
        }

        const results = await this.engine.search(
            {
                presetId,
                query: {
                    texts: input.searchTexts
                },
                memoryTypes: input.memoryTypes,
                maxCandidates: this.config.memorySearchToolMaxResults
            },
            this.cache
        )

        const output = JSON.stringify(results, null, 2)

        this.runtime.logOutput(configurable, output, [
            `resultCount=${results.length}`
        ])

        return output
    }
}
