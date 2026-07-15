import { memoryEntryTypes } from '../../contracts/memory'
import { MAX_MEMORY_KEYWORDS } from '../memory/entry_fields'

export const MEMORY_TYPE_OPTIONS = memoryEntryTypes.join('|')

export const MEMORY_COMPLETE_FIELD_LIST =
    'type、content、summary、keywords、sentiment、importance'

export const MEMORY_TYPE_GUIDE = [
    `- type：必须取以下之一（${MEMORY_TYPE_OPTIONS}）：`,
    '  - identity：发言者或当前角色的稳定身份信息，如身份、角色、长期属性。',
    '  - preference：发言者的长期偏好、习惯、喜恶。',
    '  - fact：已确认的客观事实，如事件、需求、状态，通常关联具体昵称与时间。',
    '  - plan：尚未发生、面向未来的计划、约定或待办。',
    '  - context：当前对话的背景或短期情境，参考价值随时间衰减。',
    '  - other：无法归入以上类别但仍值得长期记住的信息。'
].join('\n')

export const MEMORY_CONTENT_REQUIREMENT =
    '- content：记忆正文，必须使用当前角色的第一人称关系视角（“我”即当前角色），体现其人格、语气、关注点与关系视角，口语化且自然地描述其与具体发言者之间的互动、关系、事实或偏好；字数保持在 100 字以内。'

export const MEMORY_SUMMARY_REQUIREMENT =
    '- summary：检索友好的语义摘要，第一人称、简短、清晰、准确；避免颜文字、口癖、过度角色语气和长句，不要写成角色台词、吐槽或抒情句。'

export const MEMORY_KEYWORDS_REQUIREMENT =
    '- keywords：短词数组，作为检索锚点，保留具体昵称、状态、动作、关系和事件关键词；' +
    `不要包含普通日期、时间戳；最多 ${MAX_MEMORY_KEYWORDS} 个。`

export const MEMORY_SENTIMENT_REQUIREMENT =
    '- sentiment：简短自由文本的情绪色彩，可使用“担心”、“亲近”、“愉快”、“疲惫”、“中性”等词；没有明显情绪时写“中性”，不要写成长句。'

export const MEMORY_IMPORTANCE_REQUIREMENT =
    '- importance：0 到 1 之间的数字，表示记忆的长期价值，越高越重要；日常闲聊但有关系连续性价值可给 0.4 到 0.7，明确身份、偏好、关系、健康、计划等长期信息可给 0.7 到 1。'

export const MEMORY_SPEAKER_REFERENCE_REQUIREMENT =
    '- 昵称要求：content、summary 和 keywords 中必须沿用输入材料中的具体昵称；绝对不能用“用户”、“对方”等泛化词汇替代，也不要把多名发言者混成同一个人。'
