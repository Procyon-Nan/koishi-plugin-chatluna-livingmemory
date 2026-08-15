import type {
    DreamHdbscanMatrix,
    DreamHdbscanPhase
} from '../hdbscan/algorithm'
import type { DreamPartitionEntry } from '../partitioning/types'

export interface DreamHdbscanProgress {
    phase: DreamHdbscanPhase
    completed: number
    total: number
    elapsedMs: number
}

export type DreamHdbscanProgressHandler = (
    progress: DreamHdbscanProgress
) => void

export interface DreamWorkerError {
    name: string
    message: string
    stack: string | null
}

export type DreamWorkerCommand =
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
          progress: DreamHdbscanProgress
      }
    | {
          id: number
          type: 'error'
          error: DreamWorkerError
      }

export interface DreamWorkerRunner {
    partition<Entry extends DreamPartitionEntry>(
        entries: readonly Entry[],
        targetSize?: number
    ): Promise<Entry[][]>

    runHdbscan(
        matrix: DreamHdbscanMatrix,
        onProgress?: DreamHdbscanProgressHandler
    ): Promise<Int32Array<ArrayBuffer>>
}
