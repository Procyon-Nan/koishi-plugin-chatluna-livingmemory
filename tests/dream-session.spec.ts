import assert from 'node:assert/strict'
import 'koishi-plugin-chatluna'
import {
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    ToolMessage
} from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { ModelType } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type {
    ModelRequester,
    ModelRequestParams
} from 'koishi-plugin-chatluna/llm-core/platform/api'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import { createMemoryTool } from '../src/service/memory/tools'
import { buildDreamMemoryBatchPrompt } from '../src/service/prompts/dream'
import { DreamSessionHistory } from '../src/service/workflows/dream/session/history'
import { runDreamSession } from '../src/service/workflows/dream/session/runner'
import {
    createDreamSessionState,
    getDreamCoverage,
    recordDreamOperation
} from '../src/service/workflows/dream/session/state'
import type { DreamCluster } from '../src/service/workflows/dream/types'

const cluster = (id: string): DreamCluster => ({
    id,
    entries: [
        {
            id,
            presetId: 'preset',
            sourceLabel: null,
            type: 'fact',
            content: `正文 ${id}`,
            summary: `摘要 ${id}`,
            keywords: ['关键词'],
            sentiment: '平静',
            importance: 0.7,
            speakerKeys: [],
            createdAt: new Date('2026-10-19T00:00:00Z'),
            updatedAt: new Date('2026-10-19T01:00:00Z')
        }
    ]
})

const logger = () => {
    const logs: string[] = []
    return {
        logs,
        logger: new LivingMemoryLogger(
            {
                info: (value: string) => logs.push(value),
                warn: () => {},
                error: () => {}
            },
            () => true
        )
    }
}

const createModel = (
    respond: (
        params: ModelRequestParams,
        index: number
    ) => AIMessage | Promise<AIMessage>
) => {
    const requests: ModelRequestParams[] = []
    const model = new ChatLunaChatModel({
        model: 'test-model',
        modelInfo: {
            name: 'test-model',
            type: ModelType.llm,
            capabilities: [],
            maxTokens: 1_000_000
        },
        modelMaxContextSize: 1_000_000,
        maxTokens: 8192,
        maxTokenLimit: 50,
        maxRetries: 0,
        overrideRequestParams: {
            configured: true,
            cache_control: { type: 'ephemeral' }
        },
        requester: {
            async completion(params: ModelRequestParams) {
                requests.push(params)
                const message = await respond(params, requests.length)
                return {
                    message,
                    text:
                        typeof message.content === 'string'
                            ? message.content
                            : ''
                }
            }
        } as ModelRequester
    })
    return { model, requests }
}

const check = (memoryIds: string[], id: string) => ({
    id,
    name: 'living_memory_checked_memory',
    args: { memoryIds, reason: '内容准确完整' }
})

const createRun = (
    model: ChatLunaChatModel,
    batches: (string | string[])[] = ['a', 'b']
) => {
    const state = createDreamSessionState(batches.flatMap((batch) => batch))
    state.clusters = batches.map((batch, index) =>
        typeof batch === 'string'
            ? cluster(batch)
            : {
                  id: `batch-${index}`,
                  entries: batch.flatMap((id) => cluster(id).entries)
              }
    )
    const checked = createMemoryTool.checked(async ({ memoryIds }) => {
        recordDreamOperation(state, memoryIds, 'kept')
        return { warnings: [] }
    })
    const search = new DynamicStructuredTool({
        name: 'search',
        description: '检索',
        schema: z.object({}),
        func: async () => '检索成功'
    })
    const captured = logger()
    return {
        presetId: 'preset',
        sessionId: 'dream-test',
        assistantLabel: '角色',
        presetPrompt: '人设',
        speakers: [],
        state,
        tools: [checked, search],
        model,
        logger: captured.logger,
        logs: captured.logs
    }
}

it('runs the real host agent with stable request prefixes, paired tools and invocation options', async () => {
    const original = new AIMessage({
        content: '',
        tool_calls: [
            { id: 'search-1', name: 'search', args: {} },
            check(['a'], 'check-a')
        ],
        additional_kwargs: {
            reasoning_content: '推理',
            signature: 'provider-signature'
        },
        response_metadata: { marker: 'keep' }
    })
    const { model, requests } = createModel((_params, index) =>
        index === 1
            ? original
            : new AIMessage({
                  content: '',
                  tool_calls: [check(['b'], 'check-b')]
              })
    )
    const usage = {
        input_tokens: 90_000,
        output_tokens: 20,
        total_tokens: 90_020,
        input_token_details: { cache_read: 80_000 }
    }
    const invoke = model.invoke.bind(model)
    vi.spyOn(model, 'invoke').mockImplementation(async (...args) => {
        const response = await invoke(...args)
        // 未启动 Koishi 插件时宿主 logger 尚未初始化，在调用边界补入供应商用量。
        if (requests.length === 1) {
            response.usage_metadata = usage
            original.usage_metadata = usage
        }
        return response
    })
    const run = createRun(model)
    await runDreamSession(run)
    assert.equal(requests.length, 2)
    assert.deepEqual(getDreamCoverage(run.state), {
        targetCount: 2,
        processedCount: 2,
        unprocessedMemoryIds: []
    })
    assert.deepEqual(requests[1].input.slice(0, 2), requests[0].input)
    assert.deepEqual(
        requests[1].input.map((message) => message.getType()),
        ['system', 'human', 'ai', 'tool', 'tool', 'human']
    )
    assert.deepEqual(
        requests[1].input
            .filter((m) => m.getType() === 'tool')
            .map((m) => (m as ToolMessage).tool_call_id),
        ['search-1', 'check-a']
    )
    const retained = requests[1].input[2] as AIMessage
    assert.equal(retained.usage_metadata, undefined)
    assert.deepEqual(retained.additional_kwargs, original.additional_kwargs)
    assert.deepEqual(retained.response_metadata, original.response_metadata)
    assert.equal(original.usage_metadata?.input_tokens, 90_000)
    for (const request of requests) {
        assert.equal(request.id, 'dream-test')
        assert.equal(request.maxTokens, 8192)
        assert.equal(request.tools?.length, 2)
        assert.deepEqual(request.overrideRequestParams, {
            configured: true,
            cache_control: { type: 'ephemeral' }
        })
    }
    assert.equal(model.invocationParams().maxTokenLimit, 50)
    assert.deepEqual(model.invocationParams().overrideRequestParams, {
        configured: true,
        cache_control: { type: 'ephemeral' }
    })
    assert.ok(
        run.logs.some(
            (line) =>
                line.includes('cache_read=80000') ||
                line.includes('"cache_read":80000')
        )
    )
})

it('keeps successful work, retries ineffective rounds and moves on after three consecutive failures', async () => {
    const { model, requests } = createModel((_params, index) => {
        if (index === 1)
            return new AIMessage({
                content: '',
                tool_calls: [check(['a'], 'first')]
            })
        if (index === 2 || index === 5) throw new Error('request failed')
        if (index === 3)
            return new AIMessage({
                content: '',
                tool_calls: [{ id: 'bad', name: 'missing', args: {} }]
            })
        if (index === 4)
            return new AIMessage({
                content: '',
                tool_calls: [{ id: 'search', name: 'search', args: {} }]
            })
        if (index < 8) return new AIMessage('这一批结束了')
        return new AIMessage({
            content: '',
            tool_calls: [check(['c'], 'last')]
        })
    })
    const run = createRun(model, ['a', 'b', 'c'])
    await runDreamSession(run)
    assert.equal(requests.length, 8)
    assert.deepEqual(getDreamCoverage(run.state).unprocessedMemoryIds, ['b'])
    assert.equal(run.state.skippedBatches.length, 1)
    assert.deepEqual(run.state.skippedBatches[0].memoryIds, ['b'])
    assert.ok(
        requests[7].input.some((m) => String(m.content).includes('跳过本批'))
    )
})

it('limits successful searches without coverage to sixty rounds and preserves partial batch results', async () => {
    const { model, requests } = createModel(
        (_params, index) =>
            new AIMessage({
                content: '',
                tool_calls:
                    index === 1
                        ? [check(['a'], 'a')]
                        : index <= 60
                          ? [
                                {
                                    id: `search-${index}`,
                                    name: 'search',
                                    args: {}
                                }
                            ]
                          : [check(['c'], 'c')]
            })
    )
    const run = createRun(model, [['a', 'b'], 'c'])
    await runDreamSession(run)
    assert.equal(requests.length, 61)
    assert.deepEqual(getDreamCoverage(run.state).unprocessedMemoryIds, ['b'])
    assert.match(run.state.skippedBatches[0].reason, /60/)
})

it('stops further writes when cancelled between tools in one response', async () => {
    const controller = new AbortController()
    const { model } = createModel(
        () =>
            new AIMessage({
                content: '',
                tool_calls: [check(['a'], 'a'), check(['b'], 'b')]
            })
    )
    const run = createRun(model)
    run.tools[0] = createMemoryTool.checked(async ({ memoryIds }) => {
        recordDreamOperation(run.state, memoryIds, 'kept')
        controller.abort(new Error('disposed'))
        return { warnings: [] }
    })
    await assert.rejects(
        runDreamSession({ ...run, signal: controller.signal }),
        /disposed/
    )
    assert.deepEqual([...run.state.processedMemoryIds], ['a'])
})

it('handles legacy function calls without replacing the original assistant message', async () => {
    const { model, requests } = createModel(
        (_params, index) =>
            new AIMessage({
                content: '',
                additional_kwargs: {
                    function_call: {
                        name: 'living_memory_checked_memory',
                        arguments: JSON.stringify({
                            memoryIds: [index === 1 ? 'a' : 'b'],
                            reason: '无需改动'
                        })
                    }
                }
            })
    )
    await runDreamSession(createRun(model))
    assert.deepEqual(
        requests[1].input.map((message) => message.getType()),
        ['system', 'human', 'ai', 'function', 'human']
    )
})

it('compresses only older batches and retains complete current input and tool exchanges', async () => {
    const { model, requests } = createModel(
        () => new AIMessage('早期结论与相关 ID')
    )
    const invoke = model.invoke.bind(model)
    vi.spyOn(model, 'invoke').mockImplementation(async (...args) => {
        const response = await invoke(...args)
        response.usage_metadata = {
            input_tokens: 300_000,
            output_tokens: 10,
            total_tokens: 300_010
        }
        return response
    })
    const captured = logger()
    const history = new DreamSessionHistory(
        '固定系统',
        model,
        {
            id: 'history',
            maxTokens: 8192,
            maxTokenLimit: 991_808,
            overrideRequestParams: { configured: true }
        },
        captured.logger
    )
    history.startBatch('早期记忆')
    history.append(new AIMessage('早期完成'))
    const current = buildDreamMemoryBatchPrompt(cluster('current'), [])
    history.startBatch(current)
    const response = new AIMessage({
        content: '',
        tool_calls: [check(['current'], 'current-call')],
        additional_kwargs: { signature: 'signed' },
        usage_metadata: {
            input_tokens: 200_000,
            output_tokens: 10,
            total_tokens: 200_010
        }
    })
    const result = new ToolMessage({
        content: '当前结果'.repeat(1000),
        tool_call_id: 'current-call'
    })
    history.append(response, result)
    history.recordUsage(response)
    const messages = await history.prepareDecisionMessages([])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].id, 'history:compression')
    assert.deepEqual(requests[0].tools, [])
    assert.ok(String(requests[0].input[1].content).includes('早期记忆'))
    assert.ok(!String(requests[0].input[1].content).includes('current-call'))
    assert.equal(messages[0].content, '固定系统')
    assert.match(String(messages[1].content), /早期结论/)
    assert.equal(messages[2].content, current)
    assert.deepEqual((messages[3] as AIMessage).tool_calls, response.tool_calls)
    assert.deepEqual(messages[3].additional_kwargs, response.additional_kwargs)
    assert.equal(messages[4], result)
    history.append(new HumanMessage('继续当前批次'))
    assert.equal((await history.prepareDecisionMessages([])).length, 6)
    assert.equal(requests.length, 1)
    assert.equal(response.usage_metadata?.input_tokens, 200_000)
})

it('uses only reported input for the threshold, without adding cache reads or local estimates', async () => {
    const { model, requests } = createModel(() => new AIMessage('摘要'))
    const history = new DreamSessionHistory(
        'system',
        model,
        { id: 'history', maxTokenLimit: 990_000 },
        logger().logger
    )
    history.startBatch('旧'.repeat(310_000))
    history.startBatch('当前完整字段')
    assert.equal((await history.prepareDecisionMessages([])).length, 3)
    history.recordUsage(
        new AIMessage({
            content: '',
            usage_metadata: {
                input_tokens: 199_999,
                output_tokens: 10,
                total_tokens: 200_009,
                input_token_details: { cache_read: 190_000 }
            }
        })
    )
    assert.equal((await history.prepareDecisionMessages([])).length, 3)
    assert.equal(requests.length, 0)
    history.recordUsage(
        new AIMessage({
            content: '',
            usage_metadata: {
                input_tokens: 200_000,
                output_tokens: 10,
                total_tokens: 200_010
            }
        })
    )
    assert.match(
        String((await history.prepareDecisionMessages([]))[1].content),
        /dream_history_summary/
    )
    assert.equal(requests.length, 1)
})

it('leaves old history intact after a failed compression', async () => {
    let fail = true
    const { model, requests } = createModel(() => {
        if (fail) throw new Error('summary failed')
        return new AIMessage('保留结论')
    })
    const history = new DreamSessionHistory(
        'system',
        model,
        { id: 'history', maxTokenLimit: 990_000 },
        logger().logger
    )
    history.startBatch('早期记忆')
    history.startBatch('当前完整字段')
    history.recordUsage(
        new AIMessage({
            content: '',
            usage_metadata: {
                input_tokens: 200_000,
                output_tokens: 10,
                total_tokens: 200_010
            }
        })
    )
    history.recordUsage(new AIMessage('没有用量'))
    history.recordUsage(
        new AIMessage({
            content: '',
            usage_metadata: {
                input_tokens: Number.NaN,
                output_tokens: 10,
                total_tokens: Number.NaN
            }
        })
    )
    await assert.rejects(history.prepareDecisionMessages([]), /summary failed/)
    fail = false
    const messages = await history.prepareDecisionMessages([])
    assert.equal(requests[0].input[1].content, requests[1].input[1].content)
    assert.equal(messages[2].content, '当前完整字段')
})

it('rejects oversized input instead of letting the host drop current batch messages', async () => {
    const { model, requests } = createModel(() => new AIMessage('unused'))
    const history = new DreamSessionHistory(
        'system',
        model,
        { id: 'history', maxTokenLimit: 100 },
        logger().logger
    )
    history.startBatch('当前完整字段'.repeat(1000))
    history.append(new HumanMessage('继续'))
    await assert.rejects(
        history.prepareDecisionMessages([]),
        /输入超过模型可用预算/
    )
    assert.equal(requests.length, 0)
})

it('rejects models unable to support the fixed threshold before calling them', async () => {
    const { model, requests } = createModel(() => new AIMessage('unused'))
    vi.spyOn(model, 'getModelMaxContextSize').mockReturnValue(200_000)
    await assert.rejects(
        runDreamSession(createRun(model)),
        /200k 输入及输出预算/
    )
    assert.equal(requests.length, 0)
})

it('keeps unparseable calls as correction data without replaying broken protocol messages', async () => {
    const broken = new AIMessageChunk({
        content: '',
        additional_kwargs: {
            signature: 'signed',
            tool_calls: [
                {
                    id: 'broken-call',
                    type: 'function',
                    function: {
                        name: 'living_memory_checked_memory',
                        arguments: '{'
                    }
                }
            ]
        }
    })
    const { model, requests } = createModel((params, index) =>
        params.id?.endsWith(':compression')
            ? new AIMessage('早期结论')
            : new AIMessage({
                  content: '',
                  tool_calls: [check([index === 1 ? 'a' : 'b'], 'correct')]
              })
    )
    const invoke = model.invoke.bind(model)
    let calls = 0
    vi.spyOn(model, 'invoke').mockImplementation(async (...args) => {
        if (++calls === 2) {
            broken.usage_metadata = {
                input_tokens: 200_000,
                output_tokens: 10,
                total_tokens: 200_010
            }
            return broken
        }
        return invoke(...args)
    })
    const run = createRun(model)
    await runDreamSession(run)
    assert.equal(getDreamCoverage(run.state).processedCount, 2)
    assert.equal(requests[1].id, 'dream-test:compression')
    const repaired = requests[2].input
    assert.deepEqual(
        repaired.map((message) => message.getType()),
        ['system', 'human', 'human', 'human']
    )
    assert.match(String(repaired[3].content), /broken-call/)
    assert.match(String(repaired[3].content), /signed/)
    assert.match(String(repaired[3].content), /解析失败/)
})
