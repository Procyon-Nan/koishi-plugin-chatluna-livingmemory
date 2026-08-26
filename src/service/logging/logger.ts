import { Logger } from 'koishi'

export type LivingMemoryLogFields = Record<string, unknown>
export type LivingMemoryLogFieldsInput =
    | LivingMemoryLogFields
    | (() => LivingMemoryLogFields)

export interface LivingMemoryLogBlock {
    title: string
    value: unknown
    key?: string
    fields?: LivingMemoryLogFields
}

export type LivingMemoryLogBlocksInput =
    | LivingMemoryLogBlock[]
    | (() => LivingMemoryLogBlock[])

type LivingMemoryLogSink = Pick<Logger, 'info' | 'warn' | 'error'>
type LivingMemoryLogLevel = keyof LivingMemoryLogSink

interface LivingMemoryLoggerState {
    reportingFailure: boolean
    failureReported: boolean
}

const preferredFieldOrder = [
    'workflow',
    'runId',
    'jobId',
    'modelCallId',
    'stage',
    'round',
    'batch',
    'batches',
    'attempt',
    'presetId',
    'conversationId',
    'trigger',
    'operation'
]

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
    if (typeof value !== 'object') {
        return '[unknown]'
    }
    if (seen.has(value)) {
        return '[Circular]'
    }
    seen.add(value)
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
        seen.delete(value)
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

const orderedFieldNames = (fields: LivingMemoryLogFields) => {
    const names = Object.keys(fields).filter(
        (key) => fields[key] !== undefined && !preferredFieldOrder.includes(key)
    )
    names.sort((left, right) => {
        const leftCluster = /^clusters-(\d+)$/u.exec(left)
        const rightCluster = /^clusters-(\d+)$/u.exec(right)
        if (leftCluster && rightCluster) {
            return Number(leftCluster[1]) - Number(rightCluster[1])
        }
        return left < right ? -1 : left > right ? 1 : 0
    })
    return [
        ...preferredFieldOrder.filter((key) => fields[key] !== undefined),
        ...names
    ]
}

const formatBlock = (block: LivingMemoryLogBlock) => {
    const title = block.title.replace(/\r?\n/gu, ' ')
    const fields = block.fields ?? {}
    const detail = orderedFieldNames(fields)
        .map((key) => `${key}=${formatValue(fields[key], key)}`)
        .join(' ')
    const heading = detail.length > 0 ? `${title} ${detail}` : title
    return `--- ${heading} ---\n${formatBlockValue(block.value, block.key ?? '')}`
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
            reportingFailure: false,
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

    isDiagnosticEnabled() {
        return this.isDebugEnabled()
    }

    diagnostic(event: string, fields: LivingMemoryLogFieldsInput = {}) {
        if (!this.isDebugEnabled()) {
            return
        }
        this.emit('info', event, fields)
    }

    diagnosticBlocks(
        event: string,
        fields: LivingMemoryLogFieldsInput,
        blocks: LivingMemoryLogBlocksInput
    ) {
        if (!this.isDebugEnabled()) {
            return
        }
        this.emit('info', event, fields, undefined, blocks)
    }

    info(event: string, fields: LivingMemoryLogFieldsInput = {}) {
        this.emit('info', event, fields)
    }

    warn(
        event: string,
        fields: LivingMemoryLogFieldsInput = {},
        error?: unknown
    ) {
        this.emit('warn', event, fields, error)
    }

    error(
        event: string,
        fields: LivingMemoryLogFieldsInput = {},
        error?: unknown
    ) {
        this.emit('error', event, fields, error)
    }

    private emit(
        level: LivingMemoryLogLevel,
        event: string,
        fieldsInput: LivingMemoryLogFieldsInput,
        error?: unknown,
        blocksInput?: LivingMemoryLogBlocksInput
    ) {
        try {
            const fields =
                typeof fieldsInput === 'function' ? fieldsInput() : fieldsInput
            const merged = { ...this.context, ...fields }
            const detail = orderedFieldNames(merged)
                .map((key) => `${key}=${formatValue(merged[key], key)}`)
                .join(' ')
            const message =
                detail.length > 0
                    ? `event=${event} ${detail}`
                    : `event=${event}`
            const blocks =
                typeof blocksInput === 'function' ? blocksInput() : blocksInput
            if (blocks?.length === 0) {
                return
            }
            const completeMessage =
                blocks === undefined
                    ? message
                    : [
                          message,
                          ...blocks.map(formatBlock),
                          `--- end ${event} ---`
                      ].join('\n')
            emitCompleteMessage(this.sink, () => {
                if (error === undefined) {
                    this.sink[level](completeMessage)
                } else {
                    this.sink[level](completeMessage, toError(error))
                }
            })
        } catch (error) {
            this.reportFailure(error)
        }
    }

    private reportFailure(error: unknown) {
        if (this.state.reportingFailure || this.state.failureReported) {
            return
        }
        this.state.reportingFailure = true
        this.state.failureReported = true
        try {
            this.sink.warn(
                'event=logging.failure operation=emit',
                toError(error)
            )
        } catch {
            // 日志是旁路能力，底层 logger 故障不得影响业务流程。
        } finally {
            this.state.reportingFailure = false
        }
    }
}
