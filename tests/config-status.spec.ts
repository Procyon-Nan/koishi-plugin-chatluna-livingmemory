import assert from 'node:assert/strict'
import type { LivingMemoryConfig } from '../src/contracts/workflows'
import { validateLivingMemoryConfig } from '../src/service/app/config_status'

const createConfig = (
    overrides: Partial<LivingMemoryConfig> = {}
): LivingMemoryConfig => ({
    enableSnapshotInjection: true,
    enableUserProfileInjection: false,
    recallStrategy: 'embedding-rerank',
    mainModel: '',
    subModel: '',
    enableAutoDream: false,
    autoDreamMemoryGrowthThreshold: 30,
    userProfileMemoryLimit: 20,
    enableRecallQueryRewrite: false,
    recallHistoryWindowRounds: 3,
    embeddingModel: 'test/embedding',
    rerankModel: '',
    extractionRounds: 10,
    extractionInterval: 0,
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
