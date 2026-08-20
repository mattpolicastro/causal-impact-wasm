import { untrack } from 'svelte'
import { theme } from './charts.svelte'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface ChartColors {
  background: string
  observed: string
  counterfactual: string
}

// Quick presets drawn from the validated reference palette: each pair is
// adjacent in the CVD-checked slot ordering, so every preset is
// colorblind-safe in both modes.
export const PRESETS = {
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

export type PresetId = keyof typeof PRESETS

const SURFACES = { light: '#fcfcfb', dark: '#1a1a19' }
const STORAGE_KEY = 'ci-appearance'
const HEX = /^#[0-9a-f]{6}$/

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** Accepts #rgb, #rrggbb, or rgb(r, g, b); returns normalized #rrggbb or null. */
export function parseColor(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (HEX.test(s)) return s
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  }
  const rgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*[,)]/)
  if (rgb) {
    const to = (v: string) => Math.min(255, +v).toString(16).padStart(2, '0')
    return `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`
  }
  return null
}

function validChart(value: unknown): value is ChartColors {
  const c = value as ChartColors
  return !!c && [c.background, c.observed, c.counterfactual].every(
    (v) => typeof v === 'string' && HEX.test(v),
  )
}

function load(): { mode: ThemeMode; custom: ChartColors | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      mode: ['system', 'light', 'dark'].includes(saved.mode) ? saved.mode : 'system',
      custom: validChart(saved.custom) ? saved.custom : null,
    }
  } catch {
    return { mode: 'system', custom: null }
  }
}

export const appearance = $state(load())

export function isDark(): boolean {
  return appearance.mode === 'dark' || (appearance.mode === 'system' && media.matches)
}

export function themeDefaults(dark = isDark()): ChartColors {
  const [observed, counterfactual] = PRESETS['blue-orange'][dark ? 'dark' : 'light']
  return { background: SURFACES[dark ? 'dark' : 'light'], observed, counterfactual }
}

/** The colors charts actually use: custom overrides, else theme defaults. */
export function chartColors(): ChartColors {
  return appearance.custom ?? themeDefaults()
}

export function bandColor(hex: string, dark = isDark()): string {
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
  const colors = chartColors()
  root.style.setProperty('--chart-bg', colors.background)
  root.style.setProperty('--series-observed', colors.observed)
  root.style.setProperty('--series-model', colors.counterfactual)
  root.style.setProperty('--series-model-band', bandColor(colors.counterfactual, dark))
  theme.dark = dark
  theme.version += 1
}

media.addEventListener('change', apply)

export function setChartColor(field: keyof ChartColors, value: string) {
  const parsed = parseColor(value)
  if (!parsed) return
  appearance.custom = { ...chartColors(), [field]: parsed }
}

export function applyPreset(id: PresetId) {
  const [observed, counterfactual] = PRESETS[id][isDark() ? 'dark' : 'light']
  appearance.custom = { background: chartColors().background, observed, counterfactual }
}

export function resetChartColors() {
  appearance.custom = null
}

export function initAppearance() {
  $effect(() => {
    void appearance.mode
    void appearance.custom
    // untrack: apply() bumps theme.version (read-modify-write), which must not
    // become a dependency of this effect.
    untrack(apply)
    localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(appearance)))
  })
}
