import type { DreamMemoryEntryRecord } from '../../../../contracts/workflows'

export const validateHdbscanLabels = (
    labels: ArrayLike<number>,
    entryCount: number
) => {
    if (labels.length !== entryCount) {
        throw new Error(
            `dream hdbscan returned ${labels.length} labels for ${entryCount} entries`
        )
    }
    for (let index = 0; index < labels.length; index++) {
        const label = labels[index]
        if (!Number.isInteger(label) || label < -1) {
            throw new Error(`dream hdbscan returned invalid label: ${label}`)
        }
    }
}

export const groupEntriesByLabel = (
    entries: readonly DreamMemoryEntryRecord[],
    labels: ArrayLike<number>
) => {
    validateHdbscanLabels(labels, entries.length)
    const groups = new Map<number, DreamMemoryEntryRecord[]>()
    entries.forEach((entry, index) => {
        const label = labels[index]
        const group = groups.get(label)
        if (group === undefined) {
            groups.set(label, [entry])
        } else {
            group.push(entry)
        }
    })
    return groups
}
