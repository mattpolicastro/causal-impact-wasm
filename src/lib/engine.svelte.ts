import type { AnalysisResult, RunPayload, WorkerResponse } from './types'

export type EngineStage =
  | 'idle'
  | 'loading-runtime'
  | 'loading-packages'
  | 'installing'
  | 'ready'

export const engine = $state({
  stage: 'idle' as EngineStage,
  running: false,
  error: null as string | null,
})

let worker: Worker | null = null
let pending: {
  resolve: (r: AnalysisResult) => void
  reject: (e: Error) => void
} | null = null

function settle(action: (p: NonNullable<typeof pending>) => void) {
  if (pending) action(pending)
  pending = null
  engine.running = false
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker/pyodide.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data
    if (msg.type === 'status') {
      engine.stage = msg.stage
    } else if (msg.type === 'ready') {
      engine.stage = 'ready'
    } else if (msg.type === 'result') {
      engine.stage = 'ready'
      settle((p) => p.resolve(msg.result))
    } else if (msg.type === 'error') {
      engine.stage = 'ready'
      settle((p) => p.reject(new Error(msg.error)))
    }
  }
  worker.onerror = (event) => {
    engine.stage = 'idle'
    engine.error = event.message || 'Worker failed'
    settle((p) => p.reject(new Error(engine.error!)))
    worker?.terminate()
    worker = null
  }
  return worker
}

export function warmUp() {
  engine.error = null
  ensureWorker().postMessage({ type: 'init' })
}

export function runAnalysis(payload: RunPayload): Promise<AnalysisResult> {
  engine.error = null
  const w = ensureWorker()
  return new Promise((resolve, reject) => {
    pending?.reject(new Error('Superseded by a new run.'))
    pending = { resolve, reject }
    engine.running = true
    w.postMessage({ type: 'run', payload })
  })
}

export function cancelRun() {
  worker?.terminate()
  worker = null
  settle((p) => p.reject(new Error('Cancelled.')))
  engine.stage = 'idle'
}
