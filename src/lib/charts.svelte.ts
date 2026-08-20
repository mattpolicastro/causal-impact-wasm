import uPlot from 'uplot'

// Bumped by the appearance module whenever theme mode or palette changes;
// chart-mounting effects depend on `version` to rebuild with fresh tokens.
export const theme = $state({ version: 0, dark: false })

export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export interface SeriesSpec {
  label: string
  values: (number | null)[]
  color: string
  dash?: number[]
  width?: number
}

export interface BandSpec {
  label: string
  upper: (number | null)[]
  lower: (number | null)[]
  color: string
}

export interface ChartSpec {
  xs: number[]
  isDate: boolean
  series: SeriesSpec[]
  bands?: BandSpec[]
  t0x?: number | null
  zeroLine?: boolean
  height?: number
  syncKey?: string
  shade?: { fromX: number; toX: number; color: string } | null
  onClickIdx?: (idx: number) => void
}

function markerPlugin(spec: ChartSpec): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u) => {
        if (!spec.shade) return
        const { ctx } = u
        const x0 = u.valToPos(spec.shade.fromX, 'x', true)
        const x1 = u.valToPos(spec.shade.toX, 'x', true)
        ctx.save()
        ctx.fillStyle = spec.shade.color
        ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height)
        ctx.restore()
      },
      draw: (u) => {
        const { ctx } = u
        const top = u.bbox.top
        const bottom = u.bbox.top + u.bbox.height
        ctx.save()
        if (spec.t0x != null) {
          const x = Math.round(u.valToPos(spec.t0x, 'x', true))
          ctx.strokeStyle = token('--ink-muted')
          ctx.lineWidth = 1
          ctx.setLineDash([5, 5])
          ctx.beginPath()
          ctx.moveTo(x, top)
          ctx.lineTo(x, bottom)
          ctx.stroke()
        }
        const yScale = u.scales.y
        if (spec.zeroLine && yScale.min! < 0 && yScale.max! > 0) {
          const y = Math.round(u.valToPos(0, 'y', true))
          ctx.strokeStyle = token('--axis')
          ctx.lineWidth = 1
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(u.bbox.left, y)
          ctx.lineTo(u.bbox.left + u.bbox.width, y)
          ctx.stroke()
        }
        ctx.restore()
      },
    },
  }
}

export function mountChart(el: HTMLElement, spec: ChartSpec): () => void {
  const data: uPlot.AlignedData = [spec.xs, ...spec.series.map((s) => s.values)]
  const series: uPlot.Series[] = [
    {},
    ...spec.series.map((s) => ({
      label: s.label,
      stroke: s.color,
      width: s.width ?? 2,
      dash: s.dash,
      points: { show: false },
    })),
  ]
  const bands: uPlot.Band[] = []
  for (const band of spec.bands ?? []) {
    const upperIdx = data.length
    data.push(band.upper as never, band.lower as never)
    series.push(
      {
        label: `${band.label} upper`,
        stroke: 'transparent',
        width: 0,
        points: { show: false },
      },
      {
        label: `${band.label} lower`,
        stroke: 'transparent',
        width: 0,
        points: { show: false },
      },
    )
    bands.push({ series: [upperIdx, upperIdx + 1], fill: band.color })
  }

  const axisStyle: uPlot.Axis = {
    stroke: token('--ink-muted'),
    grid: { stroke: token('--grid'), width: 1 },
    ticks: { stroke: token('--grid'), width: 1 },
    font: '11px system-ui, sans-serif',
  }

  const opts: uPlot.Options = {
    width: el.clientWidth || 640,
    height: spec.height ?? 240,
    series,
    bands,
    scales: { x: { time: spec.isDate } },
    axes: [{ ...axisStyle }, { ...axisStyle, size: 64 }],
    legend: { live: true },
    cursor: {
      sync: spec.syncKey ? { key: spec.syncKey, setSeries: false } : undefined,
      points: { size: 8 },
    },
    plugins: [markerPlugin(spec)],
  }

  const u = new uPlot(opts, data, el)
  if (spec.onClickIdx) {
    u.over.addEventListener('click', () => {
      if (u.cursor.idx != null) spec.onClickIdx!(u.cursor.idx)
    })
  }
  const ro = new ResizeObserver(() => {
    if (el.clientWidth > 0) u.setSize({ width: el.clientWidth, height: spec.height ?? 240 })
  })
  ro.observe(el)
  return () => {
    ro.disconnect()
    u.destroy()
  }
}
