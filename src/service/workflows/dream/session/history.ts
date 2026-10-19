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
import type { LivingMemoryLogger } from '../../../logging/logger'
import { buildDreamCompressionPrompt } from '../../../prompts/dream'
import { formatXmlBlock } from '../../../prompts/prompt_format'

export const dreamCompressionThreshold = 200_000

export class DreamSessionHistory {
    private messages: BaseMessage[]
    private batchStart = 1
    private readonly tokenCounts = new WeakMap<BaseMessage, number>()
    private fixedTokens = 0
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

    async initialize(tools: StructuredTool[]) {
        const probe = await this.model.getNumTokens('Hello world. 记忆整理。')
        if (!Number.isFinite(probe) || probe <= 0) {
            throw new Error('Dream token 计数无效，无法判断 200k 压缩阈值。')
        }
        // 只用固定系统消息取得宿主的工具定义开销，不引入历史 usage 基线。
        const [, tokens] = await this.model.cropMessages(
            this.messages,
            tools,
            1,
            this.callOptions.maxTokenLimit
        )
        this.fixedTokens =
            tokens - (await this.model.countMessageTokens(this.messages[0]))
    }

    startBatch(input: string) {
        this.batchStart = this.messages.length
        this.append(new HumanMessage(input))
    }

    append(...messages: BaseMessage[]) {
        this.messages.push(...messages)
    }

    private async count(
        messages: BaseMessage[],
        fixedTokens = this.fixedTokens
    ) {
        let total = fixedTokens
        for (const message of messages) {
            let count = this.tokenCounts.get(message)
            if (count === undefined) {
                count = await this.model.countMessageTokens(message)
                this.tokenCounts.set(message, count)
            }
            total += count
        }
        return total
    }

    async prepare(signal?: AbortSignal) {
        signal?.throwIfAborted()
        let tokens = await this.count(this.messages)
        if (tokens >= dreamCompressionThreshold) {
            tokens = await this.compress(tokens, signal)
        }
        if (tokens > this.callOptions.maxTokenLimit) {
            throw new Error(`Dream 输入超过模型可用预算：${tokens} tokens。`)
        }
        signal?.throwIfAborted()
        this.logger.diagnostic('dream.context', { inputTokensEstimate: tokens })
        return this.messages.map((message) =>
            // usage 只用于日志；否则宿主裁剪会引用压缩前的输入量，或混用缓存口径。
            // 原始历史不变，供应商签名、推理内容和工具调用元数据仍随请求保留。
            isAIMessage(message)
                ? new AIMessage({
                      content: message.content,
                      name: message.name,
                      id: message.id,
                      additional_kwargs: message.additional_kwargs,
                      response_metadata: message.response_metadata,
                      tool_calls: message.tool_calls,
                      invalid_tool_calls: message.invalid_tool_calls
                  })
                : message
        )
    }

    private async compress(tokensBefore: number, signal?: AbortSignal) {
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
        this.logger.diagnostic('dream.compression.started', {
            stage: 'dream-compression',
            attempt,
            inputTokensEstimate: tokensBefore
        })
        const prompt = buildDreamCompressionPrompt(transcript)
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
        const candidate = [
            this.messages[0],
            new HumanMessage(
                formatXmlBlock('dream_history_summary', summary).join('\n')
            ),
            ...this.messages.slice(this.batchStart)
        ]
        const tokensAfter = await this.count(candidate)
        if (tokensAfter >= dreamCompressionThreshold) {
            throw new Error(
                'Dream 压缩后仍达到 200k，保留原历史并终止本次整理。'
            )
        }
        this.messages = candidate
        this.batchStart = 2
        this.logger.diagnostic('dream.compression.completed', {
            stage: 'dream-compression',
            attempt,
            tokensBefore,
            tokensAfter
        })
        return tokensAfter
    }
}
