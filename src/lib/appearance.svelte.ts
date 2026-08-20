import { untrack } from 'svelte'
import { theme } from './charts.svelte'

export type ThemeMode = 'system' | 'light' | 'dark'

// Chart series pairs drawn from the validated reference palette: each pair is
// adjacent in the CVD-checked slot ordering, so every option is colorblind-safe
// in both modes. First color = observed, second = model/counterfactual.
export const PALETTES = {
  'blue-orange': {
    label: 'Blue / Orange',
    light: ['#2a78d6', '#eb6834'],
    dark: ['#3987e5', '#d95926'],
  },
  'aqua-yellow': {
    label: 'Aqua / Yellow',
    light: ['#1baf7a', '#eda100'],
    dark: ['#199e70', '#c98500'],
  },
  'magenta-green': {
    label: 'Magenta / Green',
    light: ['#e87ba4', '#008300'],
    dark: ['#d55181', '#008300'],
  },
  'violet-red': {
    label: 'Violet / Red',
    light: ['#4a3aa7', '#e34948'],
    dark: ['#9085e9', '#e66767'],
  },
} as const

export type PaletteId = keyof typeof PALETTES

const STORAGE_KEY = 'ci-appearance'

function load(): { mode: ThemeMode; palette: PaletteId } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      mode: ['system', 'light', 'dark'].includes(saved.mode) ? saved.mode : 'system',
      palette: saved.palette in PALETTES ? saved.palette : 'blue-orange',
    }
  } catch {
    return { mode: 'system', palette: 'blue-orange' }
  }
}

export const appearance = $state(load())

const media = window.matchMedia('(prefers-color-scheme: dark)')

export function isDark(): boolean {
  return appearance.mode === 'dark' || (appearance.mode === 'system' && media.matches)
}

function bandColor(hex: string, dark: boolean): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${dark ? 0.22 : 0.16})`
}

function apply() {
  const dark = isDark()
  const root = document.documentElement
  if (appearance.mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', appearance.mode)
  const [observed, model] = PALETTES[appearance.palette][dark ? 'dark' : 'light']
  root.style.setProperty('--series-observed', observed)
  root.style.setProperty('--series-model', model)
  root.style.setProperty('--series-model-band', bandColor(model, dark))
  theme.dark = dark
  theme.version += 1
}

media.addEventListener('change', apply)

export function initAppearance() {
  $effect(() => {
    void appearance.mode
    void appearance.palette
    // untrack: apply() bumps theme.version (read-modify-write), which must not
    // become a dependency of this effect.
    untrack(apply)
    localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(appearance)))
  })
}
