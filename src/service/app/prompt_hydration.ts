import type { MemoryScope } from '../../contracts/memory'
import type { LivingMemorySnapshotCache } from '../memory/snapshot/snapshot_cache'
import type { LivingMemoryUserProfileService } from '../user_profile'

export interface LivingMemoryPromptHydrationDependencies {
    snapshotCache: LivingMemorySnapshotCache
    userProfiles: LivingMemoryUserProfileService
}

export interface LivingMemoryPromptSectionsOptions {
    includeSnapshot?: boolean
    speakerKeys?: string[]
}

export const hydrateLivingMemoryPromptVariable = async (
    dependencies: Pick<
        LivingMemoryPromptHydrationDependencies,
        'snapshotCache'
    >,
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
) => {
    return await dependencies.snapshotCache.hydrate(scope)
}

export const hydrateLivingMemoryPromptSections = async (
    dependencies: LivingMemoryPromptHydrationDependencies,
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>,
    options: LivingMemoryPromptSectionsOptions = {}
) => {
    const [snapshot, userProfiles] = await Promise.all([
        options.includeSnapshot === false
            ? Promise.resolve('')
            : dependencies.snapshotCache.hydrate(scope),
        dependencies.userProfiles.renderForSpeakers(
            scope.presetId,
            options.speakerKeys ?? []
        )
    ])

    return {
        snapshot,
        userProfiles
    }
}
