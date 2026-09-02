import Papa from 'papaparse'
import type {
  AnalysisConfig,
  IndexInfo,
  Mapping,
  ParsedTable,
  PowerConfig,
  PowerPayload,
  PreparedData,
  RunPayload,
} from './types'

export function parseCsv(text: string, name: string): ParsedTable {
  const parsed = Papa.parse<Record<string, unknown>>(text.trim(), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  })
  const fatal = parsed.errors.find((e) => e.type !== 'FieldMismatch')
  if (fatal) throw new Error(`CSV parse failed: ${fatal.message}`)
  const columns = (parsed.meta.fields ?? []).filter((f) => f !== '')
  if (columns.length === 0 || parsed.data.length === 0) {
    throw new Error('No columns or rows found in the CSV.')
  }
  return { name, columns, rows: parsed.data }
}

function parseDateValue(v: unknown): number | null {
  if (v instanceof Date) return v.getTime()
  if (typeof v !== 'string') return null
  // Bare YYYYMMDD integers won't reach here (dynamicTyping makes them numbers).
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

export function isDateColumn(table: ParsedTable, col: string): boolean {
  return table.rows.every((r) => parseDateValue(r[col]) !== null)
}

function isNumericColumn(table: ParsedTable, col: string): boolean {
  return table.rows.some((r) => typeof r[col] === 'number')
}

export function inferMapping(table: ParsedTable): Mapping {
  const dateCol = table.columns.find((c) => isDateColumn(table, c)) ?? null
  const numeric = table.columns.filter(
    (c) => c !== dateCol && isNumericColumn(table, c),
  )
  if (numeric.length === 0) throw new Error('No numeric columns found in the CSV.')
  return { indexCol: dateCol, yCol: numeric[0], covariateCols: numeric.slice(1) }
}

export function prepare(table: ParsedTable, mapping: Mapping): PreparedData {
  let order = table.rows.map((_, i) => i)
  let index: IndexInfo

  if (mapping.indexCol && isDateColumn(table, mapping.indexCol)) {
    const times = table.rows.map((r) => parseDateValue(r[mapping.indexCol!])!)
    order.sort((a, b) => times[a] - times[b])
    index = {
      type: 'date',
      xs: order.map((i) => times[i] / 1000),
      labels: order.map((i) => new Date(times[i]).toISOString().slice(0, 10)),
    }
  } else {
    index = {
      type: 'int',
      xs: order,
      labels: mapping.indexCol
        ? order.map((i) => String(table.rows[i][mapping.indexCol!]))
        : order.map((i) => String(i)),
    }
  }

  const numberColumn = (col: string, allowNaN: boolean): number[] =>
    order.map((i, pos) => {
      const v = table.rows[i][col]
      const num = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(num) && !allowNaN) {
        throw new Error(`Column “${col}” has a non-numeric value at row ${pos + 1}.`)
      }
      return num
    })

  const covariates: Record<string, number[]> = {}
  for (const col of mapping.covariateCols) {
    covariates[col] = numberColumn(col, false)
  }
  return { index, y: numberColumn(mapping.yCol, true), covariates }
}

export function makeRunPayload(data: PreparedData, config: AnalysisConfig): RunPayload {
  return {
    engine: config.engine,
    y: data.y,
    covariates: data.covariates,
    pre_period: [config.preStart, config.t0 - 1],
    post_period: [config.t0, config.postEnd],
    alpha: config.alpha,
    standardize: config.standardize,
    ...(config.engine === 'mle' && config.seasonPeriod
      ? { nseasons: [{ period: config.seasonPeriod }] }
      : {}),
    prior_level_sd: config.engine === 'bayes' ? (config.priorLevelSd ?? 0.01) : config.priorLevelSd,
    n_sims: config.nSims,
    niter: 1000,
    seed: config.seed,
  }
}

/**
 * Candidate durations for a power sweep, in time points. The model fits on the
 * whole history whatever the duration, but the stand-in future is the tail of
 * that history, so a candidate cannot exceed half of it.
 */
export function defaultDurations(n: number): number[] {
  if (n < 30) return []
  return [7, 14, 21, 28, 42, 56, 70, 84].filter((d) => d * 2 <= n)
}

/**
 * Drop labelled rows before planning. Sale days and outages sit far from the
 * metric's normal level, and a model fit through them believes the metric is
 * noisier than it is — which inflates every duration's required effect.
 *
 * Rows are removed rather than gapped: the engine has no missing-data path, and
 * for estimating how noisy a metric is the gap's exact width does not matter.
 * That is not true of the analysis path, where dropping days inside the
 * post-period would bias the effect, so this is planning-only.
 */
export function excludeLabels(data: PreparedData, labels: string[]): PreparedData {
  const drop = new Set(labels)
  const keep: number[] = []
  data.index.labels.forEach((l, i) => {
    if (!drop.has(l)) keep.push(i)
  })
  if (keep.length === data.index.labels.length) return data
  const pick = <T>(a: T[]) => keep.map((i) => a[i])
  const covariates: Record<string, number[]> = {}
  for (const [name, values] of Object.entries(data.covariates)) {
    covariates[name] = pick(values)
  }
  return {
    index: {
      type: data.index.type,
      xs: pick(data.index.xs),
      labels: pick(data.index.labels),
    },
    y: pick(data.y),
    covariates,
  }
}

/**
 * Days sitting far enough from the metric's usual level to distort a fit,
 * by median absolute deviation on the log scale so that the outliers do not
 * inflate the very threshold meant to catch them.
 *
 * A starting point for the analyst, never an answer: run against a real series
 * this flagged one known sale window and missed another entirely. The calendar
 * is the source of truth.
 */
export function detectOutlierLabels(data: PreparedData, z = 3): string[] {
  const finite = data.y.filter((v) => Number.isFinite(v) && v > 0)
  if (finite.length < 10) return []
  const logs = finite.map(Math.log).sort((a, b) => a - b)
  const median = logs[Math.floor(logs.length / 2)]
  const devs = logs.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
  const mad = devs[Math.floor(devs.length / 2)] * 1.4826
  if (!(mad > 0)) return []
  const out: string[] = []
  data.y.forEach((v, i) => {
    if (Number.isFinite(v) && v > 0 && Math.abs(Math.log(v) - median) / mad > z) {
      out.push(data.index.labels[i])
    }
  })
  return out
}

export function makePowerPayload(
  data: PreparedData,
  config: PowerConfig,
): PowerPayload {
  return {
    task: 'power',
    y: data.y,
    covariates: data.covariates,
    durations: config.durations,
    effects: config.effects,
    alpha: config.alpha,
    n_sims: config.nSims,
    harm_threshold: config.mode === 'no-harm' ? config.harmThreshold : null,
    power_target: config.powerTarget,
    prior_level_sd: config.priorLevelSd,
    niter: 1000,
    seed: config.seed,
  }
}

export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const escape = (v: string | number | null) => {
    if (v === null) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [header, ...rows].map((r) => r.map(escape).join(',')).join('\n')
}

export function download(filename: string, content: Blob | string, type = 'text/csv') {
  const blob = content instanceof Blob ? content : new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
