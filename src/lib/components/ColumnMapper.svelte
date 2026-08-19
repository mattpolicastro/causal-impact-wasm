<script lang="ts">
  import { isDateColumn } from '../data'
  import type { Mapping, ParsedTable } from '../types'

  let {
    table,
    mapping,
    onchange,
  }: {
    table: ParsedTable
    mapping: Mapping
    onchange: (m: Mapping) => void
  } = $props()

  const numericish = $derived(
    table.columns.filter((c) => table.rows.some((r) => typeof r[c] === 'number')),
  )

  function update(patch: Partial<Mapping>) {
    const next = { ...mapping, ...patch }
    next.covariateCols = next.covariateCols.filter(
      (c) => c !== next.yCol && c !== next.indexCol,
    )
    onchange(next)
  }

  function toggleCovariate(col: string, checked: boolean) {
    update({
      covariateCols: checked
        ? [...mapping.covariateCols, col]
        : mapping.covariateCols.filter((c) => c !== col),
    })
  }
</script>

<div class="row">
  <label class="field">
    Time index
    <select
      value={mapping.indexCol ?? ''}
      onchange={(e) => update({ indexCol: e.currentTarget.value || null })}
    >
      <option value="">Row number</option>
      {#each table.columns as col (col)}
        <option value={col}>
          {col}{isDateColumn(table, col) ? ' (dates)' : ''}
        </option>
      {/each}
    </select>
  </label>

  <label class="field">
    Response (y)
    <select
      value={mapping.yCol}
      onchange={(e) => update({ yCol: e.currentTarget.value })}
    >
      {#each numericish.filter((c) => c !== mapping.indexCol) as col (col)}
        <option value={col}>{col}</option>
      {/each}
    </select>
  </label>

  <fieldset class="field covariates">
    <legend>Covariates (controls)</legend>
    {#each numericish.filter((c) => c !== mapping.indexCol && c !== mapping.yCol) as col (col)}
      <label class="cov">
        <input
          type="checkbox"
          checked={mapping.covariateCols.includes(col)}
          onchange={(e) => toggleCovariate(col, e.currentTarget.checked)}
        />
        {col}
      </label>
    {:else}
      <span class="muted">none available</span>
    {/each}
  </fieldset>
</div>

<p class="muted">
  {table.rows.length} rows · covariates must be unaffected by the intervention —
  they carry the counterfactual.
</p>

<style>
  fieldset.covariates {
    border: none;
    padding: 0;
    margin: 0;
    flex-direction: row;
    align-items: center;
    gap: 12px;
  }

  fieldset.covariates legend {
    padding: 0;
    margin-bottom: 4px;
  }

  .cov {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ink);
    font-size: 14px;
  }
</style>
