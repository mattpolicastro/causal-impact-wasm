<script lang="ts">
  import type { DiagnosticItem, DiagnosticStatus } from '../diagnostics'

  let { items }: { items: DiagnosticItem[] } = $props()

  const icon: Record<DiagnosticStatus, string> = {
    pass: '✓',
    warn: '!',
    fail: '✕',
    info: 'i',
    pending: '…',
  }

  const label: Record<DiagnosticStatus, string> = {
    pass: 'Pass',
    warn: 'Caution',
    fail: 'Problem',
    info: 'Note',
    pending: 'Running',
  }

  const failures = $derived(items.filter((i) => i.status === 'fail').length)
  const warnings = $derived(items.filter((i) => i.status === 'warn').length)
</script>

<div class="panel" class:trouble={failures > 0}>
  <h3>
    Sanity checks ·
    {#if failures > 0}
      {failures} problem{failures > 1 ? 's' : ''} found — read before using this result
    {:else if warnings > 0}
      passed with {warnings} caution{warnings > 1 ? 's' : ''}
    {:else}
      all passed
    {/if}
  </h3>
  <ul>
    {#each items as item (item.id)}
      <li class={item.status}>
        <span class="badge" aria-hidden="true">{icon[item.status]}</span>
        <div>
          <strong>{label[item.status]} — {item.title}.</strong>
          <span class="detail">{item.detail}</span>
        </div>
      </li>
    {/each}
  </ul>
</div>

<style>
  .panel {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 20px;
  }

  .panel.trouble {
    border-color: var(--critical);
  }

  h3 {
    margin-bottom: 10px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  li {
    display: flex;
    gap: 10px;
    font-size: 14px;
  }

  .badge {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    margin-top: 1px;
    border: 1.5px solid var(--ink-muted);
    color: var(--ink-secondary);
  }

  li.pass .badge {
    border-color: var(--good);
    color: var(--good);
  }

  li.warn .badge {
    border-color: var(--warning, #c98500);
    color: var(--warning, #c98500);
  }

  li.fail .badge {
    border-color: var(--critical);
    color: var(--critical);
  }

  .detail {
    color: var(--ink-secondary);
  }
</style>
