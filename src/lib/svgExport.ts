import type { ChartSpec } from './charts.svelte'
import { token } from './charts.svelte'

const WIDTH = 920
const PAD = { left: 64, right: 16, top: 30, bottom: 26 }
const PANEL_GAP = 18

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min]
  const span = max - min
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10))
  return ticks
}

function fmtTick(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (abs >= 10 || v === 0) return v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

interface Panel {
  title: string
  spec: ChartSpec
  xLabels: string[]
  height: number
}

function renderPanel(p: Panel, yOffset: number, colors: Record<string, string>): string {
  const { spec } = p
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = p.height - PAD.top - PAD.bottom
  const xs = spec.xs

  let yMin = Infinity
  let yMax = -Infinity
  const scan = (values: (number | null)[]) => {
    for (const v of values) {
      if (v != null && Number.isFinite(v)) {
        if (v < yMin) yMin = v
        if (v > yMax) yMax = v
      }
    }
  }
  spec.series.forEach((s) => scan(s.values))
  spec.bands?.forEach((b) => {
    scan(b.upper)
    scan(b.lower)
  })
  if (spec.zeroLine) {
    yMin = Math.min(yMin, 0)
    yMax = Math.max(yMax, 0)
  }
  const yPad = (yMax - yMin || 1) * 0.06
  yMin -= yPad
  yMax += yPad

  const xMin = xs[0]
  const xMax = xs[xs.length - 1]
  const X = (v: number) => PAD.left + ((v - xMin) / (xMax - xMin || 1)) * plotW
  const Y = (v: number) => yOffset + PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH

  const path = (values: (number | null)[]): string => {
    let d = ''
    let pen = false
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v == null || !Number.isFinite(v)) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)}`
      pen = true
    }
    return d
  }

  const parts: string[] = []
  const top = yOffset + PAD.top
  const bottom = top + plotH

  parts.push(
    `<text x="${PAD.left}" y="${yOffset + 18}" fill="${colors.inkSecondary}" font-size="12" font-weight="600" letter-spacing="0.04em">${esc(p.title.toUpperCase())}</text>`,
  )

  const yTicks = niceTicks(yMin, yMax)
  for (const t of yTicks) {
    const y = Y(t).toFixed(1)
    parts.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${WIDTH - PAD.right}" y2="${y}" stroke="${colors.grid}" stroke-width="1"/>`,
      `<text x="${PAD.left - 8}" y="${y}" fill="${colors.inkMuted}" font-size="11" text-anchor="end" dominant-baseline="middle">${esc(fmtTick(t))}</text>`,
    )
  }

  const nXTicks = Math.min(6, xs.length)
  for (let i = 0; i < nXTicks; i++) {
    const idx = Math.round((i * (xs.length - 1)) / Math.max(nXTicks - 1, 1))
    const x = X(xs[idx]).toFixed(1)
    const anchor = i === nXTicks - 1 ? 'end' : 'middle'
    parts.push(
      `<text x="${x}" y="${bottom + 16}" fill="${colors.inkMuted}" font-size="11" text-anchor="${anchor}">${esc(p.xLabels[idx] ?? String(xs[idx]))}</text>`,
    )
  }

  for (const band of spec.bands ?? []) {
    let d = ''
    let pen = false
    for (let i = 0; i < band.upper.length; i++) {
      const v = band.upper[i]
      if (v == null || !Number.isFinite(v)) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)}`
      pen = true
    }
    for (let i = band.lower.length - 1; i >= 0; i--) {
      const v = band.lower[i]
      if (v == null || !Number.isFinite(v)) continue
      d += `L${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)}`
    }
    if (d) parts.push(`<path d="${d}Z" fill="${band.color}" stroke="none"/>`)
  }

  if (spec.zeroLine && yMin < 0 && yMax > 0) {
    const y = Y(0).toFixed(1)
    parts.push(
      `<line x1="${PAD.left}" y1="${y}" x2="${WIDTH - PAD.right}" y2="${y}" stroke="${colors.axis}" stroke-width="1"/>`,
    )
  }

  for (const s of spec.series) {
    const dash = s.dash ? ` stroke-dasharray="${s.dash.join(' ')}"` : ''
    parts.push(
      `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}"${dash} stroke-linejoin="round"/>`,
    )
  }

  if (spec.t0x != null) {
    const x = X(spec.t0x).toFixed(1)
    parts.push(
      `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${colors.inkMuted}" stroke-width="1" stroke-dasharray="5 5"/>`,
    )
  }

  // Legend, top-right of the panel.
  let lx = WIDTH - PAD.right
  const legend: string[] = []
  const entries = [
    ...spec.series.map((s) => ({ label: s.label, color: s.color })),
    ...(spec.bands ?? []).map((b) => ({ label: b.label, color: b.color })),
  ]
  for (const e of entries.reverse()) {
    const w = e.label.length * 6.4 + 18
    lx -= w
    legend.push(
      `<rect x="${lx}" y="${yOffset + 8}" width="10" height="10" rx="2" fill="${e.color}"/>`,
      `<text x="${lx + 14}" y="${yOffset + 17}" fill="${colors.inkSecondary}" font-size="11">${esc(e.label)}</text>`,
    )
  }
  parts.push(...legend)

  return parts.join('\n')
}

export function chartsToSvg(
  panels: { title: string; spec: ChartSpec }[],
  xLabels: string[],
): string {
  const colors = {
    surface: token('--chart-bg'),
    inkSecondary: token('--ink-secondary'),
    inkMuted: token('--ink-muted'),
    grid: token('--grid'),
    axis: token('--axis'),
  }
  const heights = panels.map((p) => (p.spec.height ?? 240) + PAD.top + PAD.bottom)
  const total = heights.reduce((a, b) => a + b + PANEL_GAP, PANEL_GAP)
  const body: string[] = []
  let y = PANEL_GAP
  panels.forEach((p, i) => {
    body.push(renderPanel({ ...p, xLabels, height: heights[i] }, y, colors))
    y += heights[i] + PANEL_GAP
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${total}" viewBox="0 0 ${WIDTH} ${total}" font-family="system-ui, sans-serif">`,
    `<rect width="${WIDTH}" height="${total}" fill="${colors.surface}"/>`,
    ...body,
    '</svg>',
  ].join('\n')
}
