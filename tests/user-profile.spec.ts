import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import type { Context } from 'koishi'
import { LivingMemoryLogger } from '../src/service/logging/logger'
import type {
    MemoryEntryRecord,
    UserProfileInput
} from '../src/contracts/memory'
import type {
    UserProfileMemoryRepository,
    UserProfileRepository
} from '../src/contracts/workflows'
import { characterPresetSuffix } from '../src/service/memory/helpers'
import { userProfileResultToolName } from '../src/service/prompts/schema'
import {
    LivingMemoryUserProfileService,
    normalizeManualUserProfileContent
} from '../src/service/user_profile'
import {
    createToolCallingModel,
    createToolCallMessage
} from './tool-calling-test-utils'

const now = new Date('2026-07-16T00:00:00.000Z')
const memory: MemoryEntryRecord = {
    id: 'memory-1',
    presetId: 'preset-1',
    speakerKeys: ['张三'],
    type: 'fact',
    status: 'active',
    content: '张三正在准备考试。',
    keywords: ['张三', '准备考试'],
    summary: '张三正在准备考试',
    sentiment: '关心',
    importance: 0.7,
    sourceConversationId: 'conversation-1',
    sourceOrigins: [],
    isConsolidated: true,
    createdAt: now,
    updatedAt: now
}

const createHarness = (
    options: {
        ctx?: Context
        presetId?: string
        speakerLabel?: string
        speakerAliases?: string[]
        userProfileMinMemoryCount?: number
        existingSourceMemoryIds?: string[]
        existingProfileUpdatedAt?: Date
    } = {}
) => {
    const savedProfiles: UserProfileInput[] = []
    const debugMessages: string[] = []
    const existingProfiles =
        options.existingSourceMemoryIds == null
            ? []
            : [
                  {
                      id: 'profile-1',
                      presetId: options.presetId ?? 'preset-1',
                      speakerKey: '张三',
                      speakerLabel: options.speakerLabel ?? '张三',
                      content: '旧画像',
                      sourceMemoryIds: options.existingSourceMemoryIds,
                      createdAt: now,
                      updatedAt: options.existingProfileUpdatedAt ?? now
                  }
              ]
    const repository: UserProfileRepository & UserProfileMemoryRepository = {
        getEntriesByPresetAndIds: async () => [memory],
        listActiveMemorySpeakerLinks: async () => [
            { speakerKey: '张三', memoryId: memory.id }
        ],
        listPresetSpeakers: async () => [
            {
                id: 'speaker-1',
                presetId: 'preset-1',
                speakerKey: '张三',
                speakerLabel: options.speakerLabel ?? '张三',
                speakerAliases: options.speakerAliases ?? ['张三'],
                speakerId: 'user-1',
                platform: 'test',
                createdAt: now,
                updatedAt: now
            }
        ],
        upsertPresetSpeaker: async () => {},
        listUserProfilesByPreset: async () => existingProfiles,
        listUserProfilesBySpeakerKeys: async () => existingProfiles,
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
            userProfileMinMemoryCount: options.userProfileMinMemoryCount ?? 1,
            userProfileMemoryLimit: 20
        },
        repository,
        new LivingMemoryLogger(
            {
                info: (message: unknown) => debugMessages.push(String(message)),
                warn: () => {},
                error: () => {}
            } as never,
            () => true
        )
    )

    return {
        savedProfiles,
        debugMessages,
        run: async (
            responses: Parameters<typeof createToolCallingModel>[0],
            logger?: LivingMemoryLogger
        ) => {
            const model = createToolCallingModel(responses)
            const result = await service.regenerate(
                options.presetId ?? 'preset-1',
                [memory.speakerKeys[0]],
                model.model,
                logger
            )
            return { model, result }
        }
    }
}

it('accepts manual user profile content without a length limit', () => {
    assert.equal(normalizeManualUserProfileContent('  手工画像  '), '手工画像')
    assert.throws(() => normalizeManualUserProfileContent('  '), /不能为空/u)
    assert.equal(
        normalizeManualUserProfileContent('甲'.repeat(301)),
        '甲'.repeat(301)
    )
})

it('matches Dream memories through a stable user identity old nickname', async () => {
    const harness = createHarness({
        speakerLabel: '新昵称',
        speakerAliases: ['张三', '新昵称']
    })
    const { result } = await harness.run([
        createProfileCall({
            content: '我知道该用户正在准备考试。'
        })
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles[0].speakerLabel, '新昵称')
})

it('skips profile generation below the active memory threshold', async () => {
    const harness = createHarness({ userProfileMinMemoryCount: 2 })
    const { model, result } = await harness.run([
        createProfileCall({ content: '不应生成。' })
    ])

    assert.equal(result.generated, 0)
    assert.equal(result.skippedReason, 'insufficient-related-memories')
    assert.equal(model.invocations.length, 0)
})

it('skips regeneration when the profile input is unchanged', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: [memory.id],
        existingProfileUpdatedAt: new Date(+now + 1)
    })
    const { model, result } = await harness.run([
        createProfileCall({ content: '不应生成。' })
    ])

    assert.equal(result.generated, 0)
    assert.equal(result.skippedReason, 'unchanged')
    assert.equal(model.invocations.length, 0)
    assert.equal(harness.savedProfiles.length, 0)
})

it('regenerates when the profile is not newer than its memories', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: [memory.id],
        existingProfileUpdatedAt: now
    })
    const { model, result } = await harness.run([
        createProfileCall(baseProfileOutput)
    ])

    assert.equal(result.generated, 1)
    assert.equal(model.invocations.length, 1)
    assert.match(result.detail, /unchanged=0/u)
})

const baseProfileOutput = {
    content: '我知道张三正在准备考试。'
}

const createProfileCall = (
    profile: Record<string, unknown>,
    id = 'result-1'
) => {
    return createToolCallMessage(userProfileResultToolName, profile, id)
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

it('passes user profile rules and memory data through tool-calling messages', async () => {
    const harness = createHarness()

    const { model } = await harness.run([createProfileCall(baseProfileOutput)])

    assert.equal(model.invocations.length, 1)
    const prompt = readPromptMessages(model)
    assert.match(prompt.systemPrompt, /<output_contract>/u)
    assert.match(prompt.systemPrompt, /<update_rules>/u)
    assert.match(prompt.systemPrompt, /<preset_context>/u)
    assert.match(prompt.systemPrompt, /你是preset-1，你正在维护张三的人物画像/u)
    assert.match(prompt.systemPrompt, /张三的关系视角，使用第三人称/u)
    assert.doesNotMatch(prompt.systemPrompt, /张三正在准备考试/u)
    assert.match(prompt.inputPrompt, /<user_profile_input>/u)
    assert.doesNotMatch(prompt.inputPrompt, /<assistant_label>/u)
    assert.doesNotMatch(prompt.inputPrompt, /<speaker_label>/u)
    assert.doesNotMatch(prompt.inputPrompt, /<preset_context>/u)
    assert.doesNotMatch(prompt.inputPrompt, /<existing_source_memory_ids>/u)
    assert.match(prompt.inputPrompt, /<memory_entries>/u)
    assert.match(prompt.inputPrompt, /张三正在准备考试/u)
})

it('keeps user profile payloads out of ordinary debug logs', async () => {
    const harness = createHarness()
    await harness.run([createProfileCall(baseProfileOutput)])

    assert.ok(
        harness.debugMessages.every(
            (message) =>
                !message.includes(memory.content) &&
                !message.includes(baseProfileOutput.content)
        )
    )
})

it('keeps user profile failures correlated with the Dream job', async () => {
    const harness = createHarness()
    const messages: string[] = []
    const jobLogger = new LivingMemoryLogger(
        {
            info: (message: unknown) => messages.push(String(message)),
            warn: () => {},
            error: () => {}
        } as never,
        () => true
    ).with({
        workflow: 'dream',
        jobId: 'dream-job-1',
        presetId: 'preset-1',
        trigger: 'manual'
    })

    await harness.run(
        [
            new AIMessage('invalid profile result'),
            new AIMessage('invalid profile result'),
            new AIMessage('invalid profile result')
        ],
        jobLogger
    )

    assert.ok(
        messages.some((message) =>
            /event=user-profile.skipped workflow=dream jobId=dream-job-1 .*presetId=preset-1.*trigger=manual/u.test(
                message
            )
        )
    )
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

    const { model } = await harness.run([createProfileCall(baseProfileOutput)])

    const prompt = readPromptMessages(model)
    assert.match(prompt.systemPrompt, /你是角色甲，/u)
    assert.doesNotMatch(prompt.systemPrompt, /角色甲（Character）/u)
    assert.doesNotMatch(prompt.inputPrompt, /<assistant_label>/u)
})

it('does not rewrite or truncate generated user profile content', async () => {
    const harness = createHarness({
        existingSourceMemoryIds: ['memory-old']
    })
    const content = `张三的人物画像：${'甲'.repeat(301)}`
    const { result } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            content
        })
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles.length, 1)
    assert.equal(harness.savedProfiles[0]?.content, content)
    assert.deepEqual(harness.savedProfiles[0]?.sourceMemoryIds, ['memory-1'])
})

it('retries once after a non-tool response', async () => {
    const harness = createHarness()
    const { model, result } = await harness.run([
        new AIMessage('普通文本画像'),
        createProfileCall(baseProfileOutput, 'result-2')
    ])

    assert.equal(result.generated, 1)
    assert.equal(model.invocations.length, 2)
})

it('preserves brackets inside profile content', async () => {
    const harness = createHarness()
    const content = '我记得张三把这件事标成了[注意]。'
    const { result } = await harness.run([
        createProfileCall({
            ...baseProfileOutput,
            content
        })
    ])

    assert.equal(result.generated, 1)
    assert.equal(harness.savedProfiles[0]?.content, content)
})

it('treats null content as a valid no-op', async () => {
    const harness = createHarness()
    const { result } = await harness.run([
        createToolCallMessage(userProfileResultToolName, { content: null })
    ])

    assert.equal(result.generated, 0)
    assert.equal(harness.savedProfiles.length, 0)
    assert.match(result.detail, /empty=1/u)
    assert.match(result.detail, /failed=0/u)
})
