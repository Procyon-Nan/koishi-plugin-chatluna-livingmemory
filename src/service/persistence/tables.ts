import type { Context } from 'koishi'

/**
 * 待处理记忆查询索引。minato 由列名拼接的默认名为
 * `index:living_memory_entry:presetId+status+isConsolidated+createdAt+id`，
 * 长 69 字符，超出 MySQL 64 字符的标识符上限，故显式指定短名。
 */
export const dreamPendingIndex = {
    name: 'index:living_memory_entry:dream_pending',
    keys: {
        presetId: 'asc',
        status: 'asc',
        isConsolidated: 'asc',
        createdAt: 'asc',
        id: 'asc'
    }
} as const

export const defineLivingMemoryTables = (ctx: Context) => {
    ctx.model.extend(
        'living_memory_entry',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            speakerKeys: {
                type: 'json',
                initial: []
            },
            type: 'string(32)',
            status: {
                type: 'string',
                length: 16,
                initial: 'active'
            },
            content: 'text',
            keywords: 'json',
            summary: {
                type: 'text',
                nullable: true,
                initial: null
            },
            sentiment: {
                type: 'text',
                nullable: true,
                initial: null
            },
            importance: {
                type: 'double',
                nullable: true,
                initial: null
            },
            sourceConversationId: 'string(255)',
            sourceOrigins: 'array',
            // 仅用于首次向量索引迁移，迁移完成后不再参与运行时读写。
            embedding: {
                type: 'json',
                nullable: true,
                initial: null
            },
            embeddingModelId: {
                type: 'string',
                length: 255,
                nullable: true,
                initial: null
            },
            isConsolidated: {
                type: 'boolean',
                initial: false
            },
            createdAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id',
            indexes: [dreamPendingIndex, ['presetId', 'status', 'updatedAt']]
        }
    )

    ctx.model.extend(
        'living_memory_snapshot',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            conversationId: 'string(255)',
            strategy: 'string(32)',
            query: 'text',
            items: 'json',
            createdAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )

    ctx.model.extend(
        'living_memory_entry_speaker',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            speakerKey: 'string(255)',
            memoryId: 'string(64)'
        },
        {
            autoInc: false,
            primary: 'id',
            indexes: [
                ['presetId', 'speakerKey'],
                ['presetId', 'memoryId']
            ]
        }
    )

    ctx.model.extend(
        'living_memory_migration',
        {
            id: 'string(64)',
            appliedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )

    ctx.model.extend(
        'living_memory_job',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            conversationId: 'string(255)',
            kind: 'string(16)',
            recallStrategy: {
                type: 'string',
                length: 32,
                nullable: true,
                initial: null
            },
            status: 'string(16)',
            input: 'text',
            detail: 'text',
            error: 'text',
            createdAt: 'timestamp',
            startedAt: 'timestamp',
            finishedAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )

    ctx.model.extend(
        'living_memory_user_profile',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            speakerKey: 'string(255)',
            speakerLabel: 'string(255)',
            content: 'text',
            sourceMemoryIds: 'json',
            createdAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )

    ctx.model.extend(
        'living_memory_preset_speaker',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            speakerKey: 'string(255)',
            speakerLabel: 'string(255)',
            speakerAliases: {
                type: 'json',
                nullable: true,
                initial: null
            },
            speakerId: {
                type: 'string',
                length: 255,
                nullable: true,
                initial: null
            },
            platform: {
                type: 'string',
                length: 255,
                nullable: true,
                initial: null
            },
            createdAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id'
        }
    )
}
