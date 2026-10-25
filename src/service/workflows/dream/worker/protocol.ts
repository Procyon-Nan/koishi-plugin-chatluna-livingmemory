import type { DreamHdbscanPhase } from '../hdbscan/algorithm'
import type { DreamPartitionEntry } from '../partitioning/types'
import type {
    DreamBisectInput,
    DreamBisectResult,
    DreamRefineInput,
    DreamRefineResult
} from '../semantic/types'

export interface DreamWorkerProgress {
    phase: DreamHdbscanPhase | 'bisect'
    completed: number
    total: number
    elapsedMs: number
}

export type DreamWorkerProgressHandler = (progress: DreamWorkerProgress) => void

export interface DreamWorkerError {
    name: string
    message: string
    stack: string | null
}

export type DreamWorkerCommand =
    | ({ type: 'refine' } & DreamRefineInput)
    | ({ type: 'bisect'; reportProgress: boolean } & DreamBisectInput)
    | {
          type: 'ready'
      }
    | {
          type: 'partition'
          entries: DreamPartitionEntry[]
          targetSize?: number
      }
    | {
          type: 'hdbscan'
          entryCount: number
          dimension: number
          vectors: Float32Array<ArrayBuffer>
          reportProgress: boolean
      }

type WithRequestId<Command> = Command extends DreamWorkerCommand
    ? Command & { id: number }
    : never

export type DreamWorkerRequest = WithRequestId<DreamWorkerCommand>

export type DreamWorkerResponse =
    | { id: number; type: 'refine'; ok: true; result: DreamRefineResult }
    | {
          id: number
          type: 'bisect'
          ok: true
          result: DreamBisectResult
      }
    | {
          id: number
          type: 'ready'
          ok: true
      }
    | {
          id: number
          type: 'partition'
          ok: true
          partitions: number[][]
      }
    | {
          id: number
          type: 'hdbscan'
          ok: true
          labels: Int32Array<ArrayBuffer>
      }
    | {
          id: number
          type: 'progress'
          progress: DreamWorkerProgress
      }
    | {
          id: number
          type: 'error'
          error: DreamWorkerError
      }

export interface DreamWorkerRunner {
    refine(input: DreamRefineInput): Promise<DreamRefineResult>
    bisect(
        input: DreamBisectInput,
        onProgress?: DreamWorkerProgressHandler
    ): Promise<DreamBisectResult>
}
