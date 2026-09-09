<script lang="ts">
  import { appearance, initAppearance } from './lib/appearance.svelte'
  import ColumnMapper from './lib/components/ColumnMapper.svelte'
  import DataIngest from './lib/components/DataIngest.svelte'
  import ModelConfig from './lib/components/ModelConfig.svelte'
  import PeriodPicker from './lib/components/PeriodPicker.svelte'
  import PowerPlan from './lib/components/PowerPlan.svelte'
  import Results from './lib/components/Results.svelte'
  import { excludePreFlagged, makeRunPayload, prepare } from './lib/data'
  import { placeboConfig } from './lib/diagnostics'
  import { cancelRun, engine, runAnalysis, warmUp } from './lib/engine.svelte'
  import type {
    AnalysisConfig,
    AnalysisResult,
    Mapping,
    ParsedTable,
    PreparedData,
  } from './lib/types'

  type PlaceboState = AnalysisResult | 'pending' | 'skipped' | { error: string }

  let table = $state<ParsedTable | null>(null)
  let mapping = $state<Mapping | null>(null)
  let config = $state<AnalysisConfig | null>(null)
  let result = $state<AnalysisResult | null>(null)
  let resultConfig = $state<AnalysisConfig | null>(null)
  // What was actually fitted. Excluding flagged days shortens the series, so
  // the result's points no longer line up with the file as loaded.
  let resultData = $state<PreparedData | null>(null)
  let excludeFlagged = $state(true)
  let placebo = $state<PlaceboState>('skipped')
  let runError = $state<string | null>(null)
  // Two different jobs: measuring an intervention that happened, and planning
  // one that hasn't. Planning has no intervention date, so it cannot share the
  // period picker.
  let appMode = $state<'measure' | 'plan'>('measure')

  // Pyodide + the numeric stack is a ~20MB download; start it immediately.
  warmUp()
  initAppearance()

  const preparation = $derived.by(() => {
    if (!table || !mapping) return null
    try {
      return { data: prepare(table, mapping), error: null }
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : String(e) }
    }
  })
  const prepared = $derived(preparation?.data ?? null)
  const prepareError = $derived(preparation?.error ?? null)
  const unit = $derived(prepared?.index.type === 'date' ? 'days' : 'points')

  // The picker and the chart stay on the file as loaded; only the fit sees the
  // shortened series.
  const analysis = $derived.by(() => {
    if (!prepared || !config) return null
    if (!excludeFlagged) return { data: prepared, config, dropped: [] as string[] }
    return excludePreFlagged(prepared, config)
  })

  const stageLabel: Record<string, string> = {
    idle: 'engine off',
    'loading-runtime': 'loading Python runtime…',
    'loading-packages': 'loading numpy/statsmodels…',
    installing: 'preparing model…',
    ready: 'engine ready',
  }

  function onLoad(t: ParsedTable, m: Mapping) {
    table = t
    mapping = m
    result = null
    resultData = null
    runError = null
    const n = t.rows.length
    const t0 = Math.max(4, Math.floor(n * 0.7))
    config = {
      engine: 'bayes',
      preStart: 0,
      t0,
      postEnd: n - 1,
      alpha: 0.05,
      standardize: true,
      seasonPeriod: null,
      priorLevelSd: 0.01,
      nSims: 1000,
      seed: 12345,
    }
  }

  async function run() {
    if (!analysis) return
    runError = null
    result = null
    const fitted = analysis.data
    const snapshot = $state.snapshot(analysis.config) as AnalysisConfig
    try {
      result = await runAnalysis(makeRunPayload(fitted, snapshot))
      resultConfig = snapshot
      resultData = fitted
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (message !== 'Cancelled.' && !message.startsWith('Superseded')) {
        runError = message
      }
      return
    }
    // Placebo check: same model, fake intervention inside the pre-period.
    const placeboCfg = placeboConfig(snapshot)
    if (!placeboCfg) {
      placebo = 'skipped'
      return
    }
    placebo = 'pending'
    try {
      placebo = await runAnalysis(makeRunPayload(fitted, placeboCfg))
    } catch (e) {
      placebo = { error: e instanceof Error ? e.message : String(e) }
    }
  }
</script>

<header>
  <div>
    <h1>CausalImpact</h1>
    <p class="muted">
      Bayesian structural time-series impact analysis, entirely in your browser —
      no data leaves this page.
    </p>
  </div>
  <div class="header-right">
    <div class="modes" role="group" aria-label="What are you doing?">
      <button class:on={appMode === 'measure'} onclick={() => (appMode = 'measure')}>
        Measure an impact
      </button>
      <button class:on={appMode === 'plan'} onclick={() => (appMode = 'plan')}>
        Plan a test
      </button>
    </div>
    <span class="status" class:ready={engine.stage === 'ready'}>
      {engine.running ? 'fitting model…' : stageLabel[engine.stage]}
    </span>
    <div class="appearance">
      <label>
        Theme
        <select bind:value={appearance.mode}>
          <option value="system">system</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
    </div>
  </div>
</header>

<section class="card">
  <h2>1 · Data</h2>
  <DataIngest onload={onLoad} />
  {#if table && mapping}
    <hr />
    <ColumnMapper {table} {mapping} onchange={(m) => (mapping = m)} />
    {#if prepareError}
      <p class="error">{prepareError}</p>
    {/if}
  {/if}
</section>

{#if prepared && appMode === 'plan'}
  <section class="card">
    <h2>2 · Test length</h2>
    <PowerPlan data={prepared} {unit} />
  </section>
{/if}

{#if prepared && config && appMode === 'measure'}
  <section class="card">
    <h2>2 · Analysis design</h2>
    <PeriodPicker data={prepared} {config} bind:excludeFlagged />
    <hr />
    <ModelConfig {config} />
    <div class="runbar">
      <button class="primary" onclick={run} disabled={engine.running}>
        {#if engine.running && engine.progress != null}
          Sampling… {Math.round(engine.progress * 100)}%
        {:else if engine.running}
          Analyzing…
        {:else}
          Estimate causal impact
        {/if}
      </button>
      {#if engine.running}
        <button onclick={cancelRun}>Cancel</button>
      {/if}
      {#if runError}
        <span class="error">{runError}</span>
      {/if}
    </div>
  </section>
{/if}

{#if result && resultData && resultConfig && appMode === 'measure'}
  <section class="card">
    <h2>3 · Results</h2>
    <Results data={resultData} config={resultConfig} {result} {placebo} />
  </section>
{/if}

<footer class="muted">
  A WebAssembly port of
  <a href="https://google.github.io/CausalImpact/">Google's CausalImpact</a>
  (Apache 2.0) running on
  <a href="https://pyodide.org">Pyodide</a> + statsmodels.
  <a href="https://github.com/mattpolicastro/causal-impact-wasm">Source</a>.
</footer>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 16px;
  }

  header p {
    margin: 4px 0 0;
  }

  .header-right {
    display: flex;
    flex-direction: column;
    align-items: end;
    gap: 8px;
  }

  .modes {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px;
    gap: 2px;
  }

  .modes button {
    font-size: 12.5px;
    padding: 3px 12px;
    border: none;
    border-radius: 999px;
    background: none;
    color: var(--ink-secondary);
    white-space: nowrap;
  }

  .modes button.on {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .appearance {
    display: flex;
    gap: 10px;
  }

  .appearance label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--ink-muted);
  }

  .appearance select {
    font-size: 12px;
    padding: 2px 5px;
  }

  .status {
    font-size: 12.5px;
    color: var(--ink-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 12px;
    white-space: nowrap;
    margin-top: 6px;
  }

  .status.ready {
    color: var(--good);
    border-color: var(--good);
  }

  hr {
    border: none;
    border-top: 1px solid var(--grid);
    margin: 16px 0;
  }

  .runbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }

  footer {
    margin-top: 28px;
  }

  footer a {
    color: var(--accent);
  }
</style>
