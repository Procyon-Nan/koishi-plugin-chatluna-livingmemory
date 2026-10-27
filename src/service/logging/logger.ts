import { Logger } from 'koishi'

export interface LivingMemoryLogFields extends Record<string, unknown> {
    presetId?: string
    conversationId?: string
    model?: string
    attempt?: number
    speaker?: string
    batch?: string
}

export const formatLogScope = (scope: {
    presetId?: string
    conversationId?: string
}) => {
    const details: string[] = []
    if (scope.presetId != null) details.push(`预设：${scope.presetId}`)
    if (scope.conversationId != null) {
        const conversation = scope.conversationId
            .replace(/^group:/, '群聊 ')
            .replace(/^private:/, '私聊 ')
        details.push(`会话：${conversation}`)
    }
    return details.join('; ')
}
export interface LivingMemoryLogBlock {
    title: string
    subtitle?: string
    value: unknown
    key?: string
    fields?: LivingMemoryLogFields
}

type LivingMemoryLogSink = Pick<Logger, 'info' | 'warn' | 'error'>
type LivingMemoryLogLevel = keyof LivingMemoryLogSink

interface LivingMemoryLoggerState {
    failureReported: boolean
}

const credentialKeyPattern =
    /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|(?:^|[-_])token(?:$|[-_])|password|secret)/iu
const bareValuePattern = /^[\p{L}\p{N}._:/@*+-]+$/u

const toError = (error: unknown) =>
    error instanceof Error ? error : new Error(String(error))

const normalizeValue = (
    value: unknown,
    key: string,
    seen: WeakSet<object>
): unknown => {
    if (credentialKeyPattern.test(key)) {
        return '[REDACTED]'
    }
    if (
        value == null ||
        typeof value === 'boolean' ||
        typeof value === 'string'
    ) {
        return value
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : String(value)
    }
    if (typeof value === 'bigint') {
        return `${value}n`
    }
    if (typeof value === 'symbol' || typeof value === 'function') {
        return `[${typeof value}]`
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            cause:
                value.cause == null
                    ? undefined
                    : normalizeValue(value.cause, 'cause', seen)
        }
    }
    const objectValue = value as object
    if (seen.has(objectValue)) {
        return '[Circular]'
    }
    seen.add(objectValue)
    try {
        if (Array.isArray(value)) {
            return value.map((item) => normalizeValue(item, '', seen))
        }
        const normalized: Record<string, unknown> = {}
        for (const entryKey of Object.keys(value).sort()) {
            const entryValue = normalizeValue(
                (value as Record<string, unknown>)[entryKey],
                entryKey,
                seen
            )
            if (entryValue !== undefined) {
                normalized[entryKey] = entryValue
            }
        }
        return normalized
    } finally {
        seen.delete(objectValue)
    }
}

const stringifyNormalized = (
    value: unknown,
    key: string,
    options: { indent?: number; bareStringsOnly: boolean }
) => {
    const normalized = normalizeValue(value, key, new WeakSet())
    if (
        typeof normalized === 'string' &&
        (!options.bareStringsOnly || bareValuePattern.test(normalized))
    ) {
        return normalized
    }
    const serialized = JSON.stringify(normalized, null, options.indent)
    return serialized === undefined ? '"[unserializable]"' : serialized
}

const formatValue = (value: unknown, key: string) =>
    stringifyNormalized(value, key, { bareStringsOnly: true })

const formatBlockValue = (value: unknown, key: string) =>
    stringifyNormalized(value, key, { indent: 2, bareStringsOnly: false })

const formatFields = (fields: LivingMemoryLogFields) =>
    Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}：${formatValue(value, key)}`)
        .join('; ')

const formatBlock = (block: LivingMemoryLogBlock) => {
    const title = block.title.replace(/\r?\n/gu, ' ')
    const detail = formatFields(block.fields ?? {})
    const heading = detail.length > 0 ? `${title} ${detail}` : title
    const lines = [`========${heading}========`]
    if (block.subtitle != null) {
        lines.push(block.subtitle.replace(/\r?\n/gu, ' '))
    }
    lines.push(formatBlockValue(block.value, block.key ?? ''))
    return lines.join('\n')
}

const emitCompleteMessage = (sink: LivingMemoryLogSink, emit: () => void) => {
    if (!(sink instanceof Logger)) {
        emit()
        return
    }

    // reggol 默认把每个物理行截断到 10240 字符；输出调用是同步的，
    // 因此只在当前 Living Memory 日志写入期间解除限制并立即恢复 target 配置。
    const targets = Logger.targets as (Logger.Target & {
        maxLength?: number
    })[]
    const originalLimits = targets.map((target) => ({
        target,
        hasOwnLimit: Object.prototype.hasOwnProperty.call(target, 'maxLength'),
        maxLength: target.maxLength
    }))
    try {
        for (const target of targets) {
            target.maxLength = Number.POSITIVE_INFINITY
        }
        emit()
    } finally {
        for (const original of originalLimits) {
            if (original.hasOwnLimit) {
                original.target.maxLength = original.maxLength
            } else {
                delete original.target.maxLength
            }
        }
    }
}

export class LivingMemoryLogger {
    constructor(
        private readonly sink: LivingMemoryLogSink,
        private readonly isDebugEnabled: () => boolean,
        private readonly context: LivingMemoryLogFields = {},
        private readonly state: LivingMemoryLoggerState = {
            failureReported: false
        }
    ) {}

    with(fields: LivingMemoryLogFields) {
        return new LivingMemoryLogger(
            this.sink,
            this.isDebugEnabled,
            { ...this.context, ...fields },
            this.state
        )
    }

    diagnosticSummary(
        render: (context: LivingMemoryLogFields) =>
            | {
                  event: string
                  detail: string
                  blocks?: LivingMemoryLogBlock[]
              }
            | undefined
    ) {
        if (!this.isDebugEnabled()) return
        try {
            const rendered = render(this.context)
            if (rendered === undefined) return
            const { event, detail, blocks } = rendered
            let content = detail
            if (blocks?.length) {
                content += '\n' + blocks.map(formatBlock).join('\n\n')
            }
            this.summary(event, content)
        } catch (error) {
            this.reportFailure(error)
        }
    }

    summary(
        event: string,
        detail:
            | string
            | string[]
            | ((context: LivingMemoryLogFields) => string),
        level: LivingMemoryLogLevel = 'info',
        error?: unknown
    ) {
        try {
            const resolved =
                typeof detail === 'function' ? detail(this.context) : detail
            const content = Array.isArray(resolved)
                ? `\n${resolved.join('\n')}`
                : ` ${resolved}`
            emitCompleteMessage(this.sink, () => {
                const message = `事件：${event};${content}`
                if (error === undefined) this.sink[level](message)
                else this.sink[level](`${message}\n%o`, toError(error))
            })
        } catch (error) {
            this.reportFailure(error)
        }
    }

    private reportFailure(error: unknown) {
        if (this.state.failureReported) return
        this.state.failureReported = true
        try {
            this.sink.warn(
                '事件：日志输出失败; 操作：输出日志\n%o',
                toError(error)
            )
        } catch {
            // 日志是旁路能力，底层 logger 故障不得影响业务流程。
        }
    }
}
