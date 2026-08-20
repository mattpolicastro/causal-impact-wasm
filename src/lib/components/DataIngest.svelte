<script lang="ts">
  import { parseCsv, inferMapping } from '../data'
  import type { Mapping, ParsedTable } from '../types'

  let {
    onload,
  }: { onload: (table: ParsedTable, mapping: Mapping) => void } = $props()

  let error = $state<string | null>(null)
  let dragging = $state(false)
  let pasteOpen = $state(false)
  let pasteText = $state('')

  const samples = [
    { file: 'ad-campaign.csv', label: 'Ad campaign (daily, 2 covariates)' },
    { file: 'classic-arma.csv', label: 'Classic simulated series (y, X)' },
    { file: 'vw-dieselgate.csv', label: 'VW emissions scandal (weekly stock)' },
  ]

  function load(text: string, name: string) {
    error = null
    try {
      const table = parseCsv(text, name)
      onload(table, inferMapping(table))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function loadFile(file: File) {
    load(await file.text(), file.name)
  }

  async function loadSample(file: string) {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/${file}`)
    if (!res.ok) {
      error = `Could not load sample dataset (${res.status}).`
      return
    }
    load(await res.text(), file)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    const file = e.dataTransfer?.files?.[0]
    if (file) loadFile(file)
  }

  function onFilePick(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (file) loadFile(file)
  }
</script>

<div
  class="dropzone"
  class:dragging
  role="button"
  tabindex="0"
  ondragover={(e) => {
    e.preventDefault()
    dragging = true
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <p>
    Drop a CSV here, or
    <label class="filepick">
      choose a file<input type="file" accept=".csv,text/csv" onchange={onFilePick} />
    </label>
  </p>
  <p class="muted">
    One row per time point: an optional date column, the response series, and any
    control series (covariates).
  </p>
</div>

<div class="alt-sources">
  <button onclick={() => (pasteOpen = !pasteOpen)}>Paste CSV…</button>
  {#each samples as s (s.file)}
    <button onclick={() => loadSample(s.file)}>Sample: {s.label}</button>
  {/each}
</div>

{#if pasteOpen}
  <textarea
    rows="8"
    placeholder={'date,y,x1\n2024-01-01,102.3,98.7\n…'}
    bind:value={pasteText}
  ></textarea>
  <div>
    <button
      class="primary"
      disabled={!pasteText.trim()}
      onclick={() => load(pasteText, 'pasted data')}
    >
      Use pasted data
    </button>
  </div>
{/if}

{#if error}
  <p class="error">{error}</p>
{/if}

<style>
  .dropzone {
    border: 1.5px dashed var(--axis);
    border-radius: 10px;
    padding: 22px;
    text-align: center;
    transition: border-color 0.15s;
  }

  .dropzone.dragging {
    border-color: var(--accent);
  }

  .dropzone p {
    margin: 4px 0;
  }

  .filepick {
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }

  .filepick input {
    display: none;
  }

  .alt-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  textarea {
    width: 100%;
    margin-top: 12px;
    font-family: ui-monospace, monospace;
    font-size: 12.5px;
  }

  div :global(+ .error) {
    margin-bottom: 0;
  }
</style>
