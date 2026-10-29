import { z } from 'zod'
import { memoryEntryTypes } from '../../contracts/memory'
import { MAX_MEMORY_KEYWORDS } from '../memory/entry_fields'

/**
 * 多个记忆工具共用的记忆字段结构、说明和运行时校验。
 */

const requiredText = (description: string) =>
    z.string().trim().min(1).describe(description)

export const generatedMemorySchema = z
    .object({
        type: z
            .enum(memoryEntryTypes)
            .describe(
                [
                    `记忆类型。必须取以下之一（${memoryEntryTypes.join('|')}）：`,
                    '- identity：用户或是你自己的稳定身份信息，如身份、角色、长期属性。',
                    '- preference：用户或是你自己的长期偏好、习惯、喜恶。',
                    '- fact：已确认的客观事实，如事件、需求、状态，通常关联具体昵称与时间。',
                    '- plan：尚未发生、面向未来的计划、约定或待办。',
                    '- context：当前对话的背景或短期情境，参考价值随时间衰减。',
                    '- other：无法归入以上类别但仍值得长期记住的信息。'
                ].join('\n')
            ),
        content: requiredText(
            '记忆正文。必须使用你的第一人称视角，体现你的人格、语气、关注点与关系态度，口语化且自然地描述你的认识，或与某个人之间的互动、关系、事实或偏好，追求详略得当，避免流水账；字数保持在 300 字以内。'
        ),
        summary: requiredText(
            '利于语义检索的概括性摘要。必须使用你的第一人称视角，简短、清晰、准确；避免颜文字、口癖、吐槽、抒情、语气化和长句。'
        ),
        keywords: z
            .array(requiredText('记忆的关键词。'))
            .min(1)
            .max(MAX_MEMORY_KEYWORDS)
            .describe(
                `使用 1 到 ${MAX_MEMORY_KEYWORDS} 个关键词刻画记忆的核心主题。`
            ),
        speakerLabels: z
            .array(requiredText('与记忆相关的用户。'))
            .describe(
                '填写与这一条记忆内容相关的所有用户昵称，记忆只涉及你自身时填写空数组。必须准确使用输入材料中提供的用户昵称，禁止捏造或擅自更改。'
            ),
        sentiment: requiredText(
            '简短的情绪标注词。可使用“担心”、“亲近”、“愉快”、“疲惫”、“平静”等词；没有明显情绪时可写“平静”。'
        ),
        importance: z
            .number()
            .finite()
            .min(0)
            .max(1)
            .describe(
                '记忆的重要性。使用 0 到 1 之间的数字，数字越大表示重要性越高。'
            )
    })
    .describe(
        '在记忆中描述某个用户时，必须使用当前输入材料中的具体用户昵称。避免用“用户”、“对方”等泛化词汇或用户 ID 替代，也不要把多个不同用户混成同一个人。' +
            '相对时间（如"今天"、"明天"、"上周"）必须结合对话上下文转换为具体日期；短期状态、身体状态、临时计划等可能在之后变化的内容，必须在 content 中写明具体日期。'
    )
