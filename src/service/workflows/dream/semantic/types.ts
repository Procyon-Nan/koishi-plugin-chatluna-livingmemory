export const dreamBatchSize = 30
export const dreamCandidateWidth = 64
export const dreamNeighborCount = 10

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
}

export interface DreamBisectResult {
    matrix: DreamVectorMatrix
    plan: DreamPlanLabels
    elapsedMs: number
}

export interface DreamCandidates {
    q: number
    counts: Uint8Array<ArrayBuffer>
    neighbors: Uint32Array<ArrayBuffer>
}

export interface DreamSparseGraph {
    offsets: Uint32Array<ArrayBuffer>
    neighbors: Uint32Array<ArrayBuffer>
    weights: Float32Array<ArrayBuffer>
    topNeighbors: Uint32Array<ArrayBuffer>
    topWeights: Float32Array<ArrayBuffer>
    q: number
}

export interface DreamRefineInput extends DreamBisectInput {
    initial: DreamPlanLabels
    candidates: DreamCandidates
}

export interface DreamRefineDiagnostics {
    graphComplete: boolean
    graphEdgeCount: number
    acceptedMoves: number
    acceptedSwaps: number
    edgeVisits: number
    hintEdgeVisits: number
    initialObjective: number
    finalObjective: number
    refineMs: number
    stopReason: string
}

export type DreamRefineResult =
    | {
          outcome: 'use-initial'
          diagnostics: DreamRefineDiagnostics
      }
    | {
          outcome: 'refined'
          plan: DreamPlanLabels
          diagnostics: DreamRefineDiagnostics
      }
