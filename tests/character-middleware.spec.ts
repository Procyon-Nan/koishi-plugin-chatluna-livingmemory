import assert from 'node:assert/strict'
import { Context } from 'koishi'
import { apply as applyCharacterMiddleware } from '../src/plugins/character_middleware'
import type { LivingMemoryConfig } from '../src/contracts/workflows'
import { LivingMemoryLogger } from '../src/service/logging/logger'

it('clears extraction state when Character integration unloads', async () => {
    const ctx = new Context({ baseDir: process.cwd() })
    let clearCalls = 0
    ctx.set('chatluna', {
        promptRenderer: {
            registerFunctionProvider: () => () => {}
        }
    } as never)
    ctx.set('chatluna_living_memory', {
        memoryLogger: new LivingMemoryLogger(
            { info: () => {}, warn: () => {}, error: () => {} } as never,
            () => false
        ),
        clearExtractionState: () => {
            clearCalls += 1
        }
    } as never)
    ctx.inject(
        ['chatluna', 'chatluna_living_memory', 'chatluna_character'],
        (injectedCtx) => {
            void applyCharacterMiddleware(injectedCtx, {
                debug: false
            } as LivingMemoryConfig)
        }
    )

    await ctx.start()
    try {
        const disposeCharacter = ctx.set('chatluna_character', {} as never)
        disposeCharacter()

        assert.equal(clearCalls, 1)
    } finally {
        await ctx.stop()
    }
})
