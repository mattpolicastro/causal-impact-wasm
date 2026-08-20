<script lang="ts">
  import { parseColor } from '../appearance.svelte'

  let {
    label,
    value,
    onchange,
  }: { label: string; value: string; onchange: (hex: string) => void } = $props()

  let text = $state('')
  let invalid = $state(false)

  $effect(() => {
    text = value
    invalid = false
  })

  function commitText() {
    const parsed = parseColor(text)
    if (parsed) {
      invalid = false
      onchange(parsed)
    } else {
      invalid = true
    }
  }
</script>

<label class="color-field">
  <span>{label}</span>
  <span class="inputs">
    <input
      type="color"
      {value}
      oninput={(e) => onchange(e.currentTarget.value)}
      aria-label="{label} color picker"
    />
    <input
      type="text"
      class:invalid
      bind:value={text}
      onchange={commitText}
      onblur={commitText}
      size="14"
      spellcheck="false"
      placeholder="#rrggbb or rgb()"
      aria-label="{label} color code"
    />
  </span>
</label>

<style>
  .color-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
    color: var(--ink-secondary);
  }

  .inputs {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  input[type='color'] {
    width: 30px;
    height: 30px;
    padding: 2px;
    border: 1px solid var(--axis);
    border-radius: 6px;
    background: var(--page);
    cursor: pointer;
  }

  input[type='text'] {
    font-family: ui-monospace, monospace;
    font-size: 12.5px;
    width: 110px;
  }

  input.invalid {
    border-color: var(--critical);
  }
</style>
