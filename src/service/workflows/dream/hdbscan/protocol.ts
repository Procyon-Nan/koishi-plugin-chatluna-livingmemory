import type { DreamHdbscanMatrix, DreamHdbscanPhase } from './algorithm'

export interface DreamHdbscanProgress {
    phase: DreamHdbscanPhase
    completed: number
    total: number
    elapsedMs: number
}

export type DreamHdbscanProgressHandler = (
    progress: DreamHdbscanProgress
) => void

export interface DreamHdbscanWorkerError {
    name: string
    message: string
    stack: string | null
}

export type DreamHdbscanWorkerCommand =
    | {
          type: 'ready'
      }
    | {
          type: 'run'
          entryCount: number
          dimension: number
          vectors: Float32Array<ArrayBuffer>
          reportProgress: boolean
      }

type WithRequestId<Command> = Command extends DreamHdbscanWorkerCommand
    ? Command & { id: number }
    : never

export type DreamHdbscanWorkerRequest = WithRequestId<DreamHdbscanWorkerCommand>

export type DreamHdbscanWorkerResponse =
    | {
          id: number
          type: 'ready'
          ok: true
      }
    | {
          id: number
          type: 'run'
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
          error: DreamHdbscanWorkerError
      }

export interface DreamHdbscanRunner {
    run(
        matrix: DreamHdbscanMatrix,
        onProgress?: DreamHdbscanProgressHandler
    ): Promise<Int32Array<ArrayBuffer>>
}
