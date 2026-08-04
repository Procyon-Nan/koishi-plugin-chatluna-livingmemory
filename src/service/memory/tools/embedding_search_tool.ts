import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { Context } from 'koishi'
import type { z } from 'zod'
import type { LivingMemoryConfig } from '../../../contracts/workflows'
import {
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxKeywordCount,
    memorySearchMaxTextCount,
    searchKeywordRule,
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
    '在你的记忆库中搜索记忆。',
    '',
    '当你需要查找自己的记忆时使用此工具。',
    `- searchTexts：必填 JSON 数组，包含 1 到 ${memorySearchMaxTextCount} 条语义查询短语，` +
        `每条在去除首尾空白后须为 ${formatSearchTextLengthRange(searchTextRule)} 个字符。` +
        '必须包含完整的句子结构（如主谓宾、人物+动作+场景、主语+的+形容词等），' +
        '使用第一人称的自然语言描述。不同短语应覆盖不同的语义角度。',
    `- searchKeywords：选填 JSON 数组，最多 ${memorySearchMaxKeywordCount} 个精确关键词，` +
        `每个在去除首尾空白后须为 ${formatSearchTextLengthRange(searchKeywordRule)} 个字符。` +
        '关键词应为具体的事物、活动、地点等实体名称，不应是完整句子。' +
        '禁止使用用户昵称、用户名或称呼作为关键词，这类词匹配无意义。',
    '- memoryTypes：必填 JSON 数组，包含记忆类别；也可传 ["all"] 搜索全部类别。',
    '- 直接传递数组，禁止把数组编码成 JSON 字符串。',
    '- 本工具返回的记忆条目依照计算后的相关度得分排序。'
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
                    texts: input.searchTexts,
                    keywords: input.searchKeywords ?? []
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
