import assert from 'node:assert/strict'
import {
    AIMessage,
    type BaseMessage,
    SystemMessage
} from '@langchain/core/messages'
import type { Context } from 'koishi'
import type { PresetPersonaRecord } from '../src/contracts/memory'
import { personaCardResultToolName } from '../src/service/prompts/schema'
import {
    LivingMemoryPresetPersonaService,
    hashPresetText
} from '../src/service/memory/preset_persona'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'
import { createCapturedLogger } from './workflow-test-utils'

const presetText = [
    '你是所长，一个年轻可爱的女孩子。',
    '你说话简短随性，偶尔用颜文字。',
    '你可以调用 draw_image(prompt=..., urls=...) 来画画。',
    '输出时必须使用 Markdown 格式。',
    '你想要表达某个场景时可以画一张画。'
].join('\n')

// renderChatLunaPresetPrompt 经 formatRenderedPresetPrompt 加一行头注释，哈希与
// 落库都基于该渲染全文；测试用同一包装保证 rawHash 与 resolve 内部一致。
const renderedText = [
    '# 当前 preset prompt（仅用于理解“我”的人设，不要从此处抽取记忆）',
    presetText
].join('\n\n')

const createHarness = (
    responses: (BaseMessage | Error)[],
    options: { existing?: PresetPersonaRecord; presetIds?: string[] } = {}
) => {
    const model = createToolCallingModel(responses)
    const captured = createCapturedLogger()
    const upserts: unknown[] = []
    const deleted: string[] = []
    const repository = {
        getPresetPersona: async () => options.existing,
        listPresetPersonas: async () =>
            options.existing == null ? [] : [options.existing],
        upsertPresetPersona: async (input: unknown) => {
            upserts.push(input)
        },
        deletePresetPersona: async (presetId: string) => {
            deleted.push(presetId)
        }
    }
    const catalog = {
        list: async () => options.presetIds ?? ['preset-1']
    }
    const ctx = {
        chatluna: {
            createChatModel: async () => ({ value: model.model }),
            preset: {
                getPreset: () => ({ value: {} })
            },
            promptRenderer: {
                renderPresetTemplate: async () => ({
                    messages: [new SystemMessage(presetText)]
                })
            }
        }
    } as unknown as Context
    const service = new LivingMemoryPresetPersonaService(
        ctx,
        { mainModel: 'test-model' },
        repository,
        captured.logger,
        catalog
    )
    return { captured, deleted, model, service, upserts }
}

const deleteLines = (lineNumbers: number[]) =>
    createToolCallMessage(personaCardResultToolName, {
        deletedLineNumbers: lineNumbers
    })

// 渲染全文行号：1 头注释、2 空行、3-7 依次为 presetText 的 5 行。
const cardLines = presetText.split('\n')
const lineOf = (presetLineIndex: number) => presetLineIndex + 3

it('keeps original text and only deletes selected lines', async () => {
    const harness = createHarness([
        deleteLines([lineOf(2), lineOf(3), lineOf(4)])
    ])

    const card = await harness.service.resolve('preset-1')

    assert.equal(card, [cardLines[0], cardLines[1]].join('\n'))
    assert.equal(harness.model.invocations.length, 1)
    assert.equal(harness.upserts.length, 1)
    const upsert = harness.upserts[0] as Record<string, unknown>
    assert.equal(upsert.presetId, 'preset-1')
    assert.equal(upsert.card, card)
    assert.equal(upsert.source, 'generated')
    assert.equal(upsert.totalLines, 7)
    assert.equal(upsert.deletedLines, 3)
    assert.equal(upsert.usedRawFallback, false)
})

it('returns the rendered text unchanged when nothing needs deletion', async () => {
    const harness = createHarness([deleteLines([])])

    const card = await harness.service.resolve('preset-1')

    assert.equal(card, renderedText)
    assert.equal(harness.model.invocations.length, 1)
    assert.equal(harness.upserts.length, 1)
    assert.equal(
        (harness.upserts[0] as Record<string, unknown>).usedRawFallback,
        false
    )
})

it('falls back to the raw text when deletion exceeds the ratio guard', async () => {
    const harness = createHarness([deleteLines([1, 2, 3, 4, 5, 6, 7])])

    const card = await harness.service.resolve('preset-1')

    assert.equal(card, renderedText)
    assert.ok(
        harness.captured.info.some((message) =>
            message.includes('event=persona.prune.fallback')
        )
    )
    // 守卫回退是正常结果：照常落库并写入内存层，后续解析不再调用模型
    assert.equal(harness.upserts.length, 1)
    assert.equal(
        (harness.upserts[0] as Record<string, unknown>).usedRawFallback,
        true
    )
    const again = await harness.service.resolve('preset-1')
    assert.equal(again, renderedText)
    assert.equal(harness.model.invocations.length, 1)
})

it('retries with a correction when line numbers fall out of range', async () => {
    const harness = createHarness([
        deleteLines([99]),
        deleteLines([lineOf(2), lineOf(3), lineOf(4)])
    ])

    const card = await harness.service.resolve('preset-1')

    assert.equal(harness.model.invocations.length, 2)
    assert.doesNotMatch(card, /draw_image/u)
    assert.ok(
        harness.captured.info.some(
            (message) =>
                message.includes('event=model.parse.failed') &&
                message.includes('超出范围的行号')
        )
    )
})

it('falls back to the raw text when every response is invalid', async () => {
    const harness = createHarness([
        new AIMessage('plain text one'),
        new AIMessage('plain text two'),
        new AIMessage('plain text three')
    ])

    const card = await harness.service.resolve('preset-1')

    assert.equal(card, renderedText)
    assert.equal(harness.model.invocations.length, 3)
    assert.equal(harness.upserts.length, 0)
    // 模型失败回退不进内存层：下次解析重新调用模型（第 4 次因响应耗尽抛错，
    // 同样走 invoke-failed 回退，仍不落库）
    const retried = await harness.service.resolve('preset-1')
    assert.equal(retried, renderedText)
    assert.equal(harness.model.invocations.length, 4)
    assert.equal(harness.upserts.length, 0)
})

it('reuses a persisted card without a model call when the hash matches', async () => {
    const harness = createHarness([], {
        existing: {
            presetId: 'preset-1',
            card: 'cached card',
            rawHash: hashPresetText(renderedText),
            source: 'generated',
            totalLines: 5,
            deletedLines: 0,
            usedRawFallback: false,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    })

    const card = await harness.service.resolve('preset-1')

    assert.equal(card, 'cached card')
    assert.equal(harness.model.invocations.length, 0)
    assert.equal(harness.upserts.length, 0)
})

it('never overwrites a manual card', async () => {
    const harness = createHarness([], {
        existing: {
            presetId: 'preset-1',
            card: 'manual card',
            rawHash: 'stale',
            source: 'manual',
            totalLines: 5,
            deletedLines: 0,
            usedRawFallback: false,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    })

    const card = await harness.service.resolve('preset-1')

    assert.equal(card, 'manual card')
    assert.equal(harness.model.invocations.length, 0)
    assert.equal(harness.upserts.length, 0)
})

it('lists stored cards without rendering presets or calling the model', async () => {
    const harness = createHarness([], {
        existing: {
            presetId: 'preset-1',
            card: 'generated card',
            rawHash: hashPresetText(renderedText),
            source: 'generated',
            totalLines: 7,
            deletedLines: 3,
            usedRawFallback: false,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    })

    const cards = await harness.service.listCards()

    assert.equal(cards.length, 1)
    assert.equal(cards[0].presetId, 'preset-1')
    assert.equal(cards[0].source, 'generated')
    assert.equal(cards[0].totalLines, 7)
    assert.equal(cards[0].deletedLines, 3)
    // 自动卡片由哈希懒更新，不存在过期态
    assert.equal(cards[0].stale, false)
    assert.equal(cards[0].presetMissing, false)
    assert.equal(harness.model.invocations.length, 0)
})

it('marks a card whose preset has disappeared', async () => {
    const harness = createHarness([], {
        existing: {
            presetId: 'gone-preset',
            card: 'cached card',
            rawHash: 'hash',
            source: 'generated',
            totalLines: 3,
            deletedLines: 0,
            usedRawFallback: true,
            createdAt: new Date(),
            updatedAt: new Date()
        },
        presetIds: ['preset-1']
    })

    const cards = await harness.service.listCards()

    assert.equal(cards[0].presetMissing, true)
    assert.equal(cards[0].usedRawFallback, true)
})

it('marks a manual card stale when the preset text has changed', async () => {
    const harness = createHarness([], {
        existing: {
            presetId: 'preset-1',
            card: 'manual card',
            rawHash: 'hash-before-edit',
            source: 'manual',
            totalLines: 5,
            deletedLines: 0,
            usedRawFallback: false,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    })

    const cards = await harness.service.listCards()

    assert.equal(cards[0].stale, true)
    assert.equal(harness.model.invocations.length, 0)
})

it('saves a manual card and keeps it out of automatic updates', async () => {
    const harness = createHarness([])

    await harness.service.saveManualCard('preset-1', 'edited card')

    assert.equal(harness.upserts.length, 1)
    const upsert = harness.upserts[0] as Record<string, unknown>
    assert.equal(upsert.presetId, 'preset-1')
    assert.equal(upsert.card, 'edited card')
    assert.equal(upsert.source, 'manual')
    assert.equal(upsert.totalLines, 1)
    assert.equal(harness.model.invocations.length, 0)
    assert.equal(harness.captured.info.length, 0)
})

it('rejects empty manual card input', async () => {
    const harness = createHarness([])

    await assert.rejects(
        () => harness.service.saveManualCard('preset-1', '   '),
        /persona card must not be empty/u
    )
    assert.equal(harness.upserts.length, 0)
})

it('regenerates a card on reset and drops the stored row first', async () => {
    const harness = createHarness([deleteLines([lineOf(2), lineOf(3)])], {
        existing: {
            presetId: 'preset-1',
            card: 'manual card',
            rawHash: 'hash-before-edit',
            source: 'manual',
            totalLines: 5,
            deletedLines: 0,
            usedRawFallback: false,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    })

    await harness.service.resetCard('preset-1')

    assert.deepEqual(harness.deleted, ['preset-1'])
    assert.equal(harness.model.invocations.length, 1)
    assert.equal(harness.upserts.length, 1)
    assert.equal(
        (harness.upserts[0] as Record<string, unknown>).source,
        'generated'
    )
})
