import type { WorkerRequest, WorkerResponse } from '../types'

import initPy from '../../../py/causalimpact/__init__.py?raw'
import versionPy from '../../../py/causalimpact/__version__.py?raw'
import inferencesPy from '../../../py/causalimpact/inferences.py?raw'
import mainPy from '../../../py/causalimpact/main.py?raw'
import miscPy from '../../../py/causalimpact/misc.py?raw'
import summaryPy from '../../../py/causalimpact/summary.py?raw'
import reportTmpl from '../../../py/causalimpact/templates/report?raw'
import summaryTmpl from '../../../py/causalimpact/templates/summary?raw'
import bayesPy from '../../../py/bayes.py?raw'
import runnerPy from '../../../py/runner.py?raw'

const PYODIDE_VERSION = '314.0.5'
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

const FILES: Record<string, string> = {
  '/app/causalimpact/__init__.py': initPy,
  '/app/causalimpact/__version__.py': versionPy,
  '/app/causalimpact/inferences.py': inferencesPy,
  '/app/causalimpact/main.py': mainPy,
  '/app/causalimpact/misc.py': miscPy,
  '/app/causalimpact/summary.py': summaryPy,
  '/app/causalimpact/templates/report': reportTmpl,
  '/app/causalimpact/templates/summary': summaryTmpl,
  '/app/bayes.py': bayesPy,
  '/app/runner.py': runnerPy,
}

function post(message: WorkerResponse) {
  self.postMessage(message)
}

type RunJson = (payload: string, progress?: (done: number, total: number) => void) => string

let runJsonPromise: Promise<RunJson> | null = null

async function init(): Promise<RunJson> {
  post({ type: 'status', stage: 'loading-runtime' })
  const { loadPyodide } = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`)
  const pyodide = await loadPyodide({ indexURL: INDEX_URL })

  post({ type: 'status', stage: 'loading-packages' })
  await pyodide.loadPackage(['numpy', 'scipy', 'pandas', 'statsmodels', 'jinja2'])

  post({ type: 'status', stage: 'installing' })
  pyodide.FS.mkdirTree('/app/causalimpact/templates')
  for (const [path, content] of Object.entries(FILES)) {
    pyodide.FS.writeFile(path, content)
  }
  pyodide.runPython("import sys; sys.path.insert(0, '/app'); import runner")
  return pyodide.runPython('runner.run_json') as RunJson
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  try {
    if (!runJsonPromise) runJsonPromise = init()
    const runJson = await runJsonPromise
    if (message.type === 'init') {
      post({ type: 'ready' })
      return
    }
    const result = JSON.parse(
      runJson(JSON.stringify(message.payload), (done, total) =>
        post({ type: 'progress', done, total }),
      ),
    )
    if (result.ok) {
      delete result.ok
      post({ type: 'result', result })
    } else {
      post({ type: 'error', error: result.error })
    }
  } catch (e) {
    runJsonPromise = null
    post({ type: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}
