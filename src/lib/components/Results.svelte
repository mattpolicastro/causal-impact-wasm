<script lang="ts">
  import {
    applyPreset,
    appearance,
    chartColors,
    PRESETS,
    resetChartColors,
    setChartColor,
  } from '../appearance.svelte'
  import { mountChart, theme, token } from '../charts.svelte'
  import { download, toCsv } from '../data'
  import { assess } from '../diagnostics'
  import { chartsToSvg } from '../svgExport'
  import ColorField from './ColorField.svelte'
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
  const colors = $derived.by(() => {
    void theme.version
    void appearance.custom
    return chartColors()
  })

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

  const panels = $derived.by(() => {
    void theme.version
    const xs = data.index.xs
    const isDate = data.index.type === 'date'
    const t0x = xs[config.t0]
    const syncKey = 'causal-impact'
    const observed = token('--series-observed')
    const model = token('--series-model')
    const band = token('--series-model-band')
    return [
      {
        title: 'Observed vs counterfactual',
        spec: {
          xs,
          isDate,
          t0x,
          syncKey,
          series: [
            { label: 'observed', values: data.y, color: observed },
            { label: 'counterfactual', values: s.preds, color: model, dash: [6, 4] },
          ],
          bands: [
            { label: ciLabel, upper: s.preds_upper, lower: s.preds_lower, color: band },
          ],
        },
      },
      {
        title: 'Pointwise effect',
        spec: {
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
        },
      },
      {
        title: 'Cumulative effect',
        spec: {
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
        },
      },
    ]
  })

  $effect(() => {
    const els = [panelOriginal, panelPointwise, panelCumulative]
    const destroys = panels.map((p, i) => mountChart(els[i], p.spec))
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

  function slug(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  }

  function exportPanelSvg(i: number) {
    download(
      `causal-impact-${slug(panels[i].title)}.svg`,
      chartsToSvg([panels[i]], data.index.labels),
      'image/svg+xml',
    )
  }

  function exportPanelPng(i: number) {
    const els = [panelOriginal, panelPointwise, panelCumulative]
    const canvas = els[i].querySelector('canvas')!
    const pad = 16
    const out = document.createElement('canvas')
    out.width = canvas.width + pad * 2
    out.height = canvas.height + pad * 2
    const ctx = out.getContext('2d')!
    ctx.fillStyle = colors.background
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, pad, pad)
    out.toBlob(
      (blob) =>
        blob && download(`causal-impact-${slug(panels[i].title)}.png`, blob, 'image/png'),
    )
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

<div class="chart-style">
  <h3>Chart colors</h3>
  <div class="chart-style-row">
    <ColorField
      label="Background"
      value={colors.background}
      onchange={(hex) => setChartColor('background', hex)}
    />
    <ColorField
      label="Observed"
      value={colors.observed}
      onchange={(hex) => setChartColor('observed', hex)}
    />
    <ColorField
      label="Counterfactual"
      value={colors.counterfactual}
      onchange={(hex) => setChartColor('counterfactual', hex)}
    />
    <div class="presets">
      {#each Object.entries(PRESETS) as [id, p] (id)}
        <button
          class="preset"
          title={p.label}
          onclick={() => applyPreset(id as keyof typeof PRESETS)}
        >
          <span style:background={p[theme.dark ? 'dark' : 'light'][0]}></span>
          <span style:background={p[theme.dark ? 'dark' : 'light'][1]}></span>
        </button>
      {/each}
      {#if appearance.custom}
        <button class="reset" onclick={resetChartColors}>Reset</button>
      {/if}
    </div>
  </div>
</div>

<h3>Observed vs counterfactual</h3>
<div class="chart-panel" bind:this={panelOriginal}></div>
<div class="chart-actions">
  <button onclick={() => exportPanelPng(0)}>PNG</button>
  <button onclick={() => exportPanelSvg(0)}>SVG</button>
</div>
<h3>Pointwise effect</h3>
<div class="chart-panel" bind:this={panelPointwise}></div>
<div class="chart-actions">
  <button onclick={() => exportPanelPng(1)}>PNG</button>
  <button onclick={() => exportPanelSvg(1)}>SVG</button>
</div>
<h3>Cumulative effect</h3>
<div class="chart-panel" bind:this={panelCumulative}></div>
<div class="chart-actions">
  <button onclick={() => exportPanelPng(2)}>PNG</button>
  <button onclick={() => exportPanelSvg(2)}>SVG</button>
</div>

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

  .chart-style {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .chart-style h3 {
    margin: 0 0 8px;
  }

  .chart-style-row {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: end;
  }

  .presets {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-bottom: 2px;
  }

  .preset {
    display: inline-flex;
    gap: 0;
    padding: 3px;
    border-radius: 6px;
    line-height: 0;
  }

  .preset span {
    width: 12px;
    height: 18px;
  }

  .preset span:first-child {
    border-radius: 3px 0 0 3px;
  }

  .preset span:last-child {
    border-radius: 0 3px 3px 0;
  }

  .reset {
    font-size: 12.5px;
    padding: 4px 10px;
  }

  .chart-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .chart-actions button {
    font-size: 12px;
    padding: 3px 10px;
  }

  .inclusion span {
    margin-right: 14px;
  }

  .inclusion strong {
    color: var(--ink);
    font-weight: 600;
  }
</style>
