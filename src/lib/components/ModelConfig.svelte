<script lang="ts">
  import type { AnalysisConfig } from '../types'

  let { config }: { config: AnalysisConfig } = $props()

  let seasonal = $state(config.seasonPeriod !== null)
  let levelMode = $state<'fixed' | 'auto'>(
    config.priorLevelSd === null ? 'auto' : 'fixed',
  )

  $effect(() => {
    if (!seasonal) config.seasonPeriod = null
    else if (config.seasonPeriod === null) config.seasonPeriod = 7
  })

  $effect(() => {
    if (config.engine === 'bayes' && levelMode === 'auto') levelMode = 'fixed'
    if (levelMode === 'auto') config.priorLevelSd = null
    else if (config.priorLevelSd === null) config.priorLevelSd = 0.01
  })
</script>

<div class="row">
  <label class="field">
    Engine
    <select bind:value={config.engine}>
      <option value="bayes">Bayesian (spike &amp; slab MCMC)</option>
      <option value="mle">Fast approximation (MLE)</option>
    </select>
  </label>

  <label class="field">
    Confidence level
    <select bind:value={config.alpha}>
      <option value={0.1}>90%</option>
      <option value={0.05}>95%</option>
      <option value={0.01}>99%</option>
    </select>
  </label>

  {#if config.engine === 'mle'}
    <label class="field">
      Local level flexibility
      <select bind:value={levelMode}>
        <option value="fixed">fixed prior s.d.</option>
        <option value="auto">optimize automatically</option>
      </select>
    </label>
  {/if}

  {#if levelMode === 'fixed'}
    <label class="field">
      Prior level s.d.
      <select bind:value={config.priorLevelSd}>
        <option value={0.01}>0.01 — covariates explain y well</option>
        <option value={0.1}>0.1 — looser fit</option>
      </select>
    </label>
  {/if}

  {#if config.engine === 'mle'}
    <label class="field checkbox">
      <span>
        <input type="checkbox" bind:checked={seasonal} />
        Seasonal component
      </span>
    </label>

    {#if seasonal}
      <label class="field">
        Period (points per cycle)
        <input type="number" min="2" max="400" bind:value={config.seasonPeriod} />
      </label>
    {/if}

    <label class="field checkbox">
      <span>
        <input type="checkbox" bind:checked={config.standardize} />
        Standardize data
      </span>
    </label>

    <label class="field">
      Simulations
      <input type="number" min="100" max="10000" step="100" bind:value={config.nSims} />
    </label>
  {/if}

  <label class="field">
    Seed
    <input type="number" min="0" bind:value={config.seed} />
  </label>
</div>

{#if config.engine === 'bayes'}
  <p class="muted">
    Full Bayesian inference: intervals include parameter uncertainty, and a
    spike-and-slab prior prunes control series that don't help — safest choice.
    Seasonal components aren't supported by this engine yet.
  </p>
{:else}
  <p class="muted">
    Maximum-likelihood Kalman filter: fast, supports seasonality, but intervals
    ignore parameter uncertainty and all selected covariates are used as-is.
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

  input[type='number'] {
    width: 110px;
  }

  p.muted {
    margin: 10px 0 0;
  }
</style>
