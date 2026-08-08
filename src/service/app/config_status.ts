import type {
    LivingMemoryConfig,
    MemoryConfigWarning,
    MemoryServiceStatus
} from '../../contracts/workflows'
import type { MemoryVectorIndexStatus } from '../../contracts/vector_index'
import { isModelConfigured } from '../shared/utils'

export const validateLivingMemoryConfig = (
    config: LivingMemoryConfig
): MemoryConfigWarning[] => {
    const warnings: MemoryConfigWarning[] = []

    if (
        config.recallStrategy === 'embedding-rerank' &&
        !isModelConfigured(config.embeddingModel)
    ) {
        warnings.push({
            code: 'embedding-model-missing',
            field: 'embeddingModel',
            message: '未配置 embeddingModel；记忆召回将失败。'
        })
    }
    if (
        config.recallStrategy === 'embedding-rerank' &&
        !isModelConfigured(config.rerankModel)
    ) {
        warnings.push({
            code: 'rerank-model-missing',
            field: 'rerankModel',
            message: '未配置 rerankModel；记忆召回将失败。'
        })
    }

    if (config.extractionInterval > 0 && !isModelConfigured(config.mainModel)) {
        warnings.push({
            code: 'extract-model-missing',
            field: 'mainModel',
            message:
                '自动记忆提取已启用（extractionInterval > 0），但未配置 mainModel；提取流程将被跳过。'
        })
    }

    if (
        config.recallStrategy === 'embedding-rerank' &&
        config.enableRecallQueryRewrite &&
        !isModelConfigured(config.subModel)
    ) {
        warnings.push({
            code: 'recall-rewrite-model-missing',
            field: 'subModel',
            message: '召回查询改写已启用，但未配置 subModel；将回退到原始查询。'
        })
    }

    if (
        config.recallStrategy === 'agentic-recall' &&
        !isModelConfigured(config.subModel)
    ) {
        warnings.push({
            code: 'agentic-recall-model-missing',
            field: 'subModel',
            message:
                'agentic-recall 已启用，但未配置 subModel；记忆召回将失败。'
        })
    }

    if (
        config.recallStrategy === 'agentic-recall' &&
        !isModelConfigured(config.embeddingModel)
    ) {
        warnings.push({
            code: 'embedding-model-missing',
            field: 'embeddingModel',
            message:
                'agentic-recall 已启用，但未配置 embeddingModel；记忆召回将失败。'
        })
    }

    if (config.enableAutoDream && !isModelConfigured(config.mainModel)) {
        warnings.push({
            code: 'auto-dream-model-missing',
            field: 'mainModel',
            message:
                '自动 Dream 已启用，但未配置 mainModel；自动 Dream 任务将失败。'
        })
    }
    if (config.enableAutoDream && !isModelConfigured(config.embeddingModel)) {
        warnings.push({
            code: 'auto-dream-embedding-model-missing',
            field: 'embeddingModel',
            message:
                '自动 Dream 已启用，但未配置 embeddingModel；自动 Dream 任务将失败。'
        })
    }

    return warnings
}

export const createLivingMemoryServiceStatus = (
    config: LivingMemoryConfig,
    vectorIndex: MemoryVectorIndexStatus
): MemoryServiceStatus => {
    return {
        warnings: validateLivingMemoryConfig(config),
        vectorIndex
    }
}
