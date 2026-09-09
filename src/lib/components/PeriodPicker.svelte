<script lang="ts">
  import { mountChart, theme, token } from '../charts.svelte'
  import { preFlaggedLabels } from '../data'
  import type { AnalysisConfig, PreparedData } from '../types'

  let {
    data,
    config,
    excludeFlagged = $bindable(true),
  }: {
    data: PreparedData
    config: AnalysisConfig
    excludeFlagged?: boolean
  } = $props()

  let chartEl: HTMLDivElement

  const n = $derived(data.y.length)
  const flaggedXs = $derived(
    data.flaggedLabels.length
      ? data.index.labels.flatMap((l, i) =>
          data.flaggedLabels.includes(l) ? [data.index.xs[i]] : [],
        )
      : [],
  )
  const preFlagged = $derived(preFlaggedLabels(data, config))
  const nDropped = $derived(excludeFlagged ? preFlagged.length : 0)
  const preLength = $derived(config.t0 - config.preStart - nDropped)
  const postLength = $derived(config.postEnd - config.t0 + 1)

  $effect(() => {
    void theme.version
    return mountChart(chartEl, {
      xs: data.index.xs,
      isDate: data.index.type === 'date',
      series: [
        {
          label: 'observed',
          values: data.y,
          color: token('--series-observed'),
        },
      ],
      t0x: data.index.xs[config.t0],
      shade: {
        fromX: data.index.xs[config.preStart],
        toX: data.index.xs[config.t0],
        color: token('--pre-shade'),
      },
      marks: flaggedXs.length ? { xs: flaggedXs, color: token('--series-model-band') } : null,
      height: 200,
      onClickIdx: (idx) => {
        if (idx > config.preStart + 3 && idx <= config.postEnd) config.t0 = idx
      },
    })
  })

  function clamp(value: number, lo: number, hi: number) {
    return Math.min(hi, Math.max(lo, Math.round(value)))
  }
</script>

<p class="muted">
  {#if flaggedXs.length}
    Shaded stripes are the {flaggedXs.length} days flagged in your file.
  {/if}
  Click the chart to set when the intervention began. The shaded region is the
  pre-period the model trains on; everything after the dashed line is evaluated
  for impact.
</p>

<div class="chart-panel" bind:this={chartEl}></div>

<div class="row">
  <label class="field">
    Pre-period start
    <input
      type="number"
      min="0"
      max={config.t0 - 4}
      value={config.preStart}
      onchange={(e) =>
        (config.preStart = clamp(+e.currentTarget.value, 0, config.t0 - 4))}
    />
  </label>
  <label class="field">
    Intervention starts at
    <input
      type="number"
      min={config.preStart + 4}
      max={config.postEnd}
      value={config.t0}
      onchange={(e) =>
        (config.t0 = clamp(+e.currentTarget.value, config.preStart + 4, config.postEnd))}
    />
  </label>
  <label class="field">
    Post-period end
    <input
      type="number"
      min={config.t0}
      max={n - 1}
      value={config.postEnd}
      onchange={(e) => (config.postEnd = clamp(+e.currentTarget.value, config.t0, n - 1))}
    />
  </label>
  <p class="periods muted">
    Pre: {data.index.labels[config.preStart]} → {data.index.labels[config.t0 - 1]}
    ({preLength} pts{nDropped ? `, ${nDropped} excluded` : ''}) · Post:
    {data.index.labels[config.t0]} → {data.index.labels[config.postEnd]}
    ({postLength} pts)
  </p>
</div>

{#if preFlagged.length}
  <label class="field checkbox">
    <span>
      <input type="checkbox" bind:checked={excludeFlagged} />
      Exclude the {preFlagged.length}
      flagged {preFlagged.length === 1 ? 'day' : 'days'} in the pre-period
    </span>
  </label>
  <p class="muted note">
    A flagged day the model trains on is treated as a real observation: it moves
    the baseline being projected forward and inflates the noise the model
    expects. Flagged days after the intervention are always kept — dropping days
    from the measured window would change what the effect is an average over.
  </p>
{/if}

<style>
  .checkbox span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
    font-size: 14px;
    padding: 6px 0;
  }

  .note {
    margin: 2px 0 0;
    max-width: 62ch;
  }

  .periods {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  input[type='number'] {
    width: 110px;
  }
</style>
