import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import type { Context } from 'koishi'
import type {
    MemoryEntryRecord,
    UserProfileInput
} from '../src/contracts/memory'
import type { UserProfileRepository } from '../src/contracts/workflows'
import { characterPresetSuffix } from '../src/service/memory/helpers'
import { userProfileResultToolName } from '../src/service/prompts/schema'
import { LivingMemoryUserProfileService } from '../src/service/user_profile'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'

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
    isConsolidated: false,
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
        run: async (
            responses: Parameters<typeof createToolCallingModel>[0]
        ) => {
            const model = createToolCallingModel(responses)
            const result = await service.regenerate(
                options.presetId ?? 'preset-1',
                [memory],
                model.model
            )
            return { model, result }
        }
    }
}

const baseProfileOutput = {
    speakerLabel: '张三',
    content: '我知道张三正在准备考试。'
}

const createProfileCall = (profile: unknown, id = 'result-1') => {
    return createToolCallMessage(
        userProfileResultToolName,
        { profiles: [profile] },
        id
    )
}

const readPromptMessages = (
    model: ReturnType<typeof createToolCallingModel>
) => {
    const messages = model.invocations[0]?.messages ?? []
    return {
        systemPrompt: String(
            messages.find((message) => message.getType() === 'system')
                ?.content ?? ''
        ),
        inputPrompt: String(
            messages.find((message) => message.getType() === 'human')
                ?.content ?? ''
        )
    }
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

        const { result } = await harness.run([
            createProfileCall(output),
            createProfileCall(output, 'result-2')
        ])

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

    const { result } = await harness.run([
        createProfileCall(null),
        createProfileCall(null, 'result-2')
    ])

    assert.equal(result.generated, 0)
    assert.equal(harness.savedProfiles.length, 0)
    assert.match(result.detail, /failed=1/u)
})

it('passes user profile rules and memory data through tool-calling messages', async () => {
    const harness = createHarness()

    const { model } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            sourceMemoryIds: ['memory-1']
        })
    ])

    assert.equal(model.invocations.length, 1)
    const prompt = readPromptMessages(model)
    assert.match(prompt.systemPrompt, /<output_contract>/u)
    assert.match(prompt.systemPrompt, /<perspective_contract>/u)
    assert.match(
        prompt.systemPrompt,
        /你是preset-1，你正在以本人关系视角维护一名用户的长期画像/u
    )
    assert.match(prompt.systemPrompt, /“我”始终指preset-1/u)
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

    const { model } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            sourceMemoryIds: ['memory-1']
        })
    ])

    const prompt = readPromptMessages(model)
    assert.match(prompt.systemPrompt, /你是角色甲，/u)
    assert.doesNotMatch(prompt.systemPrompt, /角色甲（Character）/u)
    assert.match(prompt.inputPrompt, /<assistant_label>\n角色甲/u)
})

it('keeps truncated user profile content within the declared maximum', async () => {
    const harness = createHarness()
    const { result } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            content: '甲'.repeat(221),
            sourceMemoryIds: ['memory-1', 'memory-1']
        })
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles.length, 1)
    assert.equal(harness.savedProfiles[0]?.content, `${'甲'.repeat(217)}...`)
    assert.equal(
        Array.from(harness.savedProfiles[0]?.content ?? '').length,
        220
    )
    assert.deepEqual(harness.savedProfiles[0]?.sourceMemoryIds, ['memory-1'])
})

it('accepts a stringified profiles array through bounded normalization', async () => {
    const harness = createHarness()
    const { model, result } = await harness.run([
        createToolCallMessage(userProfileResultToolName, {
            profiles: JSON.stringify([
                {
                    ...baseProfileOutput,
                    sourceMemoryIds: ['memory-1']
                }
            ])
        })
    ])

    assert.equal(result.generated, 1)
    assert.equal(model.invocations.length, 1)
    assert.ok(
        harness.debugMessages.some((message) =>
            message.includes('decoded stringified JSON array field: profiles')
        )
    )
})

it('retries once after a non-tool response', async () => {
    const harness = createHarness()
    const { model, result } = await harness.run([
        new AIMessage('普通文本画像'),
        createProfileCall(
            {
                ...baseProfileOutput,
                sourceMemoryIds: ['memory-1']
            },
            'result-2'
        )
    ])

    assert.equal(result.generated, 1)
    assert.equal(model.invocations.length, 2)
})

it('feeds invalid source memory ids back before accepting a correction', async () => {
    const harness = createHarness()
    const { model, result } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            sourceMemoryIds: ['memory-2']
        }),
        createProfileCall(
            {
                ...baseProfileOutput,
                sourceMemoryIds: ['memory-1']
            },
            'result-2'
        )
    ])

    assert.equal(result.generated, 1)
    assert.equal(model.invocations.length, 2)
    const retryMessages = model.invocations[1]?.messages ?? []
    assert.ok(
        retryMessages.some((message) =>
            String(message.content).includes(
                '来源记忆 id 不在当前画像允许的集合中'
            )
        )
    )
})

it('rejects a profile for a different speaker after the correction attempt', async () => {
    const harness = createHarness()
    const wrongSpeakerProfile = {
        ...baseProfileOutput,
        speakerLabel: '李四',
        sourceMemoryIds: ['memory-1']
    }
    const { model, result } = await harness.run([
        createProfileCall(wrongSpeakerProfile),
        createProfileCall(wrongSpeakerProfile, 'result-2'),
        createProfileCall(wrongSpeakerProfile, 'result-3')
    ])

    assert.equal(result.generated, 0)
    assert.equal(model.invocations.length, 3)
    assert.equal(harness.savedProfiles.length, 0)
    assert.match(result.detail, /failed=1/u)
    assert.ok(
        harness.debugMessages.some((message) =>
            message.includes('profiles.0.speakerLabel')
        )
    )
})

it('preserves brackets inside profile content', async () => {
    const harness = createHarness()
    const content = '我记得张三把这件事标成了[注意]。'
    const { result } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            content,
            sourceMemoryIds: ['memory-1']
        })
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles[0]?.content, content)
})

it('treats an empty profiles result as a valid no-op', async () => {
    const harness = createHarness()
    const { result } = await harness.run([
        createToolCallMessage(userProfileResultToolName, { profiles: [] })
    ])

    assert.equal(result.generated, 0)
    assert.equal(harness.savedProfiles.length, 0)
    assert.match(result.detail, /empty=1/u)
    assert.match(result.detail, /failed=0/u)
})
