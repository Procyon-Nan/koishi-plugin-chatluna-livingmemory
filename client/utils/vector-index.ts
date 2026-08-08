import type { MemoryVectorIndexStatus } from '../types'

export const isVectorWorkflowReady = (
    status: MemoryVectorIndexStatus | null,
    presetId: string
) => {
    if (status === null || presetId.length === 0 || status.state !== 'ready') {
        return false
    }
    const preset = status.presets.find((item) => item.presetId === presetId)
    return preset === undefined || preset.state === 'ready'
}
