import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type {
    ExtractedMemoryItem,
    ExtractionPayload
} from '../src/contracts/workflows'
import type {
    LivingMemoryTranscriptMessage,
    MemoryScope,
    MemorySourceMessage
} from '../src/contracts/memory'
import {
    type ExtractionWorkflowRepository,
    LivingMemoryExtractionCoordinator
} from '../src/service/workflows/extraction/coordinator'
import type { LivingMemoryExtractionTrace } from '../src/service/workflows/extraction/extractor'
import {
    createJobStore,
    scope,
    waitFor
} from './workflow-test-utils'

const createExtractionMessages = (): LivingMemoryTranscriptMessage[] => [
    {
        role: 'user',
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

interface ExtractionCoordinatorOptions {
    trace?: LivingMemoryExtractionTrace
    extractionInterval?: number
    extractWithTrace?: () => Promise<LivingMemoryExtractionTrace>
    queueAutoDream?: (presetId: string) => void
    toExtractionPayload?: () => ExtractionPayload
    appendMemories?: ExtractionWorkflowRepository['appendMemories']
}

const createExtractionCoordinator = (
    options: ExtractionCoordinatorOptions = {}
) => {
    const trace = options.trace ?? createExtractionTrace()
    const jobStore = createJobStore()
    const appended: {
        scope: MemoryScope
        sourceOriginMessages: MemorySourceMessage[]
        extracted: ExtractedMemoryItem[]
    }[] = []
    const debugMessages: string[] = []
    let extractorCalls = 0
    const formatter = {
        takeRecentRounds: (messages: LivingMemoryTranscriptMessage[]) =>
            messages,
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
                ]
            }))
    }
    const extractor = {
        extractWithTrace: async () => {
            extractorCalls += 1
            return await (options.extractWithTrace?.() ?? Promise.resolve(trace))
        }
    }
    const repository: ExtractionWorkflowRepository = {
        createFailedJob: jobStore.createFailedJob,
        appendMemories:
            options.appendMemories ??
            (async (entryScope, sourceOriginMessages, extracted) => {
                appended.push({
                    scope: entryScope,
                    sourceOriginMessages,
                    extracted
                })
            })
    }
    const coordinator = new LivingMemoryExtractionCoordinator(
        {} as Context,
        {
            extractionInterval: options.extractionInterval ?? 1,
            extractionRounds: 1
        },
        repository,
        formatter,
        extractor,
        options.queueAutoDream ?? (() => {}),
        { warn: () => {} },
        (message) => debugMessages.push(message)
    )
    return {
        coordinator,
        jobStore,
        appended,
        debugMessages,
        getExtractorCalls: () => extractorCalls
    }
}

const queueExtraction = async (
    coordinator: LivingMemoryExtractionCoordinator,
    firstChatCount = 0,
    secondChatCount = 1
) => {
    const messages = createExtractionMessages()
    await coordinator.queue(scope, firstChatCount, messages)
    await coordinator.queue(scope, secondChatCount, messages)
}

it('skips the first extraction call while initializing its baseline', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator()

    await coordinator.queue(scope, 0, createExtractionMessages())

    assert.equal(jobStore.jobs.length, 0)
})

it('skips extraction when the configured interval is not reached', async () => {
    const { coordinator, jobStore } = createExtractionCoordinator({
        extractionInterval: 2
    })

    await queueExtraction(coordinator, 0, 1)

    assert.equal(jobStore.jobs.length, 0)
})

it('drops a same-scope extraction while the previous run is in flight', async () => {
    const extractionTrace = createExtractionTrace({
        extracted: [{ type: 'fact', content: 'memory' }]
    })
    let resolveTrace!: (trace: LivingMemoryExtractionTrace) => void
    const tracePromise = new Promise<LivingMemoryExtractionTrace>((resolve) => {
        resolveTrace = resolve
    })
    const {
        coordinator,
        jobStore,
        appended,
        getExtractorCalls
    } = createExtractionCoordinator({
        trace: extractionTrace,
        extractWithTrace: async () => await tracePromise
    })

    await coordinator.queue(scope, 0, createExtractionMessages())
    await coordinator.queue(scope, 1, createExtractionMessages())
    await waitFor(() => getExtractorCalls() === 1, 'extraction model call')
    await coordinator.queue(scope, 1, createExtractionMessages())

    assert.equal(getExtractorCalls(), 1)
    assert.equal(jobStore.jobs.length, 0)

    resolveTrace(extractionTrace)
    await waitFor(() => appended.length === 1, 'locked extraction completion')
    assert.equal(jobStore.jobs.length, 0)
})

it('writes extracted memories and queues auto Dream without persisting a job', async () => {
    const extracted: ExtractedMemoryItem[] = [
        { type: 'fact', content: 'memory' }
    ]
    const autoDreamPresets: string[] = []
    const { coordinator, jobStore, appended } = createExtractionCoordinator({
        trace: createExtractionTrace({ extracted }),
        queueAutoDream: (presetId) => autoDreamPresets.push(presetId)
    })

    await queueExtraction(coordinator)
    await waitFor(() => appended.length === 1, 'successful extraction')

    assert.equal(jobStore.jobs.length, 0)
    assert.deepEqual(appended[0]?.extracted, extracted)
    assert.deepEqual(autoDreamPresets, [scope.presetId])
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

    assert.equal(jobStore.jobs[0]?.input, 'payload')
    assert.match(jobStore.jobs[0]?.error ?? '', /extraction failure/u)
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
            extracted: [{ type: 'fact', content: 'memory' }]
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
    const {
        coordinator,
        jobStore,
        appended,
        debugMessages
    } = createExtractionCoordinator({
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
