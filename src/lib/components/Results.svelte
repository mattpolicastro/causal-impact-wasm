<script lang="ts">
  import { mountChart, theme, token } from '../charts.svelte'
  import { download, toCsv } from '../data'
  import { assess } from '../diagnostics'
  import type { AnalysisConfig, AnalysisResult, PreparedData } from '../types'
  import DiagnosticsPanel from './DiagnosticsPanel.svelte'

  let {
    data,
    config,
    result,
    placebo,
  }: {
    data: PreparedData
    config: AnalysisConfig
    result: AnalysisResult
    placebo: AnalysisResult | 'pending' | 'skipped' | { error: string }
  } = $props()

  const diagnostics = $derived(assess(data, config, result, placebo))

  let panelOriginal: HTMLDivElement
  let panelPointwise: HTMLDivElement
  let panelCumulative: HTMLDivElement
  let copied = $state(false)

  // The diffuse Kalman filter's first pre-period forecast has near-infinite
  // variance; the reference implementation drops it from plots (exports keep it).
  const s = $derived.by(() => {
    const masked: Record<string, (number | null)[]> = { ...result.series }
    for (const key of [
      'preds',
      'preds_lower',
      'preds_upper',
      'point_effects',
      'point_effects_lower',
      'point_effects_upper',
    ]) {
      const values = [...masked[key]]
      values[config.preStart] = null
      masked[key] = values
    }
    return masked
  })
  const avg = $derived(result.summary.average)
  const cum = $derived(result.summary.cumulative)
  const ciLabel = $derived(`${Math.round((1 - result.alpha) * 100)}% CI`)
  const probCausal = $derived((1 - result.p_value) * 100)

  function fmt(v: number, digits = 2): string {
    if (!Number.isFinite(v)) return '—'
    const abs = Math.abs(v)
    const d = abs >= 1000 ? 0 : abs >= 10 ? 1 : digits
    return v.toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    })
  }

  function pct(v: number): string {
    return `${(v * 100).toFixed(1)}%`
  }

  function ci(lo: number, hi: number, f: (v: number) => string): string {
    return `[${f(Math.min(lo, hi))}, ${f(Math.max(lo, hi))}]`
  }

  $effect(() => {
    void theme.version
    const xs = data.index.xs
    const isDate = data.index.type === 'date'
    const t0x = xs[config.t0]
    const syncKey = 'causal-impact'
    const observed = token('--series-observed')
    const model = token('--series-model')
    const band = token('--series-model-band')

    const destroys = [
      mountChart(panelOriginal, {
        xs,
        isDate,
        t0x,
        syncKey,
        series: [
          { label: 'observed', values: data.y, color: observed },
          { label: 'counterfactual', values: s.preds, color: model, dash: [6, 4] },
        ],
        bands: [{ label: ciLabel, upper: s.preds_upper, lower: s.preds_lower, color: band }],
      }),
      mountChart(panelPointwise, {
        xs,
        isDate,
        t0x,
        syncKey,
        zeroLine: true,
        height: 190,
        series: [
          { label: 'pointwise effect', values: s.point_effects, color: model },
        ],
        bands: [
          {
            label: ciLabel,
            upper: s.point_effects_upper,
            lower: s.point_effects_lower,
            color: band,
          },
        ],
      }),
      mountChart(panelCumulative, {
        xs,
        isDate,
        t0x,
        syncKey,
        zeroLine: true,
        height: 190,
        series: [
          { label: 'cumulative effect', values: s.post_cum_effects, color: model },
        ],
        bands: [
          {
            label: ciLabel,
            upper: s.post_cum_effects_upper,
            lower: s.post_cum_effects_lower,
            color: band,
          },
        ],
      }),
    ]
    return () => destroys.forEach((d) => d())
  })

  function exportCsv() {
    const cols = Object.keys(result.series)
    const rows = data.index.labels.map((label, i) => [
      label,
      data.y[i] ?? null,
      ...cols.map((c) => result.series[c][i]),
    ])
    download('causal-impact-inferences.csv', toCsv(['index', 'observed', ...cols], rows))
  }

  function exportPng() {
    const canvases = [panelOriginal, panelPointwise, panelCumulative].map(
      (el) => el.querySelector('canvas')!,
    )
    const pad = 16
    const width = Math.max(...canvases.map((c) => c.width))
    const height = canvases.reduce((sum, c) => sum + c.height + pad, pad)
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')!
    ctx.fillStyle = token('--surface')
    ctx.fillRect(0, 0, width, height)
    let y = pad
    for (const c of canvases) {
      ctx.drawImage(c, 0, y)
      y += c.height + pad
    }
    out.toBlob((blob) => blob && download('causal-impact-charts.png', blob, 'image/png'))
  }

  async function copyReport() {
    await navigator.clipboard.writeText(result.report)
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
</script>

<DiagnosticsPanel items={diagnostics} />

<div class="tiles">
  <div class="tile">
    <h3>Relative effect (avg)</h3>
    <p class="hero">{pct(avg.rel_effect)}</p>
    <p class="muted">{ciLabel} {ci(avg.rel_effect_lower, avg.rel_effect_upper, pct)}</p>
  </div>
  <div class="tile">
    <h3>Absolute effect (sum)</h3>
    <p class="hero">{fmt(cum.abs_effect)}</p>
    <p class="muted">
      {ciLabel} {ci(cum.abs_effect_lower, cum.abs_effect_upper, (v) => fmt(v))}
    </p>
  </div>
  <div class="tile">
    <h3>Prob. of causal effect</h3>
    <p class="hero">{probCausal > 99.9 ? '> 99.9' : probCausal.toFixed(1)}%</p>
    <p class="muted">
      posterior tail-area p {result.p_value < 0.001
        ? '< 0.001'
        : `= ${result.p_value.toFixed(3)}`}
    </p>
  </div>
</div>

<h3>Observed vs counterfactual</h3>
<div bind:this={panelOriginal}></div>
<h3>Pointwise effect</h3>
<div bind:this={panelPointwise}></div>
<h3>Cumulative effect</h3>
<div bind:this={panelCumulative}></div>

<h3>Summary</h3>
<div class="table-wrap">
  <table class="data">
    <thead>
      <tr><th></th><th>Average</th><th>Cumulative</th></tr>
    </thead>
    <tbody>
      <tr><td>Actual</td><td>{fmt(avg.actual)}</td><td>{fmt(cum.actual)}</td></tr>
      <tr>
        <td>Predicted</td>
        <td>{fmt(avg.predicted)}</td>
        <td>{fmt(cum.predicted)}</td>
      </tr>
      <tr>
        <td>{ciLabel}</td>
        <td>{ci(avg.predicted_lower, avg.predicted_upper, (v) => fmt(v))}</td>
        <td>{ci(cum.predicted_lower, cum.predicted_upper, (v) => fmt(v))}</td>
      </tr>
      <tr>
        <td>Absolute effect</td>
        <td>{fmt(avg.abs_effect)}</td>
        <td>{fmt(cum.abs_effect)}</td>
      </tr>
      <tr>
        <td>{ciLabel}</td>
        <td>{ci(avg.abs_effect_lower, avg.abs_effect_upper, (v) => fmt(v))}</td>
        <td>{ci(cum.abs_effect_lower, cum.abs_effect_upper, (v) => fmt(v))}</td>
      </tr>
      <tr>
        <td>Relative effect</td>
        <td>{pct(avg.rel_effect)}</td>
        <td>{pct(cum.rel_effect)}</td>
      </tr>
      <tr>
        <td>{ciLabel}</td>
        <td>{ci(avg.rel_effect_lower, avg.rel_effect_upper, pct)}</td>
        <td>{ci(cum.rel_effect_lower, cum.rel_effect_upper, pct)}</td>
      </tr>
    </tbody>
  </table>
</div>

{#if result.inclusion_probs && Object.keys(result.inclusion_probs).length}
  <h3>Control series used by the model</h3>
  <p class="muted inclusion">
    {#each Object.entries(result.inclusion_probs) as [name, prob] (name)}
      <span><strong>{name}</strong> {(prob * 100).toFixed(0)}%</span>
    {/each}
    — posterior probability each control belongs in the model; low values mean
    it was pruned as unhelpful.
  </p>
{/if}

<details>
  <summary>Analysis report</summary>
  <p class="report">{result.report}</p>
</details>

<div class="exports">
  <button onclick={exportCsv}>Download inferences CSV</button>
  <button onclick={exportPng}>Download charts PNG</button>
  <button onclick={copyReport}>{copied ? 'Copied ✓' : 'Copy report'}</button>
</div>

{#if result.engine === 'mle'}
  <p class="muted">
    Estimates come from the fast maximum-likelihood engine: intervals ignore
    parameter uncertainty and all selected covariates are used as-is. Prefer the
    Bayesian engine for decisions that matter.
  </p>
{/if}

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }

  .tile {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
  }

  .tile p {
    margin: 2px 0;
  }

  .hero {
    font-size: 28px;
    font-weight: 650;
  }

  h3 {
    margin-top: 20px;
  }

  .table-wrap {
    overflow-x: auto;
    max-width: 560px;
  }

  details {
    margin-top: 20px;
  }

  summary {
    cursor: pointer;
    color: var(--ink-secondary);
    font-weight: 600;
  }

  .report {
    white-space: pre-wrap;
    color: var(--ink-secondary);
    font-size: 14px;
    max-width: 72ch;
  }

  .exports {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 20px;
  }

  .inclusion span {
    margin-right: 14px;
  }

  .inclusion strong {
    color: var(--ink);
    font-weight: 600;
  }
</style>
