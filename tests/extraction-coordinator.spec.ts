import assert from 'node:assert/strict'
import type {
    AttributedMemoryItem,
    ExtractionPayload
} from '../src/contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope,
    MemorySourceMessage
} from '../src/contracts/memory'
import {
    type ExtractionJobRepository,
    type ExtractionMemoryWriter,
    LivingMemoryExtractionCoordinator
} from '../src/service/workflows/extraction/coordinator'
import type { LivingMemoryExtractionTrace } from '../src/service/workflows/extraction/extractor'
import {
    createCapturedLogger,
    createJobStore,
    scope,
    waitFor
} from './workflow-test-utils'

const createExtractionMessages = (): LivingMemoryTranscriptMessage[] => [
    {
        role: 'user',
        speakerKey: 'speaker-key',
        speakerLabel: '用户',
        contentLines: ['用户消息'],
        createdAt: new Date('2026-07-01T00:00:00.000Z')
    },
    {
        role: 'assistant',
        speakerLabel: '助手',
        contentLines: ['助手消息'],
        createdAt: new Date('2026-07-01T00:01:00.000Z')
    }
]

const createExtractionTrace = (
    overrides: Partial<LivingMemoryExtractionTrace> = {}
): LivingMemoryExtractionTrace => ({
    extracted: [],
    prompt: null,
    output: null,
    skippedReason: null,
    parseError: null,
    ...overrides
})

const createExtractedMemory = (): AttributedMemoryItem => ({
    type: 'fact',
    content: 'memory',
    summary: 'memory summary',
    keywords: ['memory'],
    sentiment: 'neutral',
    importance: 0.5,
    speakerKeys: ['speaker-key']
})

interface ExtractionCoordinatorOptions {
    trace?: LivingMemoryExtractionTrace
    extractionInterval?: number
    extractionRounds?: number
    enableExtractionWhitelist?: boolean
    extractionWhitelist?: string[]
    extractWithTrace?: () => Promise<LivingMemoryExtractionTrace>
    createFailedJob?: ExtractionJobRepository['createFailedJob']
    queueAutoDream?: (presetId: string) => void
    toExtractionPayload?: (
        messages: LivingMemoryTranscriptMessage[]
    ) => ExtractionPayload
    appendMemories?: ExtractionMemoryWriter['appendMemories']
}

const createExtractionCoordinator = (
    options: ExtractionCoordinatorOptions = {}
) => {
    const trace = options.trace ?? createExtractionTrace()
    const jobStore = createJobStore()
    const appended: {
        scope: MemoryScope
        sourceOriginMessages: MemorySourceMessage[]
        extracted: AttributedMemoryItem[]
    }[] = []
    const captured = createCapturedLogger()
    const debugMessages = captured.info
    const warnings = captured.warnings
    let extractorCalls = 0
    const formatter = {
        toExtractionPayload:
            options.toExtractionPayload ??
            (() => ({
                input: 'payload',
                sourceOriginMessages: [
                    {
                        role: 'user' as const,
                        speakerLabel: '用户',
                        content: '用户消息'
                    }
                ],
                speakers: [
                    {
                        speakerLabel: '用户',
                        speakerKey: 'speaker-key'
                    }
                ]
            }))
    }
    const extractor = {
        extractWithTrace: async () => {
            extractorCalls += 1
            return await (options.extractWithTrace?.() ??
                Promise.resolve(trace))
        }
    }
    const repository: ExtractionJobRepository & ExtractionMemoryWriter = {
        createFailedJob: options.createFailedJob ?? jobStore.createFailedJob,
        appendMemories:
            options.appendMemories ??
            (async (entryScope, sourceOriginMessages, extracted) => {
                appended.push({
                    scope: entryScope,
                    sourceOriginMessages,
                    extracted
                })
                return []
            })
    }
    const coordinator = new LivingMemoryExtractionCoordinator(
        {
            extractionInterval: options.extractionInterval ?? 1,
            extractionRounds: options.extractionRounds ?? 1,
            enableExtractionWhitelist:
                options.enableExtractionWhitelist ?? false,
            extractionWhitelist: options.extractionWhitelist ?? []
        },
        repository,
        repository,
        formatter,
        extractor,
        options.queueAutoDream ?? (() => {}),
        captured.logger
    )
    return {
        coordinator,
        jobStore,
        appended,
        debugMessages,
        warnings,
        getExtractorCalls: () => extractorCalls
    }
}

const queueExtraction = async (
    coordinator: LivingMemoryExtractionCoordinator,
    completedRoundCount = 1,
    resolvePresetPrompt: () => Promise<string> = async () => '你是测试助手。'
) => {
    const options = {
        resolvePresetPrompt,
        resolveTranscriptHeader: async () => '以下是聊天记录：'
    }
    for (let index = 0; index < completedRoundCount; index++) {
        await coordinator.queue(
            scope,
            { messages: createExtractionMessages() },
            options
        )
    }
}

it('counts the first completed round and extracts immediately at interval one', async () => {
    const { coordinator, getExtractorCalls } = createExtractionCoordinator()

    await coordinator.queue(
        scope,
        { messages: createExtractionMessages() },
        {
            resolvePresetPrompt: async () => '你是测试助手。',
            resolveTranscriptHeader: async () => '以下是聊天记录：'
        }
    )
    await waitFor(() => getExtractorCalls() === 1, 'first extraction')

    assert.equal(getExtractorCalls(), 1)
})

it('skips extraction when the configured interval is not reached', async () => {
    const { coordinator, getExtractorCalls } = createExtractionCoordinator({
        extractionInterval: 2
    })

    await queueExtraction(coordinator)

    assert.equal(getExtractorCalls(), 0)
})

it('restarts extraction interval counting after all scopes are cleared', async () => {
    const { coordinator, getExtractorCalls } = createExtractionCoordinator({
        extractionInterval: 3,
        extractionRounds: 3
    })

    await queueExtraction(coordinator, 2)
    coordinator.clearAll()
    await queueExtraction(coordinator, 2)

    assert.equal(getExtractorCalls(), 0)

    await queueExtraction(coordinator)
    await waitFor(() => getExtractorCalls() === 1, 'post-reset extraction')

    assert.equal(getExtractorCalls(), 1)
})

it('rejects an invalid completed-round contract', async () => {
    const { coordinator } = createExtractionCoordinator()
    const userOnlyRound = {
        messages: createExtractionMessages().filter(
            (message) => message.role === 'user'
        )
    }

    await assert.rejects(
        coordinator.queue(scope, userOnlyRound, {
            resolvePresetPrompt: async () => '你是测试助手。',
            resolveTranscriptHeader: async () => '以下是聊天记录：'
        }),
        /must contain both user and assistant messages/u
    )
})

it('preserves completed rounds while an extraction is in flight', async () => {
    const extractionTrace = createExtractionTrace({
        extracted: [createExtractedMemory()]
    })
    let resolveTrace!: (trace: LivingMemoryExtractionTrace) => void
    const tracePromise = new Promise<LivingMemoryExtractionTrace>((resolve) => {
        resolveTrace = resolve
    })
    let firstCall = true
    const { coordinator, jobStore, appended, getExtractorCalls } =
        createExtractionCoordinator({
            trace: extractionTrace,
            extractWithTrace: async () => {
                if (firstCall) {
                    firstCall = false
                    return await tracePromise
                }
                return extractionTrace
            }
        })
    const options = {
        resolvePresetPrompt: async () => '你是测试助手。',
        resolveTranscriptHeader: async () => '以下是聊天记录：'
    }

    await coordinator.queue(
        scope,
        { messages: createExtractionMessages() },
        options
    )
    await waitFor(() => getExtractorCalls() === 1, 'extraction model call')
    await coordinator.queue(
        scope,
        { messages: createExtractionMessages() },
        options
    )

    assert.equal(getExtractorCalls(), 1)
    assert.equal(jobStore.jobs.length, 0)

    resolveTrace(extractionTrace)
    await waitFor(
        () => getExtractorCalls() === 2,
        'queued extraction model call'
    )
    await waitFor(() => appended.length === 2, 'queued extraction completion')
    assert.equal(jobStore.jobs.length, 0)
})

it('uses only the configured number of recent completed rounds', async () => {
    const payloads: LivingMemoryTranscriptMessage[][] = []
    const { coordinator, getExtractorCalls } = createExtractionCoordinator({
        extractionInterval: 3,
        extractionRounds: 2,
        toExtractionPayload: (messages) => {
            payloads.push(messages)
            return {
                input: 'payload',
                sourceOriginMessages: [],
                speakers: []
            }
        }
    })

    for (let index = 1; index <= 3; index++) {
        const round = createExtractionMessages().map((message) => ({
            ...message,
            contentLines: [`round-${index}-${message.role}`]
        }))
        await coordinator.queue(
            scope,
            { messages: round },
            {
                resolvePresetPrompt: async () => '你是测试助手。',
                resolveTranscriptHeader: async () => '以下是聊天记录：'
            }
        )
    }
    await waitFor(() => getExtractorCalls() === 1, 'buffered extraction')

    assert.deepEqual(
        payloads[0]?.map((message) => message.contentLines[0]),
        [
            'round-2-user',
            'round-2-assistant',
            'round-3-user',
            'round-3-assistant'
        ]
    )
})

it('releases a consumed trigger resolver while retaining recent round context', async () => {
    const { coordinator, getExtractorCalls } = createExtractionCoordinator({
        extractionRounds: 2
    })
    const internal = coordinator as unknown as {
        stateByScope: Map<
            string,
            {
                rounds: unknown[]
                triggerRequests: Map<number, unknown>
            }
        >
    }

    await queueExtraction(coordinator)
    await waitFor(() => getExtractorCalls() === 1, 'first extraction')

    const state = internal.stateByScope.get(
        `${scope.presetId}\n${scope.conversationId}`
    )
    assert.equal(state?.rounds.length, 1)
    assert.equal(state?.triggerRequests.size, 0)
})

it('keeps separate trigger boundaries when multiple intervals arrive in flight', async () => {
    const payloads: string[][] = []
    let resolveFirstTrace!: (trace: LivingMemoryExtractionTrace) => void
    const firstTrace = new Promise<LivingMemoryExtractionTrace>((resolve) => {
        resolveFirstTrace = resolve
    })
    let firstCall = true
    const { coordinator, getExtractorCalls } = createExtractionCoordinator({
        extractionInterval: 2,
        extractionRounds: 2,
        toExtractionPayload: (messages) => {
            payloads.push(messages.map((message) => message.contentLines[0]))
            return {
                input: 'payload',
                sourceOriginMessages: [],
                speakers: []
            }
        },
        extractWithTrace: async () => {
            if (firstCall) {
                firstCall = false
                return await firstTrace
            }
            return createExtractionTrace()
        }
    })
    const options = {
        resolvePresetPrompt: async () => '你是测试助手。',
        resolveTranscriptHeader: async () => '以下是聊天记录：'
    }

    for (let index = 1; index <= 6; index++) {
        const round = createExtractionMessages().map((message) => ({
            ...message,
            contentLines: [`round-${index}-${message.role}`]
        }))
        await coordinator.queue(scope, { messages: round }, options)
    }
    assert.equal(getExtractorCalls(), 1)

    resolveFirstTrace(createExtractionTrace())
    await waitFor(() => getExtractorCalls() === 3, 'three interval boundaries')

    assert.deepEqual(
        payloads.map((payload) => payload[0]),
        ['round-1-user', 'round-3-user', 'round-5-user']
    )
})

it('writes extracted memories and queues auto Dream without persisting a job', async () => {
    const extracted: AttributedMemoryItem[] = [
        {
            ...createExtractedMemory(),
            content: 'private extracted detail'
        }
    ]
    const autoDreamPresets: string[] = []
    const { coordinator, jobStore, appended, debugMessages } =
        createExtractionCoordinator({
            trace: createExtractionTrace({ extracted }),
            queueAutoDream: (presetId) => autoDreamPresets.push(presetId)
        })

    await queueExtraction(coordinator)
    await waitFor(() => appended.length === 1, 'successful extraction')

    assert.equal(jobStore.jobs.length, 0)
    assert.deepEqual(appended[0]?.extracted, extracted)
    assert.deepEqual(autoDreamPresets, [scope.presetId])
    assert.ok(
        debugMessages.some(
            (message) =>
                message.includes('event=extraction.completed') &&
                message.includes('extracted=1')
        )
    )
    assert.ok(
        debugMessages.every(
            (message) => !message.includes(extracted[0].content)
        )
    )
})

it('persists one failed extraction job when payload construction throws', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator({
        toExtractionPayload: () => {
            throw new Error('payload failure')
        }
    })

    await queueExtraction(coordinator)
    await waitFor(() => jobStore.jobs.length === 1, 'failed extraction payload')

    assert.equal(jobStore.jobs[0]?.input, '')
    assert.match(jobStore.jobs[0]?.error ?? '', /payload failure/u)
})

it('persists one failed extraction job when the model throws', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator({
        extractWithTrace: async () => {
            throw new Error('extraction failure')
        }
    })

    await queueExtraction(coordinator)
    await waitFor(() => jobStore.jobs.length === 1, 'failed extraction model')

    assert.equal(jobStore.jobs[0]?.input, '以下是聊天记录：\n\npayload')
    assert.match(jobStore.jobs[0]?.error ?? '', /extraction failure/u)
})

it('logs extraction scope and preserves the original background error', async () => {
    const backgroundError = new Error('failed to persist extraction failure')
    const { coordinator, warnings } = createExtractionCoordinator({
        extractWithTrace: async () => {
            throw new Error('extraction failure')
        },
        createFailedJob: async () => {
            throw backgroundError
        }
    })

    await queueExtraction(coordinator)
    await waitFor(() => warnings.length === 1, 'extraction background warning')

    assert.match(
        String(warnings[0]?.[0]),
        /event=extraction.failed workflow=extraction .*presetId=preset-1.*conversationId=conversation-1.*operation=run.*triggerSequence=1/u
    )
    assert.equal(warnings[0]?.[1], backgroundError)
})

it('persists one failed extraction job when preset prompt resolution throws', async () => {
    const { coordinator, jobStore, getExtractorCalls } =
        createExtractionCoordinator()

    await queueExtraction(coordinator, 1, async () => {
        throw new Error('preset prompt resolution failure')
    })
    await waitFor(
        () => jobStore.jobs.length === 1,
        'failed preset prompt resolution'
    )

    assert.equal(getExtractorCalls(), 0)
    assert.match(
        jobStore.jobs[0]?.error ?? '',
        /preset prompt resolution failure/u
    )
})

it('consumes a failed boundary and processes the next completed round once', async () => {
    let shouldFail = true
    const { coordinator, jobStore, debugMessages, getExtractorCalls } =
        createExtractionCoordinator({
            extractWithTrace: async () => {
                if (shouldFail) {
                    throw new Error('first extraction failure')
                }
                return createExtractionTrace()
            }
        })

    await queueExtraction(coordinator)
    await waitFor(() => jobStore.jobs.length === 1, 'first failed extraction')
    assert.equal(getExtractorCalls(), 1)

    shouldFail = false
    await queueExtraction(coordinator)
    await waitFor(
        () =>
            debugMessages.some((message) =>
                message.includes('event=extraction.completed')
            ),
        'next extraction completion'
    )

    assert.equal(getExtractorCalls(), 2)
    assert.equal(jobStore.jobs.length, 1)
})

it('keeps a cleared scope serialized until its active extraction finishes', async () => {
    let resolveFirstTrace!: (trace: LivingMemoryExtractionTrace) => void
    const firstTrace = new Promise<LivingMemoryExtractionTrace>((resolve) => {
        resolveFirstTrace = resolve
    })
    let firstCall = true
    const { coordinator, getExtractorCalls } = createExtractionCoordinator({
        extractWithTrace: async () => {
            if (firstCall) {
                firstCall = false
                return await firstTrace
            }
            return createExtractionTrace()
        }
    })

    await queueExtraction(coordinator)
    await waitFor(() => getExtractorCalls() === 1, 'active extraction')

    coordinator.clearByConversation(scope.conversationId)
    await queueExtraction(coordinator)
    assert.equal(getExtractorCalls(), 1)

    resolveFirstTrace(createExtractionTrace())
    await waitFor(
        () => getExtractorCalls() === 2,
        'post-clear extraction completion'
    )
})

it('persists one failed extraction job for parse errors', async () => {
    const { coordinator, jobStore, appended } = createExtractionCoordinator({
        trace: createExtractionTrace({ parseError: 'bad json' })
    })

    await queueExtraction(coordinator)
    await waitFor(() => jobStore.jobs.length === 1, 'failed extraction parse')

    assert.equal(appended.length, 0)
    assert.match(jobStore.jobs[0]?.error ?? '', /extraction parse failed/u)
})

it('persists one failed extraction job when memory persistence throws', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator({
        trace: createExtractionTrace({
            extracted: [createExtractedMemory()]
        }),
        appendMemories: async () => {
            throw new Error('memory persistence failure')
        }
    })

    await queueExtraction(coordinator)
    await waitFor(
        () => jobStore.jobs.length === 1,
        'failed extracted-memory persistence'
    )

    assert.match(jobStore.jobs[0]?.error ?? '', /memory persistence failure/u)
})

it('does not persist a job for valid empty extraction output', async () => {
    const { coordinator, jobStore, appended, debugMessages } =
        createExtractionCoordinator({
            trace: createExtractionTrace({ extracted: [] })
        })

    await queueExtraction(coordinator)
    await waitFor(
        () => debugMessages.some((message) => message.includes('completed')),
        'empty extraction completion'
    )

    assert.equal(appended.length, 0)
    assert.equal(jobStore.jobs.length, 0)
})

it('does not persist a job when extraction is explicitly skipped', async () => {
    const { coordinator, jobStore, debugMessages } =
        createExtractionCoordinator({
            trace: createExtractionTrace({
                skippedReason: 'model-not-configured'
            })
        })

    await queueExtraction(coordinator)
    await waitFor(
        () => debugMessages.some((message) => message.includes('completed')),
        'skipped extraction completion'
    )

    assert.equal(jobStore.jobs.length, 0)
})
