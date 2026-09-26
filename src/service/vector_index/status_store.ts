import type {
    MemoryVectorIndexManifest,
    MemoryVectorIndexPresetStatus,
    MemoryVectorIndexState,
    MemoryVectorIndexStatus
} from '../../contracts/vector_index'
import { LivingMemoryVectorIndexError } from './errors'
import type { VectorIndexInspection } from './worker_protocol'

interface VectorIndexBuildingPreset {
    expectedCount: number
    updatedAt: number
}

interface VectorIndexStatusOverlay {
    /**
     * 已开启且尚未结束的全局维护窗口数（启动任务/手动重建）。
     * 窗口由开启方 markStarting 负责 endMaintenance 结束，大于 0 时读一律拦截；
     * 用计数而非布尔，避免重叠开窗时先结束的任务提前关掉后来者的窗口。
     */
    maintenanceDepth: number
    /** 正在按预设对账的展示标记；只影响显示，不参与门禁。 */
    readonly buildingPresets: Map<string, VectorIndexBuildingPreset>
    /** worker 或索引启动失败的运行时消息，拦截一切读。 */
    unavailableMessage: string | null
    /** 维护任务失败的最近错误，仅展示。 */
    runtimeError: string | null
    currentJobId: string | null
}

/**
 * inspection 镜像 + 运行时 overlay 的单轨状态存储：
 * presets 与 manifest 只来自 applyInspection，mark 类只写 overlay，
 * 两者互不覆盖。持久账本只应写入终态 ready/dirty。
 */
export class VectorIndexStatusStore {
    private manifest: MemoryVectorIndexManifest | null = null
    private readonly presets = new Map<string, MemoryVectorIndexPresetStatus>()
    private readonly overlay: VectorIndexStatusOverlay = {
        maintenanceDepth: 0,
        buildingPresets: new Map(),
        unavailableMessage: null,
        runtimeError: null,
        currentJobId: null
    }

    reset() {
        this.manifest = null
        this.presets.clear()
        this.overlay.maintenanceDepth = 0
        this.overlay.buildingPresets.clear()
        this.overlay.unavailableMessage = null
        this.overlay.runtimeError = null
        this.overlay.currentJobId = null
    }

    snapshot(): MemoryVectorIndexStatus {
        const presets: MemoryVectorIndexPresetStatus[] = []
        for (const [presetId, preset] of this.presets) {
            const building = this.overlay.buildingPresets.get(presetId)
            presets.push(
                building === undefined
                    ? { ...preset }
                    : {
                          ...preset,
                          state: 'building',
                          expectedCount: building.expectedCount,
                          updatedAt: building.updatedAt
                      }
            )
        }
        for (const [presetId, building] of this.overlay.buildingPresets) {
            if (this.presets.has(presetId)) {
                continue
            }
            presets.push({
                presetId,
                state: 'building',
                expectedCount: building.expectedCount,
                indexedCount: 0,
                lastError: null,
                updatedAt: building.updatedAt
            })
        }
        presets.sort((left, right) =>
            left.presetId.localeCompare(right.presetId)
        )
        return {
            state: this.resolveState(presets),
            manifest: this.manifest === null ? null : { ...this.manifest },
            presets,
            currentJobId: this.overlay.currentJobId,
            lastError:
                this.overlay.runtimeError ??
                this.overlay.unavailableMessage ??
                presets.find((preset) => preset.lastError !== null)
                    ?.lastError ??
                null
        }
    }

    setCurrentJob(jobId: string | null) {
        this.overlay.currentJobId = jobId
    }

    markStarting() {
        this.overlay.maintenanceDepth += 1
        this.overlay.runtimeError = null
    }

    endMaintenance() {
        this.overlay.maintenanceDepth -= 1
    }

    markBuilding(jobId: string) {
        this.overlay.currentJobId = jobId
    }

    markPresetBuilding(presetId: string, jobId: string, expectedCount: number) {
        this.overlay.buildingPresets.set(presetId, {
            expectedCount,
            updatedAt: Date.now()
        })
        this.overlay.currentJobId = jobId
    }

    clearPresetBuilding(presetId: string) {
        this.overlay.buildingPresets.delete(presetId)
    }

    applyInspection(inspection: VectorIndexInspection) {
        this.manifest = inspection.manifest
        this.presets.clear()
        for (const preset of inspection.presets) {
            this.presets.set(preset.presetId, { ...preset })
        }
    }

    markUnavailable(message: string) {
        this.overlay.unavailableMessage = message
    }

    clearUnavailable() {
        this.overlay.unavailableMessage = null
    }

    markRuntimeError(message: string) {
        this.overlay.runtimeError = message
    }

    getPresetIndexedCount(presetId: string) {
        return this.presets.get(presetId)?.indexedCount ?? 0
    }

    assertPresetReady(presetId: string) {
        if (this.overlay.unavailableMessage !== null) {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                'unavailable',
                'vector index is not ready: state=unavailable'
            )
        }
        if (this.manifest === null || this.overlay.maintenanceDepth > 0) {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                'building',
                'vector index is not ready: state=building'
            )
        }
        const preset = this.presets.get(presetId)
        if (preset !== undefined && preset.state !== 'ready') {
            throw new LivingMemoryVectorIndexError(
                'not-ready',
                preset.state,
                `vector index preset is not ready: preset=${presetId}, state=${preset.state}`
            )
        }
    }

    private resolveState(
        presets: MemoryVectorIndexPresetStatus[]
    ): MemoryVectorIndexState {
        if (this.overlay.unavailableMessage !== null) {
            return 'unavailable'
        }
        if (
            this.overlay.maintenanceDepth > 0 ||
            this.manifest === null ||
            presets.some((preset) => preset.state === 'building')
        ) {
            return 'building'
        }
        if (presets.some((preset) => preset.state === 'unavailable')) {
            return 'unavailable'
        }
        if (presets.some((preset) => preset.state === 'dirty')) {
            return 'dirty'
        }
        return 'ready'
    }
}
