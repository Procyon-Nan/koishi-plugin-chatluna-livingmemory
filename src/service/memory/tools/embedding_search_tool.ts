import { StructuredTool } from '@langchain/core/tools'
import type { ToolRunnableConfig } from '@langchain/core/tools'
import type { LivingMemorySearchProvider } from '../../../contracts/workflows'
import {
    formatSearchTextLengthRange,
    livingMemorySearchInputSchema,
    livingMemorySearchToolName,
    memorySearchMaxKeywordCount,
    memorySearchMaxTextCount,
    searchKeywordRule,
    searchTextRule,
    type LivingMemorySearchToolInput
} from './search_contract'
import {
    describeLivingMemoryToolScopeFailure,
    getLivingMemoryToolConfigurable,
    resolveToolMemoryPresetId
} from './tool_runtime'
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
    '- 直接传递数组，禁止把数组编码成 JSON 字符串。',
    '- 本工具返回的记忆条目依照计算后的相关度得分排序。'
].join('\n')

export class LivingMemorySearchTool extends StructuredTool {
    name = livingMemorySearchToolName
    description = livingMemorySearchToolDescription

    schema = livingMemorySearchInputSchema

    constructor(private readonly searchProvider: LivingMemorySearchProvider) {
        super({ verboseParsingErrors: true })
    }

    async _call(
        input: LivingMemorySearchToolInput,
        _runManager: unknown,
        runConfig?: ToolRunnableConfig
    ) {
        const configurable = getLivingMemoryToolConfigurable(runConfig)
        const presetIdResolution = resolveToolMemoryPresetId(configurable)
        if (presetIdResolution.ok === false) {
            throw new Error(
                describeLivingMemoryToolScopeFailure(presetIdResolution.reason)
            )
        }

        const results = await this.searchProvider.searchMemories(
            presetIdResolution.presetId,
            { ...input, memoryTypes: ['all'] }
        )

        return JSON.stringify(results, null, 2)
    }
}
