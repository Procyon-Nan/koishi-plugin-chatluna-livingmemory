import type { MemoryEntryType } from '../../../contracts/memory'
import { memoryEntryTypes } from '../../../contracts/memory'

export const AUTO_DREAM_MAX_CLUSTER_SIZE = 8
export const AUTO_DREAM_MAX_CLUSTERS = 32

export const HDBSCAN_MIN_CLUSTER_SIZE = 2
export const HDBSCAN_MIN_SAMPLES = 1

export const unique = <T>(items: T[]) => Array.from(new Set(items))

export const isMemoryEntryType = (value: string): value is MemoryEntryType => {
    return (memoryEntryTypes as readonly string[]).includes(value)
}

export const toTimestamp = (value: Date | string | number) => {
    const timestamp = +new Date(value)
    return Number.isFinite(timestamp) ? timestamp : 0
}
