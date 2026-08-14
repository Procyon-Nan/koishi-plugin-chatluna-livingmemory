import type { Logger } from 'koishi'

export type LivingMemoryLogFields = Record<string, unknown>
export type LivingMemoryLogFieldsInput =
    LivingMemoryLogFields | (() => LivingMemoryLogFields)

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
    'attempt',
    'presetId',
    'conversationId',
    'trigger',
    'operation'
]

const credentialKeyPattern =
    /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|(?:^|[-_])token(?:$|[-_])|password|secret)/iu
const bareValuePattern = /^[\p{L}\p{N}._:/@*+\-]+$/u

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
        return String(value)
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

const formatValue = (value: unknown, key: string) => {
    const normalized = normalizeValue(value, key, new WeakSet())
    if (typeof normalized === 'string' && bareValuePattern.test(normalized)) {
        return normalized
    }
    const serialized = JSON.stringify(normalized)
    return serialized === undefined ? '"[unserializable]"' : serialized
}

const orderedFieldNames = (fields: LivingMemoryLogFields) => {
    const names = Object.keys(fields).filter(
        (key) => fields[key] !== undefined && !preferredFieldOrder.includes(key)
    )
    names.sort()
    return [
        ...preferredFieldOrder.filter((key) => fields[key] !== undefined),
        ...names
    ]
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
        error?: unknown
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
            if (error === undefined) {
                this.sink[level](message)
            } else {
                this.sink[level](message, toError(error))
            }
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
