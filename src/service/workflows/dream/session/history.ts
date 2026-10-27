import {
    AIMessage,
    HumanMessage,
    SystemMessage,
    isAIMessage,
    type BaseMessage
} from '@langchain/core/messages'
import type { StructuredTool } from '@langchain/core/tools'
import type {
    ChatLunaChatModel,
    ChatLunaModelCallOptions
} from 'koishi-plugin-chatluna/llm-core/platform/model'
import { invokeLoggedModel } from '../../../logging/model_calls'
import { stringifyModelContent } from '../../../shared/utils'
import {
    formatLogScope,
    type LivingMemoryLogger
} from '../../../logging/logger'
import { buildDreamHistorySummaryPrompts } from '../../../prompts/dream'
import { formatXmlBlock } from '../../../prompts/prompt_format'

export const dreamCompressionThreshold = 200_000

export class DreamSessionHistory {
    private messages: BaseMessage[]
    private batchStart = 1
    private inputTokens: number | undefined
    private compressions = 0

    constructor(
        systemPrompt: string,
        private readonly model: ChatLunaChatModel,
        private readonly callOptions: ChatLunaModelCallOptions & {
            id: string
            maxTokenLimit: number
        },
        private readonly logger: LivingMemoryLogger
    ) {
        this.messages = [new SystemMessage(systemPrompt)]
    }

    recordUsage(message: BaseMessage) {
        const tokens = isAIMessage(message)
            ? message.usage_metadata?.input_tokens
            : undefined
        // 缺失或无效用量不覆盖最近一次有效上报，也不回退到本地估算。
        if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) {
            this.inputTokens = tokens
        }
    }

    startBatch(input: string) {
        this.batchStart = this.messages.length
        this.append(new HumanMessage(input))
    }

    append(...messages: BaseMessage[]) {
        // usage 单独记录；入列时保留签名、推理内容与工具元数据，供后续各轮复用。
        this.messages.push(
            ...messages.map((message) => {
                if (!isAIMessage(message)) return message
                return new AIMessage({
                    content: message.content,
                    name: message.name,
                    id: message.id,
                    additional_kwargs: message.additional_kwargs,
                    response_metadata: message.response_metadata,
                    tool_calls: message.tool_calls,
                    invalid_tool_calls: message.invalid_tool_calls
                })
            })
        )
    }

    async prepareDecisionMessages(
        tools: StructuredTool[],
        signal?: AbortSignal
    ) {
        signal?.throwIfAborted()
        if (
            this.inputTokens !== undefined &&
            this.inputTokens >= dreamCompressionThreshold
        ) {
            await this.summarizeEarlierBatches(this.inputTokens, signal)
        }
        signal?.throwIfAborted()
        this.logger.diagnosticSummary((fields) => ({
            event: 'Dream 上下文',
            detail: `${formatLogScope(fields)}; 最近一次供应商输入量：${this.inputTokens ?? '供应商未返回'} tokens`
        }))
        const messages = [...this.messages]
        // 仅检查宿主容量，防止静默裁剪当前批次；不参与 200k 压缩判断。
        const [, tokens] = await this.model.cropMessages(
            messages,
            tools,
            messages.length,
            this.callOptions.maxTokenLimit
        )
        if (tokens > this.callOptions.maxTokenLimit) {
            throw new Error(`Dream 输入超过模型可用预算：${tokens} tokens。`)
        }
        signal?.throwIfAborted()
        return messages
    }

    private async summarizeEarlierBatches(
        tokensBefore: number,
        signal?: AbortSignal
    ) {
        if (this.batchStart <= 1) {
            throw new Error(
                '当前 Dream 批次已达到 200k，且没有可压缩的更早批次。'
            )
        }
        const transcript = JSON.stringify(
            this.messages
                .slice(1, this.batchStart)
                .map((message) => message.toDict())
        )
        const attempt = ++this.compressions
        this.logger.diagnosticSummary((fields) => ({
            event: 'Dream 上下文压缩开始',
            detail: `${formatLogScope(fields)}; 压缩序号：${attempt}; 压缩前输入量：${tokensBefore} tokens`
        }))
        const prompt = buildDreamHistorySummaryPrompts(transcript)
        const messages = [
            new SystemMessage(prompt.systemPrompt),
            new HumanMessage(prompt.inputPrompt)
        ]
        const [, inputTokens] = await this.model.cropMessages(
            messages,
            [],
            messages.length,
            this.callOptions.maxTokenLimit
        )
        if (inputTokens > this.callOptions.maxTokenLimit) {
            throw new Error('Dream 压缩输入超过模型可用预算。')
        }
        signal?.throwIfAborted()
        const response = await invokeLoggedModel(
            this.model,
            messages,
            {
                ...this.callOptions,
                id: `${this.callOptions.id}:compression`,
                tools: [],
                signal
            },
            {
                logger: this.logger,
                stage: 'dream-compression',
                attempt,
                promptLogging: 'none'
            }
        )
        signal?.throwIfAborted()
        const summary = stringifyModelContent(response.content).trim()
        if (!summary) {
            throw new Error('Dream 历史压缩未返回有效摘要。')
        }
        this.messages = [
            this.messages[0],
            new HumanMessage(
                formatXmlBlock('dream_history_summary', summary).join('\n')
            ),
            ...this.messages.slice(this.batchStart)
        ]
        this.batchStart = 2
        // 摘要请求的 usage 和保留下来的旧响应均不代表新上下文大小。
        this.inputTokens = undefined
        this.logger.diagnosticSummary((fields) => ({
            event: 'Dream 上下文压缩完成',
            detail: `${formatLogScope(fields)}; 压缩序号：${attempt}; 压缩前输入量：${tokensBefore} tokens`
        }))
    }
}
