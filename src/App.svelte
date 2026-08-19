<script lang="ts">
  import ColumnMapper from './lib/components/ColumnMapper.svelte'
  import DataIngest from './lib/components/DataIngest.svelte'
  import ModelConfig from './lib/components/ModelConfig.svelte'
  import PeriodPicker from './lib/components/PeriodPicker.svelte'
  import Results from './lib/components/Results.svelte'
  import { makeRunPayload, prepare } from './lib/data'
  import { cancelRun, engine, runAnalysis, warmUp } from './lib/engine.svelte'
  import type {
    AnalysisConfig,
    AnalysisResult,
    Mapping,
    ParsedTable,
  } from './lib/types'

  let table = $state<ParsedTable | null>(null)
  let mapping = $state<Mapping | null>(null)
  let config = $state<AnalysisConfig | null>(null)
  let result = $state<AnalysisResult | null>(null)
  let resultConfig = $state<AnalysisConfig | null>(null)
  let runError = $state<string | null>(null)

  // Pyodide + the numeric stack is a ~20MB download; start it immediately.
  warmUp()

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
    runError = null
    const n = t.rows.length
    const t0 = Math.max(4, Math.floor(n * 0.7))
    config = {
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
    if (!prepared || !config) return
    runError = null
    result = null
    try {
      result = await runAnalysis(makeRunPayload(prepared, $state.snapshot(config)))
      resultConfig = $state.snapshot(config)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (message !== 'Cancelled.' && !message.startsWith('Superseded')) {
        runError = message
      }
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
  <span class="status" class:ready={engine.stage === 'ready'}>
    {engine.running ? 'fitting model…' : stageLabel[engine.stage]}
  </span>
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

{#if prepared && config}
  <section class="card">
    <h2>2 · Analysis design</h2>
    <PeriodPicker data={prepared} {config} />
    <hr />
    <ModelConfig {config} />
    <div class="runbar">
      <button class="primary" onclick={run} disabled={engine.running}>
        {engine.running ? 'Analyzing…' : 'Estimate causal impact'}
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

{#if result && prepared && resultConfig}
  <section class="card">
    <h2>3 · Results</h2>
    <Results data={prepared} config={resultConfig} {result} />
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
