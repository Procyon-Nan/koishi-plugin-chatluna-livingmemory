export const dreamBatchSize = 30

export interface DreamVectorMatrix {
    entryCount: number
    dimension: number
    vectors: Float32Array<ArrayBuffer>
}

export interface DreamPlanLabels {
    labels: Uint32Array<ArrayBuffer>
    sizes: Uint32Array<ArrayBuffer>
    clusterCount: number
}

export interface DreamBisectInput {
    matrix: DreamVectorMatrix
    cancellation: SharedArrayBuffer
    budgetMs: number
}

export interface DreamBisectResult {
    matrix: DreamVectorMatrix
    plan: DreamPlanLabels
    elapsedMs: number
}
