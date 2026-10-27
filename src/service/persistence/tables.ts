import type { Context } from 'koishi'

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
            sourceConversationId: {
                type: 'string',
                length: 255,
                nullable: true,
                initial: null
            },
            sourceLabel: {
                type: 'text',
                nullable: true,
                initial: null
            },
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
            createdAt: 'timestamp',
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'id',
            indexes: [['presetId', 'status', 'updatedAt']]
        }
    )

    // 字段退役时先删除依赖它的旧索引，再由数据库驱动移除列。
    ctx.model.migrate(
        'living_memory_entry',
        { isConsolidated: 'boolean' },
        async (database) => {
            const table = 'living_memory_entry'
            const { driver } = database.select(table)
            const indexes = await driver.getIndexes(table)
            for (const index of indexes) {
                if (index.name && 'isConsolidated' in index.keys) {
                    await driver.dropIndex(table, index.name)
                }
            }
        }
    )

    ctx.model.extend(
        'living_memory_snapshot',
        {
            id: 'string(64)',
            presetId: 'string(255)',
            conversationId: 'string(255)',
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

    // 预设级派生缓存：一行一预设，按 presetId 直取。非备份内容，不进导出。
    ctx.model.extend(
        'living_memory_preset_persona',
        {
            presetId: 'string(255)',
            card: 'text',
            rawHash: 'string(64)',
            source: {
                type: 'string',
                length: 16,
                initial: 'generated'
            },
            totalLines: {
                type: 'integer',
                initial: 0
            },
            deletedLines: {
                type: 'integer',
                initial: 0
            },
            usedRawFallback: {
                type: 'boolean',
                initial: false
            },
            updatedAt: 'timestamp'
        },
        {
            autoInc: false,
            primary: 'presetId'
        }
    )
}
