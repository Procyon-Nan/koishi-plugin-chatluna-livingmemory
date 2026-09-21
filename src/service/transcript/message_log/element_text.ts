import { toNonEmptyString } from '../../shared/utils'

/**
 * 日志写入侧可见的元素最小形状：采集器传入 h 实例，回填传入镜像对象，
 * 两者结构同形，提取逻辑不区分来源。
 */
export interface LogTextElement {
    type: string
    attrs?: Record<string, unknown> | null
    children?: ReadonlyArray<LogTextElement>
}

/**
 * at 目标的用户昵称解析。与说话人标签同一口径（bot.getUser().name），
 * 使「@昵称」能与聊天记录中的说话人昵称互相指认；返回 null 时退回 @id。
 * 同步签名：渲染与实时入账不得因解析让出事件循环，异步查询留在通道层。
 */
export type AtLabelResolver = (userId: string) => string | null

/** 文字格式容器：递归提取子元素正文，展示格式不吞文字。 */
const TEXT_CONTAINER_TYPES: ReadonlySet<string> = new Set([
    'p',
    'b',
    'strong',
    'i',
    'em',
    'u',
    'ins',
    's',
    'del',
    'code',
    'pre',
    'spl',
    'a'
])

const attrText = (
    attrs: Record<string, unknown> | null | undefined,
    key: string
) => {
    return toNonEmptyString(attrs?.[key])
}

const isForwardAttr = (attrs: Record<string, unknown> | null | undefined) => {
    // message 元素以 forward 属性标记转发，与 ChatLuna/Character 的判定同形
    return ['true', '1'].includes(String(attrs?.['forward']))
}

const renderForward = (attrs: Record<string, unknown> | null | undefined) => {
    // Milky 的转发自带标题与内容预览；OneBot 只有不可读的 resid，不渲染。
    const detail = [
        attrText(attrs, 'title'),
        attrText(attrs, 'summary')
    ].filter((part) => part != null)
    return detail.length > 0 ? `[聊天记录:${detail.join(' ')}]` : '[聊天记录]'
}

/**
 * QQ 卡片 json 只取关键字段：prompt（展示行）、meta.detail_1.title（来源
 * 应用名）、meta.detail_1.host.nick（分享者）。其余结构化字段对记忆无意义
 * 且体积巨大，不进入模型可见历史。载荷非法时退纯占位。
 */
const renderJsonCard = (
    rawPayload: string | undefined,
    appName: string | undefined
) => {
    let prompt: string | undefined
    let source = appName
    let sharer: string | undefined

    if (rawPayload != null) {
        try {
            const payload = JSON.parse(rawPayload) as {
                prompt?: unknown
                desc?: unknown
                meta?: {
                    detail_1?: { title?: unknown; host?: { nick?: unknown } }
                }
            }
            prompt = toNonEmptyString(payload.prompt)
            const detail = payload.meta?.detail_1
            source = toNonEmptyString(detail?.title) ?? source
            sharer = toNonEmptyString(detail?.host?.nick)
            prompt ??= toNonEmptyString(payload.desc)
        } catch {
            // 平台载荷不受本插件控制，非法 JSON 按纯占位处理
        }
    }

    const head = source == null ? '[卡片消息]' : `[卡片:${source}]`
    const body = prompt == null ? '' : ` ${prompt}`
    const tail = sharer == null ? '' : `（分享者：${sharer}）`
    return `${head}${body}${tail}`
}

/**
 * 递归工作函数：向同一个 parts 追加文本，trim 只在顶层入口做一次——
 * 逐层 trim 会吃掉容器边界的空格与换行（如 <b>Hello </b>world）。
 */
const appendElementText = (
    parts: string[],
    elements: ReadonlyArray<LogTextElement>,
    resolveAtLabel?: AtLabelResolver
) => {
    for (const element of elements) {
        const attrs = element.attrs ?? {}
        if (element.type === 'br') {
            parts.push('\n')
            continue
        }
        if (TEXT_CONTAINER_TYPES.has(element.type)) {
            const start = parts.length
            appendElementText(parts, element.children ?? [], resolveAtLabel)
            if (parts.length === start) {
                if (element.type === 'a') {
                    const href = attrText(attrs, 'href')
                    if (href != null) {
                        parts.push(`[链接:${href}]`)
                    }
                }
            } else if (element.type === 'p') {
                parts.push('\n')
            }
            continue
        }

        switch (element.type) {
            case 'text': {
                const text = attrs['content']
                parts.push(typeof text === 'string' ? text : '')
                break
            }
            case 'at': {
                // name 属性是群名片口径，与聊天记录的说话人昵称无法互相指认，
                // 不采信；按目标用户昵称解析，失败退 @id
                if (attrs['type'] === 'all') {
                    parts.push('@全体成员')
                    break
                }
                const targetId = attrText(attrs, 'id')
                if (targetId == null) {
                    parts.push('[非文本消息]')
                    break
                }
                parts.push(`@${resolveAtLabel?.(targetId) ?? targetId}`)
                break
            }
            case 'face': {
                const name = attrText(attrs, 'name')
                parts.push(name == null ? '[表情]' : `[表情:${name}]`)
                break
            }
            case 'img':
            case 'image':
                parts.push('[图片]')
                break
            case 'audio':
                parts.push('[语音]')
                break
            case 'video':
                parts.push('[视频]')
                break
            case 'file': {
                const name =
                    attrText(attrs, 'name') ??
                    attrText(attrs, 'title') ??
                    attrText(attrs, 'file_name')
                parts.push(name == null ? '[文件]' : `[文件:${name}]`)
                break
            }
            case 'forward':
            case 'milky:forward':
                parts.push(renderForward(attrs))
                break
            case 'json':
                parts.push(renderJsonCard(attrText(attrs, 'data'), undefined))
                break
            case 'milky:light-app':
                parts.push(
                    renderJsonCard(
                        attrText(attrs, 'jsonPayload'),
                        attrText(attrs, 'appName')
                    )
                )
                break
            case 'xml':
                parts.push('[卡片消息]')
                break
            case 'share': {
                const title = attrText(attrs, 'title')
                parts.push(title == null ? '[分享]' : `[分享:${title}]`)
                break
            }
            case 'location': {
                const title = attrText(attrs, 'title')
                parts.push(title == null ? '[位置]' : `[位置:${title}]`)
                break
            }
            case 'contact':
                parts.push('[联系人]')
                break
            case 'dice':
                parts.push('[骰子]')
                break
            case 'rps':
                parts.push('[猜拳]')
                break
            case 'mface': {
                const name = attrText(attrs, 'name')
                parts.push(name == null ? '[表情包]' : `[表情包:${name}]`)
                break
            }
            case 'quote':
                parts.push('[引用回复]')
                break
            case 'message':
                parts.push(
                    isForwardAttr(attrs) ? renderForward(attrs) : '[非文本消息]'
                )
                break
            default:
                parts.push('[非文本消息]')
                break
        }
    }
}

/**
 * 消息元素到日志文本的统一提取（同步纯函数）：文本元素直取正文，文字
 * 格式容器递归提取正文（br/段落边界换行），非文本元素替换为占位说明，
 * 元素标签的序列化形式不得进入模型可见历史。采集与回填共用。
 */
export const elementsToLogText = (
    elements: ReadonlyArray<LogTextElement> | null | undefined,
    resolveAtLabel?: AtLabelResolver
) => {
    if (elements == null || elements.length === 0) {
        return ''
    }

    const parts: string[] = []
    appendElementText(parts, elements, resolveAtLabel)
    return parts.join('').trim()
}

/**
 * 收集渲染会实际展开的 at 目标 id，遍历规则与 appendElementText 共用
 * 同一文字容器集合——占位元素内部的 at 对输出不可见，不进入查询范围。
 */
export const collectVisibleAtTargetIds = (
    elements: ReadonlyArray<LogTextElement>,
    ids: Set<string>
) => {
    for (const element of elements) {
        if (element.type === 'br') {
            continue
        }
        if (TEXT_CONTAINER_TYPES.has(element.type)) {
            collectVisibleAtTargetIds(element.children ?? [], ids)
            continue
        }
        if (element.type === 'at' && element.attrs?.['type'] !== 'all') {
            const id = toNonEmptyString(element.attrs?.['id'])
            if (id != null) {
                ids.add(id)
            }
        }
    }
}
