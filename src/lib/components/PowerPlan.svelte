<script lang="ts">
  import {
    defaultDurations,
    detectOutlierLabels,
    excludeLabels,
    makePowerPayload,
  } from '../data'
  import { cancelRun, engine, runPower } from '../engine.svelte'
  import type { PowerConfig, PowerResult, PreparedData } from '../types'

  let { data, unit }: { data: PreparedData; unit: string } = $props()

  let mode = $state<PowerConfig['mode']>('lift')
  let harmThreshold = $state(-0.02)
  let alpha = $state(0.05)
  let powerTarget = $state(0.8)
  let priorLevelSd = $state(0.01)
  let seed = $state(12345)
  let result = $state<PowerResult | null>(null)
  let baseline = $state<PowerResult | null>(null)
  let excludedText = $state('')
  let seededFor = $state('')
  const fromFile = $derived(data.flaggedLabels.length)

  // Reseed from the file's exclude column when the underlying series changes,
  // but not on every mapping tweak — otherwise switching a covariate would wipe
  // dates the analyst had typed.
  $effect(() => {
    const id = `${data.index.labels[0] ?? ''}|${data.index.labels.length}`
    if (id !== seededFor) {
      seededFor = id
      excludedText = data.flaggedLabels.join('\n')
    }
  })
  let error = $state<string | null>(null)

  const EFFECTS = [0.01, 0.02, 0.03, 0.05, 0.1]
  // Below this the two runs are indistinguishable and calling it an improvement
  // would talk an analyst into discarding history for nothing.
  const MATERIAL = 0.002

  const excluded = $derived(
    excludedText.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
  )
  const known = $derived(new Set(data.index.labels))
  const matched = $derived(excluded.filter((l) => known.has(l)))
  const unmatched = $derived(excluded.filter((l) => !known.has(l)))
  const kept = $derived(excludeLabels(data, matched))

  const durations = $derived(defaultDurations(kept.y.length))
  const tooShort = $derived(durations.length === 0)

  const pct = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`

  // The recommendation is only meaningful if some effect actually reaches the
  // target; otherwise the honest answer is "no duration is enough".
  const best = $derived(result ? Math.min(...result.mde) : null)
  const longest = $derived(result ? result.mde[result.mde.length - 1] : null)
  const recommended = $derived(result?.recommended_duration ?? null)
  const recommendedMde = $derived(
    result && recommended != null ? result.mde[result.durations.indexOf(recommended)] : null,
  )
  // Counterfactual uncertainty compounds about as fast as the effect
  // accumulates, so these curves flatten and can even turn back upward.
  const plateaus = $derived(
    best != null && longest != null && longest >= best - 0.001,
  )
  // Whether longer HURTS rather than merely stops helping. With good controls
  // sigma_obs collapses, the random-walk level term takes over, and MDE grows
  // as sqrt(N) — so the better the covariates, the sooner longer starts costing.
  const worsens = $derived(
    result != null && result.mde[result.mde.length - 1] > result.mde[0] + 0.001,
  )

  function suggest() {
    const found = detectOutlierLabels(data)
    excludedText = [...new Set([...matched, ...found])].sort().join('\n')
  }

  async function run() {
    error = null
    result = null
    baseline = null
    const config: PowerConfig = {
      mode,
      priorLevelSd,
      excludedLabels: matched,
      harmThreshold,
      alpha,
      powerTarget,
      durations,
      effects: EFFECTS,
      nSims: 4000,
      seed,
    }
    try {
      result = await runPower(makePowerPayload(kept, config))
      // Run the unexcluded series too, so the cost of those days is visible
      // rather than asserted. Cheap: the sweep is vectorized.
      if (matched.length) {
        baseline = await runPower(makePowerPayload(data, config))
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (message !== 'Cancelled.' && !message.startsWith('Superseded')) error = message
    }
  }
</script>

<p class="muted lede">
  Estimates how long a test must run, from this history alone — no intervention
  has happened yet. The model is fit on your real data and its actual residual
  noise, then a known effect is injected into thousands of simulated futures to
  see how often it would be caught.
</p>

{#if tooShort}
  <p class="error">
    Only {data.y.length} points of history. Planning needs at least 30, and at
    least twice the length of the shortest test worth running. Pull more history.
  </p>
{:else}
  <div class="row">
    <label class="field">
      Question
      <select bind:value={mode}>
        <option value="lift">Did it help? (detect a lift)</option>
        <option value="no-harm">Did it avoid harm? (rule out a drop)</option>
      </select>
    </label>

    {#if mode === 'no-harm'}
      <label class="field">
        Unacceptable drop
        <select bind:value={harmThreshold}>
          <option value={-0.01}>worse than 1%</option>
          <option value={-0.02}>worse than 2%</option>
          <option value={-0.05}>worse than 5%</option>
        </select>
      </label>
    {/if}

    <label class="field">
      Credible interval
      <select bind:value={alpha}>
        <option value={0.1}>90%</option>
        <option value={0.05}>95%</option>
        <option value={0.01}>99%</option>
      </select>
    </label>

    <label class="field">
      Detection rate
      <select bind:value={powerTarget}>
        <option value={0.8}>80% — conventional</option>
        <option value={0.9}>90% — stricter</option>
      </select>
    </label>

    <label class="field">
      Prior level s.d.
      <select bind:value={priorLevelSd}>
        <option value={0.01}>0.01 — covariates explain y well</option>
        <option value={0.1}>0.1 — looser fit</option>
      </select>
    </label>

    <label class="field">
      Seed
      <input type="number" bind:value={seed} />
    </label>
  </div>

  <p class="muted">
    Set the prior level s.d. to whatever you will actually run the analysis
    with — it dominates this answer. On one realistic series the smallest
    detectable effect at 84 days was 9% at 0.01 and 63% at 0.1.
  </p>

  <p class="muted">
    {#if mode === 'lift'}
      A lift claim needs the interval to sit clearly above zero. An inconclusive
      result is a safe default: it just means no good evidence of a gain.
    {:else}
      “No harm” is not the same as “inconclusive”. The interval has to be narrow
      enough to rule out a drop worse than {pct(Math.abs(harmThreshold))}, which
      is a stronger demand than clearing zero — decide this margin now, before
      you see any results.
    {/if}
  </p>

  <details class="events" open={excluded.length > 0}>
    <summary>
      Known events to leave out
      {#if matched.length}<strong>({matched.length} days)</strong>{/if}
    </summary>
    {#if fromFile}
      <p class="muted">
        {fromFile} days came flagged in your file's exclude column. Edit freely —
        this list is what gets used, not the column.
      </p>
    {/if}
    <p class="muted">
      Sale days, outages, launches — anything that pushed this metric somewhere
      it does not normally sit. Add an <code>exclude</code> column to your CSV to
      carry these in the same file next time. A model fit through them believes the metric is
      noisier than it is, which inflates the effect you need at every duration.
      One date per line, matching the {data.index.type === 'date' ? 'dates' : 'row labels'}
      in your file.
    </p>
    <textarea
      bind:value={excludedText}
      rows="4"
      placeholder={data.index.labels.slice(0, 2).join('\n')}
    ></textarea>
    <div class="runbar">
      <button onclick={suggest}>Suggest from the data</button>
      {#if unmatched.length}
        <span class="error">
          {unmatched.length} not found in this file: {unmatched.slice(0, 3).join(', ')}{unmatched.length > 3 ? '…' : ''}
        </span>
      {:else if matched.length}
        <span class="muted">{kept.y.length} of {data.y.length} days kept</span>
      {/if}
    </div>
    <p class="muted">
      Suggestions are a starting point, not an answer — against one real series
      this found a known sale window and missed another completely. Your promo
      calendar is the source of truth.
    </p>
  </details>

  <div class="runbar">
    <button class="primary" onclick={run} disabled={engine.running}>
      {#if engine.running && engine.progress != null}
        Simulating… {Math.round(engine.progress * 100)}%
      {:else if engine.running}
        Simulating…
      {:else}
        Estimate required runtime
      {/if}
    </button>
    {#if engine.running}
      <button onclick={cancelRun}>Cancel</button>
    {/if}
    {#if error}<span class="error">{error}</span>{/if}
  </div>
{/if}

{#if result}
  <hr />

  {#if recommended == null || recommendedMde == null || !Number.isFinite(recommendedMde)}
    <p class="headline bad">
      No duration in range reaches a {pct(result.power_target)} detection rate.
      This metric is too noisy relative to the effects being tested — add better
      control series, or accept that only a large effect would be visible.
    </p>
  {:else}
    <p class="headline">
      Run for <strong>{recommended} {unit}</strong> to detect a
      <strong>{pct(recommendedMde, 1)}</strong>
      {mode === 'lift' ? 'lift' : 'margin'}
      {pct(result.power_target)} of the time.
    </p>
    {#if worsens}
      <p class="muted">
        Running longer is actively worse here, not just unhelpful: by
        {result.durations[result.durations.length - 1]} {unit} the smallest
        detectable effect has grown to {pct(longest!, 1)}. Your controls explain
        this metric well, which leaves the model's drifting level as the main
        source of uncertainty, and that drift compounds faster than a longer
        test accumulates effect. Keep the window short and spend the effort on
        controls instead.
      </p>
    {:else if plateaus}
      <p class="muted">
        Running longer barely helps: the counterfactual's uncertainty grows about
        as fast as the effect accumulates, so the curve flattens after this
        point. The longest window tested ({result.durations[result.durations.length - 1]}
        {unit}) only reaches {pct(longest!, 1)}. Extra weeks mostly add chances
        for something else to contaminate the result.
      </p>
    {/if}
  {/if}

  {#if baseline}
    {@const before = Math.min(...baseline.mde)}
    {@const after = Math.min(...result.mde)}
    <p class="muted">
      {#if after < before - MATERIAL}
        Leaving out those {matched.length} days moved the smallest detectable
        effect from {pct(before, 2)} to <strong>{pct(after, 2)}</strong> — those
        days were costing you {pct(before - after, 2)} of sensitivity.
      {:else if after > before + MATERIAL}
        Leaving out those {matched.length} days made this <em>worse</em>:
        {pct(before, 2)} to {pct(after, 2)}. Your control series already explains
        what happened on them, so removing them only costs you data. Put them
        back, or drop the control.
      {:else}
        Leaving out those {matched.length} days changed almost nothing
        ({pct(before, 2)} to {pct(after, 2)}), so they were not distorting the
        fit. Keep them and retain the history.
      {/if}
    </p>
  {/if}

  <table>
    <caption class="muted">
      Detection rate by test length and true effect size. Shaded cells clear your
      {pct(result.power_target)} target.
    </caption>
    <thead>
      <tr>
        <th scope="col">Test length</th>
        {#each result.effects as e (e)}
          <th scope="col">{pct(e)}</th>
        {/each}
        <th scope="col" class="mde">Smallest detectable</th>
      </tr>
    </thead>
    <tbody>
      {#each result.durations as d, i (d)}
        <tr class:recommended={d === recommended}>
          <th scope="row">{d} {unit}</th>
          {#each result.power[i] as p, j (result.effects[j])}
            <td class:hit={p >= result.power_target}>{pct(p)}</td>
          {/each}
          <td class="mde">
            {Number.isFinite(result.mde[i]) ? pct(result.mde[i], 1) : '—'}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <p class="muted">
    Fit once on all {result.n_train} points — a test that hasn't run yet doesn't
    consume history, so every length here trains on everything you have and the
    rows differ only by how long the test runs. The stand-in future is the tail
    of your own history; if that stretch was unusual, say a promo, these numbers
    inherit it. {result.n_sims.toLocaleString()} simulations per cell.
    {#if result.covariate_names.length === 0}
      No control series were supplied; adding controls that track this metric is
      the most effective way to shorten a test.
    {/if}
  </p>

  <p class="muted">
    Commit to a length before you start. Checking each day and stopping when the
    interval first excludes zero is a different, much weaker test than this one,
    and it finds effects that are not there. Then check the window against your
    calendar — promos, launches and seasonal peaks inside it will contaminate the
    result.
  </p>
{/if}

<style>
  .lede {
    margin-top: 0;
  }

  details.events {
    margin-top: 16px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  details.events summary {
    cursor: pointer;
    font-size: 14px;
    color: var(--ink);
  }

  details.events textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
  }

  details.events .muted {
    margin: 6px 0;
  }

  .runbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }

  hr {
    border: none;
    border-top: 1px solid var(--grid);
    margin: 20px 0 16px;
  }

  .headline {
    font-size: 17px;
    color: var(--ink);
    margin: 0 0 8px;
  }

  .headline.bad {
    color: var(--warning);
  }

  table {
    border-collapse: collapse;
    margin-top: 14px;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  caption {
    text-align: left;
    margin-bottom: 8px;
  }

  th,
  td {
    padding: 5px 12px;
    text-align: right;
    border-bottom: 1px solid var(--grid);
  }

  thead th {
    color: var(--ink-secondary);
    font-weight: 500;
    white-space: nowrap;
  }

  tbody th {
    text-align: left;
    font-weight: 500;
    white-space: nowrap;
  }

  td.hit {
    background: var(--pre-shade);
    color: var(--ink);
    font-weight: 600;
  }

  td.mde,
  th.mde {
    border-left: 1px solid var(--grid);
    color: var(--ink-secondary);
  }

  tr.recommended th,
  tr.recommended td {
    border-bottom-color: var(--accent);
  }
</style>
