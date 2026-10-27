import { strict as assert } from 'node:assert'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import {
    createLoggedModel,
    invokeLoggedModel
} from '../src/service/logging/model_calls'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'

const createLogger = (debug = false) => {
    const info: unknown[][] = []
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    return {
        log: new LivingMemoryLogger(
            {
                info: (...args: unknown[]) => info.push(args),
                warn: (...args: unknown[]) => warnings.push(args),
                error: (...args: unknown[]) => errors.push(args)
            } as never,
            () => debug
        ),
        info,
        warnings,
        errors
    }
}

it('formats stable event fields and escapes multiline content', () => {
    const captured = createLogger(true)
    captured.log
        .with({ presetId: '克子（Character）', workflow: 'recall' })
        .diagnostic('recall.snapshot.updated', {
            content: '第一行\n第二行',
            runId: 'run-1'
        })

    assert.equal(
        captured.info[0]?.[0],
        '事件：recall.snapshot.updated; workflow：recall; runId：run-1; ' +
            'presetId："克子（Character）"; content："第一行\\n第二行"'
    )
})

it('does not build diagnostic fields when debug logging is disabled', () => {
    const captured = createLogger(false)
    let built = false
    captured.log.diagnostic('test.diagnostic', () => {
        built = true
        return { value: 1 }
    })
    assert.equal(built, false)
    assert.equal(captured.info.length, 0)
})

it('redacts credential fields and handles circular values', () => {
    const captured = createLogger(true)
    const circular: Record<string, unknown> = { apiKey: 'secret' }
    circular['self'] = circular
    captured.log.diagnostic('test.payload', { circular })
    const message = String(captured.info[0]?.[0])
    assert.match(message, /"apiKey":"\[REDACTED\]"/u)
    assert.match(message, /"self":"\[Circular\]"/u)
    assert.doesNotMatch(message, /secret/u)
})

it('isolates sink failures from callers', () => {
    const warnings: unknown[][] = []
    const log = new LivingMemoryLogger(
        {
            info: () => {
                throw new Error('sink unavailable')
            },
            warn: (...args: unknown[]) => warnings.push(args),
            error: () => {}
        } as never,
        () => true
    )

    assert.doesNotThrow(() => log.diagnostic('test.failure'))
    assert.doesNotThrow(() => log.diagnostic('test.failure-again'))
    assert.equal(warnings.length, 1)
})

it('preserves withConfig invocation semantics in the logged model adapter', async () => {
    const captured = createLogger(true)
    const bindings: unknown[] = []
    const invocations: unknown[] = []
    const model = {
        modelName: 'test-model',
        invoke: async () => {
            throw new Error('direct invocation must not be used')
        },
        withConfig: (config: unknown) => {
            bindings.push(config)
            return {
                invoke: async (input: unknown, runConfig: unknown) => {
                    invocations.push({ input, runConfig })
                    return new AIMessage('bound response')
                }
            }
        }
    } as unknown as ChatLunaChatModel
    const logged = createLoggedModel(model, {
        logger: captured.log,
        stage: 'agent',
        attempt: 2
    })

    const bound = logged.withConfig({ tags: ['bound'] })
    const input = [new HumanMessage('bound prompt')]
    await bound.invoke(input, { tags: ['runtime'] })

    assert.deepEqual(bindings, [{ tags: ['bound'] }])
    assert.equal((invocations[0] as { input: unknown }).input, input)
    assert.deepEqual(
        (invocations[0] as { runConfig: { tags: string[] } }).runConfig.tags,
        ['runtime']
    )
})

it('does not normalize model payloads when debug is disabled', async () => {
    const captured = createLogger(false)
    let normalized = false
    const input = {
        toChatMessages: () => {
            normalized = true
            return []
        }
    }
    const model = {
        modelName: 'test-model',
        invoke: async () => new AIMessage('ok')
    } as unknown as ChatLunaChatModel

    await invokeLoggedModel(model, input as never, undefined, {
        logger: captured.log,
        stage: 'test',
        attempt: 1
    })

    assert.equal(normalized, false)
    assert.equal(captured.info.length, 0)
})

it('does not let logging sink failures change model results', async () => {
    const log = new LivingMemoryLogger(
        {
            info: () => {
                throw new Error('sink failed')
            },
            warn: () => {},
            error: () => {}
        } as never,
        () => true
    )
    const model = {
        modelName: 'test-model',
        invoke: async () => new AIMessage('business result')
    } as unknown as ChatLunaChatModel

    const response = await invokeLoggedModel(
        model,
        [new HumanMessage('prompt')],
        undefined,
        {
            logger: log,
            stage: 'test',
            attempt: 1
        }
    )

    assert.equal(response.content, 'business result')
})
