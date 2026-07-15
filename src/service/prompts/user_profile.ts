import type {
    MemoryEntryRecord,
    UserProfileRecord
} from '../../contracts/memory'
import { formatMemoryEntryForPrompt } from './memory_entries'
import { USER_PROFILE_OUTPUT_FORMAT } from './schema'

export interface UserProfilePromptGroup {
    speakerLabel: string
    entries: MemoryEntryRecord[]
    existingProfile?: UserProfileRecord
}

export interface UserProfilePromptInput {
    presetPrompt?: string | null
    group: UserProfilePromptGroup
    maxProfileLength: number
}

const formatSourceMemoryIds = (sourceMemoryIds: string[]) => {
    const lastIndex = sourceMemoryIds.length - 1

    return sourceMemoryIds
        .map((id, index) => {
            if (index === lastIndex) {
                return id
            }

            return `${id},`
        })
        .join('\n')
}

const formatExistingProfileSection = (
    speakerLabel: string,
    existingProfile?: UserProfileRecord
) => {
    if (existingProfile == null) {
        return '无'
    }

    const section = [existingProfile.content]
    if (existingProfile.sourceMemoryIds.length > 0) {
        section.push(
            `\n【${speakerLabel}已有的个人画像的来源记忆 id】`,
            formatSourceMemoryIds(existingProfile.sourceMemoryIds)
        )
    }

    return section.join('\n')
}

const formatGroup = (group: UserProfilePromptGroup) => {
    return [
        `【${group.speakerLabel}已有的个人画像】`,
        formatExistingProfileSection(group.speakerLabel, group.existingProfile),
        '',
        `【关于${group.speakerLabel}的记忆】`,
        group.entries.map(formatMemoryEntryForPrompt).join('\n\n---\n\n')
    ].join('\n')
}

export const buildUserProfilePrompt = (input: UserProfilePromptInput) => {
    const taskPrompt = [
        '# 任务目标',
        '你要根据你关于某个人的记忆，来生成他/她的个人画像。',
        '你只能使用已有的个人画像和记忆来生成新的个人画像，不要引入这些材料之外的新事实。',
        '',
        '【输出要求】',
        '1. 输出必须是一个可解析 JSON 数组，不要解释，不要 Markdown。',
        `2. 数组元素格式为 ${USER_PROFILE_OUTPUT_FORMAT}。`,
        `3. 数组中最多包含一个元素，speakerLabel 必须严格等于 ${JSON.stringify(input.group.speakerLabel)}。`,
        `4. content 使用第一人称关系视角，描述“我”对这个人的稳定理解；content 的长度不能超过 ${input.maxProfileLength} 个中文字符。`,
        '5. content 不可以用“某某的个人画像”作为开头；标题由代码层渲染。',
        '6. 如果存在已有的个人画像，必须把它作为更新基线：保留未被记忆推翻的稳定信息，并用记忆补充或修正。',
        '7. 如果已有的个人画像与记忆冲突，以记忆中的内容为准。',
        `8. sourceMemoryIds 必须存在且为非空字符串数组，只能从“${input.group.speakerLabel}已有的个人画像的来源记忆 id”和下方“关于${input.group.speakerLabel}的记忆”条目 id 中选择，不得编造。`,
        '9. sourceMemoryIds 缺失、不是数组、为空、包含非字符串或包含允许范围外的 id 时，整个画像输出都会失败。',
        '10. 如果现有画像无需变更，输出空数组 []；如果需要补充、修正或重写画像，输出一个完整的新画像对象，content 必须包含更新后的完整画像内容。',
        '',
        formatGroup(input.group)
    ].join('\n')

    const presetPrompt = input.presetPrompt?.trim()
    if (presetPrompt == null || presetPrompt.length === 0) {
        return taskPrompt
    }

    return [presetPrompt, '', taskPrompt].join('\n')
}
