import type {
    LivingMemoryConfig,
    MemoryConfigWarning,
    MemoryServiceStatus
} from '../../types'
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

    if (
        config.extractionInterval > 0 &&
        !isModelConfigured(config.extractModel)
    ) {
        warnings.push({
            code: 'extract-model-missing',
            field: 'extractModel',
            message:
                '自动记忆提取已启用（extractionInterval > 0），但未配置 extractModel；提取流程将被跳过。'
        })
    }

    if (
        config.recallStrategy === 'embedding-rerank' &&
        config.enableRecallQueryRewrite &&
        !isModelConfigured(config.recallRewriteModel)
    ) {
        warnings.push({
            code: 'recall-rewrite-model-missing',
            field: 'recallRewriteModel',
            message:
                '召回查询改写已启用，但未配置 recallRewriteModel；将回退到原始查询。'
        })
    }

    if (
        config.recallStrategy === 'agentic-recall' &&
        !isModelConfigured(config.agenticRecallModel)
    ) {
        warnings.push({
            code: 'agentic-recall-model-missing',
            field: 'agenticRecallModel',
            message:
                'agentic-recall 已启用，但未配置 agenticRecallModel；记忆召回将失败。'
        })
    }

    if (config.enableAutoDream && !isModelConfigured(config.dreamModel)) {
        warnings.push({
            code: 'auto-dream-model-missing',
            field: 'dreamModel',
            message:
                '自动 Dream 已启用，但未配置 dreamModel；自动 Dream 任务将不会创建。'
        })
    }

    return warnings
}

export const createLivingMemoryServiceStatus = (
    config: LivingMemoryConfig
): MemoryServiceStatus => {
    return {
        warnings: validateLivingMemoryConfig(config)
    }
}
