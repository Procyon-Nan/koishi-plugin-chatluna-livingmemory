import type {
    DreamBisectInput,
    DreamBisectResult,
    DreamRefineInput,
    DreamRefineResult
} from '../semantic/types'

export interface DreamWorkerProgress {
    phase: 'bisect'
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
