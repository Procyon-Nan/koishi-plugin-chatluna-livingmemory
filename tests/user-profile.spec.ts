import assert from 'node:assert/strict'
import type { Context } from 'koishi'
import type {
    MemoryEntryRecord,
    UserProfileInput
} from '../src/contracts/memory'
import type { UserProfileRepository } from '../src/contracts/workflows'
import { characterPresetSuffix } from '../src/service/memory/helpers'
import { LivingMemoryUserProfileService } from '../src/service/user_profile'

const now = new Date('2026-07-16T00:00:00.000Z')
const memory: MemoryEntryRecord = {
    id: 'memory-1',
    presetId: 'preset-1',
    type: 'fact',
    status: 'active',
    content: '张三正在准备考试。',
    keywords: ['张三', '准备考试'],
    summary: '张三正在准备考试',
    sentiment: '关心',
    importance: 0.7,
    sourceConversationId: 'conversation-1',
    sourceOrigins: [],
    embedding: null,
    embeddingModelId: null,
    createdAt: now,
    updatedAt: now
}

const createHarness = (
    options: {
        ctx?: Context
        presetId?: string
    } = {}
) => {
    const savedProfiles: UserProfileInput[] = []
    const debugMessages: string[] = []
    const capturedPrompts: unknown[] = []
    const repository: UserProfileRepository = {
        listPresetSpeakers: async () => [
            {
                id: 'speaker-1',
                presetId: 'preset-1',
                speakerKey: '张三',
                speakerLabel: '张三',
                speakerId: 'user-1',
                createdAt: now,
                updatedAt: now
            }
        ],
        upsertPresetSpeaker: async () => {},
        listUserProfilesByPreset: async () => [],
        listUserProfilesBySpeakerKeys: async () => [],
        replaceUserProfile: async (_presetId, profile) => {
            savedProfiles.push(profile)
        },
        deleteUserProfile: async () => {}
    }
    const defaultCtx = {
        chatluna: {
            preset: {
                getPreset: () => ({ value: {} })
            },
            promptRenderer: {
                renderPresetTemplate: async () => ({
                    messages: [
                        {
                            content: '你是测试角色。',
                            getType: () => 'system'
                        }
                    ]
                })
            }
        }
    } as unknown as Context
    const ctx = options.ctx ?? defaultCtx
    const service = new LivingMemoryUserProfileService(
        ctx,
        {
            enableUserProfileInjection: true,
            userProfileMemoryLimit: 20
        },
        repository,
        (message) => debugMessages.push(message)
    )

    return {
        savedProfiles,
        debugMessages,
        capturedPrompts,
        run: async (output: unknown) =>
            await service.regenerate(
                options.presetId ?? 'preset-1',
                [memory],
                async (prompt) => {
                    capturedPrompts.push(prompt)
                    return JSON.stringify([output])
                }
            )
    }
}

const baseProfileOutput = {
    speakerLabel: '张三',
    content: '我知道张三正在准备考试。'
}

const invalidSourceMemoryIds = [
    ['missing', undefined],
    ['non-array', 'memory-1'],
    ['empty', []],
    ['invalid-type', ['memory-1', 1]],
    ['outside-allowed-set', ['memory-2']]
] as const

for (const [name, sourceMemoryIds] of invalidSourceMemoryIds) {
    it(`rejects a user profile with ${name} sourceMemoryIds`, async () => {
        const harness = createHarness()
        const output =
            sourceMemoryIds === undefined
                ? { ...baseProfileOutput }
                : { ...baseProfileOutput, sourceMemoryIds }

        const result = await harness.run(output)

        assert.equal(result.generated, 0)
        assert.equal(harness.savedProfiles.length, 0)
        assert.match(result.detail, /failed=1/u)
        assert.ok(
            harness.debugMessages.some((message) =>
                message.includes('sourceMemoryIds')
            )
        )
    })
}

it('rejects a non-object user profile without sourceMemoryIds', async () => {
    const harness = createHarness()

    const result = await harness.run(null)

    assert.equal(result.generated, 0)
    assert.equal(harness.savedProfiles.length, 0)
    assert.match(result.detail, /failed=1/u)
})

it('passes user profile rules and memory data through PromptMessages', async () => {
    const harness = createHarness()

    await harness.run({
        ...baseProfileOutput,
        sourceMemoryIds: ['memory-1']
    })

    assert.equal(harness.capturedPrompts.length, 1)
    const prompt = harness.capturedPrompts[0] as {
        systemPrompt: string
        inputPrompt: string
    }
    assert.match(prompt.systemPrompt, /<output_contract>/u)
    assert.match(prompt.systemPrompt, /<perspective_contract>/u)
    assert.match(
        prompt.systemPrompt,
        /你是preset-1，你正在以本人关系视角维护一名用户的长期画像/u
    )
    assert.match(
        prompt.systemPrompt,
        /“我”始终指preset-1/u
    )
    assert.match(prompt.systemPrompt, /有依据的主观印象/u)
    assert.doesNotMatch(prompt.systemPrompt, /张三正在准备考试/u)
    assert.match(prompt.inputPrompt, /<user_profile_input>/u)
    assert.match(prompt.inputPrompt, /<assistant_label>\npreset-1/u)
    assert.doesNotMatch(prompt.inputPrompt, /<preset_context>\n无/u)
    assert.match(prompt.inputPrompt, /<memory_entries>/u)
    assert.match(prompt.inputPrompt, /张三正在准备考试/u)
})

it('uses the Character preset name as the user profile assistant label', async () => {
    const ctx = {
        chatluna: {
            promptRenderer: {
                renderTemplate: async () => ({ text: '你是角色甲。' })
            }
        },
        chatluna_character: {
            preset: {
                getPreset: async () => ({
                    system: {
                        rawString: '你是角色甲。'
                    }
                })
            }
        }
    } as unknown as Context
    const harness = createHarness({
        ctx,
        presetId: `角色甲${characterPresetSuffix}`
    })

    await harness.run({
        ...baseProfileOutput,
        sourceMemoryIds: ['memory-1']
    })

    const prompt = harness.capturedPrompts[0] as {
        systemPrompt: string
        inputPrompt: string
    }
    assert.match(prompt.systemPrompt, /你是角色甲，/u)
    assert.doesNotMatch(prompt.systemPrompt, /角色甲（Character）/u)
    assert.match(prompt.inputPrompt, /<assistant_label>\n角色甲/u)
})

it('keeps truncated user profile content within the declared maximum', async () => {
    const harness = createHarness()
    const result = await harness.run({
        ...baseProfileOutput,
        content: '甲'.repeat(221),
        sourceMemoryIds: ['memory-1', 'memory-1']
    })

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles.length, 1)
    assert.equal(
        harness.savedProfiles[0]?.content,
        `${'甲'.repeat(217)}...`
    )
    assert.equal(
        Array.from(harness.savedProfiles[0]?.content ?? '').length,
        220
    )
    assert.deepEqual(harness.savedProfiles[0]?.sourceMemoryIds, ['memory-1'])
})
