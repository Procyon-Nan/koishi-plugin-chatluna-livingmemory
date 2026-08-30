import { strict as assert } from 'node:assert'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { Logger as KoishiLogger } from 'koishi'
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
    const captured = createLogger()
    captured.log
        .with({ presetId: '克子（Character）', workflow: 'recall' })
        .info('recall.snapshot.updated', {
            content: '第一行\n第二行',
            runId: 'run-1'
        })

    assert.equal(
        captured.info[0]?.[0],
        'event=recall.snapshot.updated workflow=recall runId=run-1 ' +
            'presetId="克子（Character）" content="第一行\\n第二行"'
    )
})

it('orders numbered cluster fields numerically', () => {
    const captured = createLogger()
    captured.log.info('dream.clustering.batch.completed', {
        'clusters-10': 1,
        'clusters-2': 2,
        'clusters-1': 3,
        noise: 4
    })

    assert.equal(
        captured.info[0]?.[0],
        'event=dream.clustering.batch.completed ' +
            'clusters-1=3 clusters-2=2 clusters-10=1 noise=4'
    )
})

it('preserves a complete single-line payload through the Koishi logger target', () => {
    const originalTargets = KoishiLogger.targets
    let recordedContent = ''
    const target = {
        colors: 0,
        record: (record: { content: string }) => {
            recordedContent = record.content
        }
    }
    KoishiLogger.targets = [target]
    try {
        const logger = new LivingMemoryLogger(
            new KoishiLogger('chatluna-livingmemory'),
            () => false
        )
        const content = 'x'.repeat(12_000)

        logger.info('test.complete-payload', { content })

        assert.equal(
            recordedContent,
            `event=test.complete-payload content=${content}`
        )
        assert.equal('maxLength' in target, false)
    } finally {
        KoishiLogger.targets = originalTargets
    }
})

it('preserves multiline diagnostic blocks through the Koishi logger target', () => {
    const originalTargets = KoishiLogger.targets
    let recordedContent = ''
    const target = {
        colors: 0,
        record: (record: { content: string }) => {
            recordedContent = record.content
        }
    }
    KoishiLogger.targets = [target]
    try {
        const logger = new LivingMemoryLogger(
            new KoishiLogger('chatluna-livingmemory'),
            () => true
        )
        const longLine = 'x'.repeat(12_000)

        logger.diagnostic('test.multiline', { runId: 'run-1' }, [
            {
                title: 'payload',
                key: 'content',
                value: `first line\n${longLine}`
            }
        ])

        assert.equal(
            recordedContent,
            'event=test.multiline runId=run-1\n' +
                `--- payload ---\nfirst line\n${longLine}\n` +
                '--- end test.multiline ---'
        )
        assert.equal('maxLength' in target, false)
    } finally {
        KoishiLogger.targets = originalTargets
    }
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
    assert.equal(warnings[0]?.[0], 'event=logging.failure operation=emit')
})

it('logs readable complete prompt and response blocks with one model call id', async () => {
    const captured = createLogger(true)
    const model = {
        modelName: 'test-model',
        invoke: async () => new AIMessage('complete response')
    } as unknown as ChatLunaChatModel

    const response = await invokeLoggedModel(
        model,
        [new HumanMessage('line one\nline two')],
        undefined,
        { logger: captured.log, stage: 'test-stage', attempt: 1 }
    )

    assert.equal(response.content, 'complete response')
    assert.equal(captured.info.length, 2)
    const prompt = String(captured.info[0]?.[0])
    const output = String(captured.info[1]?.[0])
    const callId = /modelCallId=([^ ]+)/u.exec(prompt)?.[1]
    assert.ok(callId)
    assert.match(prompt, /event=model\.prompt/u)
    assert.match(prompt, /--- message\[0\] role=human ---/u)
    assert.match(prompt, /line one\nline two/u)
    assert.doesNotMatch(prompt, /line one\\nline two/u)
    assert.match(prompt, /--- end model\.prompt ---$/u)
    assert.match(output, /event=model\.response/u)
    assert.match(output, new RegExp(`modelCallId=${callId}`, 'u'))
    assert.match(output, /--- response\.text ---\ncomplete response/u)
    assert.doesNotMatch(output, /response\.raw|lc_kwargs|response_metadata/u)
    assert.match(output, /--- end model\.response ---$/u)
})

it('logs only projected tool calls for a tool-calling model response', async () => {
    const captured = createLogger(true)
    const model = {
        modelName: 'test-model',
        invoke: async () =>
            new AIMessage({
                content: '',
                tool_calls: [
                    {
                        name: 'living_memory_search',
                        args: {
                            searchTexts: ['query']
                        },
                        id: 'call-1',
                        type: 'tool_call'
                    }
                ],
                response_metadata: {
                    usage_metadata: { input_tokens: 100 }
                }
            })
    } as unknown as ChatLunaChatModel

    await invokeLoggedModel(model, [new HumanMessage('prompt')], undefined, {
        logger: captured.log,
        stage: 'test-stage',
        attempt: 1,
        logResponseText: false
    })

    const output = String(captured.info[1]?.[0])
    assert.match(output, /--- response\.tool_calls ---\n\[/u)
    assert.match(output, /"name": "living_memory_search"/u)
    assert.match(output, /"searchTexts": \[\n\s+"query"\n\s+\]/u)
    assert.doesNotMatch(
        output,
        /response\.text|response\.raw|"(?:additional_kwargs|content|invalid_tool_calls|lc_kwargs|response_metadata|tool_call_chunks|usage_metadata)"/u
    )
    assert.match(output, /--- end model\.response ---$/u)
})

it('omits a text-only model response when its workflow owns the final text log', async () => {
    const captured = createLogger(true)
    const model = {
        modelName: 'test-model',
        invoke: async () => new AIMessage('snapshot content')
    } as unknown as ChatLunaChatModel

    const response = await invokeLoggedModel(
        model,
        [new HumanMessage('prompt')],
        undefined,
        {
            logger: captured.log,
            stage: 'agentic-decision',
            attempt: 1,
            logResponseText: false
        }
    )

    assert.equal(response.content, 'snapshot content')
    assert.equal(captured.info.length, 1)
    assert.match(String(captured.info[0]?.[0]), /event=model\.prompt/u)
})

it('pretty-prints and redacts structured diagnostic block values', () => {
    const captured = createLogger(true)
    captured.log.diagnostic('test.blocks', {}, [
        {
            title: 'payload\ninjected',
            key: 'payload',
            value: {
                nested: { apiKey: 'secret' },
                values: [1, 2]
            }
        }
    ])

    const message = String(captured.info[0]?.[0])
    assert.match(message, /--- payload injected ---/u)
    assert.match(message, /"apiKey": "\[REDACTED\]"/u)
    assert.match(message, /"values": \[\n\s+1,\n\s+2\n\s+\]/u)
    assert.doesNotMatch(message, /secret/u)
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
