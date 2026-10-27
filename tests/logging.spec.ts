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

it('formats a Chinese summary using inherited context', () => {
    const captured = createLogger(true)
    captured.log
        .with({ presetId: '克子（Character）' })
        .summary(
            '人物画像处理失败',
            (fields) => `预设：${fields.presetId}; 原因：结果格式错误`,
            'warn'
        )
    assert.equal(
        captured.warnings[0]?.[0],
        '事件：人物画像处理失败; 预设：克子（Character）; 原因：结果格式错误'
    )
})

it('does not build diagnostic fields when debug logging is disabled', () => {
    const captured = createLogger(false)
    let built = false
    captured.log.diagnosticSummary(() => {
        built = true
        return { event: '诊断', detail: '值：1' }
    })
    assert.equal(built, false)
    assert.equal(captured.info.length, 0)
})

it('redacts credential fields and handles circular values', () => {
    const captured = createLogger(true)
    const circular: Record<string, unknown> = { apiKey: 'secret' }
    circular['self'] = circular
    captured.log.diagnosticSummary(() => ({
        event: '诊断',
        detail: '内容',
        blocks: [{ title: '数据', value: circular }]
    }))
    const message = String(captured.info[0]?.[0])
    assert.match(message, /"apiKey": "\[REDACTED\]"/u)
    assert.match(message, /"self": "\[Circular\]"/u)
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

    assert.doesNotThrow(() => log.summary('日志测试', '首次输出'))
    assert.doesNotThrow(() => log.summary('日志测试', '再次输出'))
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
