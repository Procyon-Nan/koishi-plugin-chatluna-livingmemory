import assert from 'node:assert/strict'
import type { LivingMemoryConfig } from '../src/contracts/workflows'
import { validateLivingMemoryConfig } from '../src/service/app/config_status'

const createConfig = (
    overrides: Partial<LivingMemoryConfig> = {}
): LivingMemoryConfig => ({
    enableConversationIsolation: false,
    enableSnapshotInjection: true,
    enableUserProfileInjection: false,
    recallStrategy: 'embedding-rerank',
    mainModel: 'test-model',
    subModel: '',
    enableAutoDream: false,
    autoDreamMemoryGrowthThreshold: 30,
    userProfileMinMemoryCount: 3,
    userProfileMemoryLimit: 20,
    enableRecallQueryRewrite: false,
    recallIntervalMessages: 10,
    recallHistoryMessages: 20,
    embeddingModel: 'test/embedding',
    rerankModel: '',
    extractionWindowMessages: 30,
    extractionIncludeOverheard: false,
    enableExtractionWhitelist: false,
    extractionWhitelist: [],
    recallTopK: 5,
    memorySearchToolMaxResults: 30,
    memorySearchMinSimilarity: 0,
    enableMemoryCreationTool: false,
    memoryCreateToolMaxMemories: 10,
    debug: false,
    ...overrides
})

it('accepts embedding-rerank without an optional reranker', () => {
    const warnings = validateLivingMemoryConfig(createConfig())

    assert.deepEqual(warnings, [])
})

it('still warns when embedding-rerank has no embedding model', () => {
    const warnings = validateLivingMemoryConfig(
        createConfig({ embeddingModel: '' })
    )

    assert.deepEqual(warnings, [
        {
            code: 'embedding-model-missing',
            field: 'embeddingModel',
            message: '未配置 embeddingModel；记忆召回将失败。'
        }
    ])
})

it('warns when extraction is enabled without a main model', () => {
    const warnings = validateLivingMemoryConfig(
        createConfig({ mainModel: '', extractionWindowMessages: 30 })
    )

    assert.deepEqual(warnings, [
        {
            code: 'extract-model-missing',
            field: 'mainModel',
            message:
                '自动记忆提取已启用（extractionWindowMessages > 0），但未配置 mainModel；提取流程将被跳过。'
        }
    ])
})

it('does not warn about extraction when the extraction window is zero', () => {
    const warnings = validateLivingMemoryConfig(
        createConfig({ mainModel: '', extractionWindowMessages: 0 })
    )

    assert.deepEqual(warnings, [])
})
