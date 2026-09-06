import assert from 'node:assert/strict'
import { Context, Logger } from 'koishi'
import { apply as applyCharacterMiddleware } from '../src/plugins/character_middleware'
import type { LivingMemoryConfig } from '../src/contracts/workflows'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import { createTestContext } from './persistence-test-utils'

const setTestService = (ctx: Context, name: string, service: unknown) =>
    ctx.set(name, service)

const testConfig: LivingMemoryConfig = {
    enableSnapshotInjection: false,
    enableUserProfileInjection: false,
    recallStrategy: 'embedding-rerank',
    mainModel: 'test-model',
    subModel: 'test-model',
    enableAutoDream: false,
    autoDreamMemoryGrowthThreshold: 10,
    userProfileMinMemoryCount: 3,
    userProfileMemoryLimit: 5,
    enableRecallQueryRewrite: false,
    recallHistoryWindowRounds: 1,
    embeddingModel: 'test-model',
    rerankModel: 'test-model',
    extractionRounds: 1,
    extractionInterval: 0,
    enableExtractionWhitelist: false,
    extractionWhitelist: [],
    recallInterval: 5,
    recallTopK: 1,
    memorySearchToolMaxResults: 1,
    memorySearchMinSimilarity: 0,
    enableMemoryCreationTool: false,
    memoryCreateToolMaxMemories: 1,
    debug: false
}

it('clears extraction state when Character integration unloads', async () => {
    const ctx = createTestContext()
    let clearCalls = 0
    let clearRecallCalls = 0
    const chatluna = {
        promptRenderer: {
            registerFunctionProvider: () => () => true
        }
    } satisfies {
        promptRenderer: Pick<
            Context['chatluna']['promptRenderer'],
            'registerFunctionProvider'
        >
    }
    setTestService(ctx, 'chatluna', chatluna)
    const livingMemory = {
        memoryLogger: new LivingMemoryLogger(new Logger('test'), () => false),
        clearExtractionState: () => {
            clearCalls += 1
        },
        clearRecallState: () => {
            clearRecallCalls += 1
        }
    } satisfies Pick<
        Context['chatluna_living_memory'],
        'memoryLogger' | 'clearExtractionState' | 'clearRecallState'
    >
    setTestService(ctx, 'chatluna_living_memory', livingMemory)
    ctx.inject(
        ['chatluna', 'chatluna_living_memory', 'chatluna_character'],
        (injectedCtx) => {
            void applyCharacterMiddleware(injectedCtx, testConfig)
        }
    )

    await ctx.start()
    try {
        const disposeCharacter = setTestService(ctx, 'chatluna_character', {})
        disposeCharacter()

        assert.equal(clearCalls, 1)
        assert.equal(clearRecallCalls, 1)
    } finally {
        await ctx.stop()
    }
})
