import type {
    MemoryVectorIndexState,
    MemoryVectorIndexStatus
} from '../../contracts/vector_index'
import { LivingMemoryVectorIndexError } from './errors'
import type { VectorIndexInspection } from './worker_protocol'

const createInitialStatus = (): MemoryVectorIndexStatus => ({
    state: 'unavailable',
    manifest: null,
    presets: [],
    currentJobId: null,
    lastError: null
})

const resolveInspectionState = (
    inspection: VectorIndexInspection
): MemoryVectorIndexState => {
    if (inspection.manifest === null) {
        return 'building'
    }
    for (const state of ['dirty', 'building', 'unavailable'] as const) {
        if (inspection.presets.some((preset) => preset.state === state)) {
            return state
        }
    }
    return 'ready'
}

export class VectorIndexStatusStore {
    private status = createInitialStatus()

    reset() {
        this.status = createInitialStatus()
    }

    snapshot(): MemoryVectorIndexStatus {
        let manifest = null
        if (this.status.manifest !== null) {
            manifest = { ...this.status.manifest }
        }
        return {
            ...this.status,
            manifest,
            presets: this.status.presets.map((preset) => ({ ...preset }))
        }
    }

    setCurrentJob(jobId: string | null) {
        this.status = { ...this.status, currentJobId: jobId }
    }

    markStarting(lastError: string | null) {
        this.status = { ...this.status, state: 'building', lastError }
    }

    markBuilding(jobId: string) {
        const updatedAt = Date.now()
        this.status = {
            ...this.status,
            state: 'building',
            presets: this.status.presets.map((preset) => ({
                ...preset,
                state: 'building',
                lastError: null,
                updatedAt
            })),
            currentJobId: jobId,
            lastError: null
        }
    }

    markPresetBuilding(presetId: string, jobId: string, expectedCount: number) {
        const updatedAt = Date.now()
        const presets = this.status.presets.map((preset) => {
            if (preset.presetId !== presetId) {
                return preset
            }
            return {
                ...preset,
                state: 'building' as const,
                expectedCount,
                lastError: null,
                updatedAt
            }
        })
        if (!presets.some((preset) => preset.presetId === presetId)) {
            presets.push({
                presetId,
                state: 'building',
                expectedCount,
                indexedCount: 0,
                lastError: null,
                updatedAt
            })
        }
        this.status = {
            ...this.status,
            state: 'building',
            presets,
            currentJobId: jobId,
            lastError: null
        }
    }

    applyInspection(inspection: VectorIndexInspection) {
        const failedPreset = inspection.presets.find(
            (preset) => preset.lastError !== null
        )
        let lastError: string | null = null
        if (failedPreset !== undefined) {
            lastError = failedPreset.lastError
        }
        this.status = {
            state: resolveInspectionState(inspection),
            manifest: inspection.manifest,
            presets: inspection.presets,
            currentJobId: this.status.currentJobId,
            lastError
        }
    }

    markFailure(state: MemoryVectorIndexState, message: string) {
        this.status = { ...this.status, state, lastError: message }
    }

    markMaintenanceFailure(state: MemoryVectorIndexState, message: string) {
        this.status = {
            ...this.status,
            state,
            currentJobId: null,
            lastError: message
        }
    }

    markWorkerFailure(error: Error) {
        const updatedAt = Date.now()
        this.status = {
            ...this.status,
            state: 'unavailable',
            presets: this.status.presets.map((preset) => ({
                ...preset,
                state: 'unavailable',
                lastError: error.message,
                updatedAt
            })),
            lastError: error.message
        }
    }

    getPresetIndexedCount(presetId: string) {
        const preset = this.status.presets.find(
            (item) => item.presetId === presetId
        )
        if (preset === undefined) {
            return 0
        }
        return preset.indexedCount
    }

    assertPresetReady(presetId: string) {
        if (this.status.state !== 'ready') {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                this.status.state,
                `vector index is not ready: state=${this.status.state}`
            )
        }
        const preset = this.status.presets.find(
            (item) => item.presetId === presetId
        )
        if (preset !== undefined && preset.state !== 'ready') {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                preset.state,
                `vector index preset is not ready: preset=${presetId}, state=${preset.state}`
            )
        }
    }
}
