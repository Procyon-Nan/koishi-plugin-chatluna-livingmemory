import type { MemoryScope } from '../../contracts/memory'
import type { SnapshotRepository } from '../../contracts/workflows'
import { renderSnapshotText } from '../memory/snapshot/snapshot_text'
import type { LivingMemoryUserProfileService } from '../user_profile'

export interface LivingMemoryPromptHydrationDependencies {
    snapshots: Pick<SnapshotRepository, 'getLatestSnapshotByScope'>
    userProfiles: LivingMemoryUserProfileService
}

export interface LivingMemoryPromptSectionsOptions {
    includeSnapshot?: boolean
    speakerKeys?: string[]
}

export const hydrateLivingMemoryPromptVariable = async (
    dependencies: Pick<LivingMemoryPromptHydrationDependencies, 'snapshots'>,
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>
) => {
    const snapshot =
        await dependencies.snapshots.getLatestSnapshotByScope(scope)
    return renderSnapshotText(snapshot?.items ?? [])
}

export const hydrateLivingMemoryPromptSections = async (
    dependencies: LivingMemoryPromptHydrationDependencies,
    scope: Pick<MemoryScope, 'presetId' | 'conversationId'>,
    options: LivingMemoryPromptSectionsOptions = {}
) => {
    const [snapshot, userProfiles] = await Promise.all([
        options.includeSnapshot === false
            ? Promise.resolve('')
            : hydrateLivingMemoryPromptVariable(dependencies, scope),
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
