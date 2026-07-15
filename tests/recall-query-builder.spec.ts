import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import { LivingMemoryRecallQueryBuilder } from '../src/service/workflows/recall/query_builder'
import { currentMessage, scope } from './workflow-test-utils'

it('does not recognize [skip] as a recall rewrite control value', async () => {
    const ctx = {
        chatluna: {
            createChatModel: async () => ({
                value: {
                    invoke: async () => ({ content: '[skip]' })
                }
            })
        }
    } as unknown as Context
    const builder = new LivingMemoryRecallQueryBuilder(ctx, {
        enableRecallQueryRewrite: true,
        recallHistoryWindowRounds: 3,
        recallRewriteModel: 'test-model'
    })

    const result = await builder.resolve(scope, currentMessage, [])

    assert.equal(result.finalQuery, '[skip]')
    assert.equal(result.fallbackReason, null)
    assert.match(result.rewritePrompt ?? '', /不得输出 \[skip\]/u)
})
