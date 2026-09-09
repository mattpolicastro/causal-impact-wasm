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

/**
 * A column marking rows to leave out — sale days, outages, launches — so the
 * calendar travels in the same file as the data instead of being pasted
 * separately. Recognised by name, and never offered as a covariate: a 0/1 flag
 * is numeric, and silently regressing the metric on "was there a sale" would be
 * a very confusing thing to do by accident.
 */
const EXCLUDE_COLUMN = /^(exclude|excluded|omit|skip|ignore|event|events|sale|sales|promo|promos|holdout)$/i

export function excludeColumn(table: ParsedTable): string | null {
  return table.columns.find((c) => EXCLUDE_COLUMN.test(c.trim())) ?? null
}

/** Blank, 0, false, no and n mean keep. Anything else means leave this row out. */
function isFlagged(v: unknown): boolean {
  if (v === null || v === undefined) return false
  const s = String(v).trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'n'
}

export function inferMapping(table: ParsedTable): Mapping {
  const dateCol = table.columns.find((c) => isDateColumn(table, c)) ?? null
  const flagCol = excludeColumn(table)
  const numeric = table.columns.filter(
    (c) => c !== dateCol && c !== flagCol && isNumericColumn(table, c),
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
  const flagCol = excludeColumn(table)
  const flaggedLabels = flagCol
    ? order.flatMap((i, pos) => (isFlagged(table.rows[i][flagCol]) ? [index.labels[pos]] : []))
    : []

  return { index, y: numberColumn(mapping.yCol, true), covariates, flaggedLabels }
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
    flaggedLabels: data.flaggedLabels,
  }
}

/**
 * Flagged rows sitting inside the training window.
 *
 * Only these can be dropped. A flagged day at or after the intervention is part
 * of what the effect is averaged over, so removing it changes the question
 * rather than cleaning the input — those are reported by the diagnostics panel
 * and left in place.
 */
export function preFlaggedLabels(data: PreparedData, config: AnalysisConfig): string[] {
  if (!data.flaggedLabels.length) return []
  const flagged = new Set(data.flaggedLabels)
  const out: string[] = []
  for (let i = config.preStart; i < config.t0; i++) {
    if (flagged.has(data.index.labels[i])) out.push(data.index.labels[i])
  }
  return out
}

/**
 * Drop those rows and shift the period boundaries to match.
 *
 * A tracking error left in the training window is read as a real observation:
 * it moves the level the model projects forward and inflates the noise scale it
 * believes, which widens every interval that follows. Dropping the row is how
 * you say there is no information for that day, which is what the flag means.
 *
 * On a real daily conversion series with two known tracking errors, dropping
 * them held placebo false alarms at 14%; replacing them with a copied
 * neighbouring day — an observation the model trusts like any other — raised
 * that to 20%.
 *
 * Every dropped row lies in [preStart, t0), so preStart cannot move and the two
 * later boundaries move back by however many were dropped.
 */
export function excludePreFlagged(
  data: PreparedData,
  config: AnalysisConfig,
): { data: PreparedData; config: AnalysisConfig; dropped: string[] } {
  const dropped = preFlaggedLabels(data, config)
  if (!dropped.length) return { data, config, dropped }
  const gone = new Set(dropped)
  const reduced = excludeLabels(data, dropped)
  return {
    data: {
      ...reduced,
      flaggedLabels: data.flaggedLabels.filter((l) => !gone.has(l)),
      excludedLabels: dropped,
    },
    config: { ...config, t0: config.t0 - dropped.length, postEnd: config.postEnd - dropped.length },
    dropped,
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

/**
 * Each row's position on the calendar, in whole time steps from the first row.
 * Contiguous data gives 0..n-1; once rows are excluded the gaps show up here,
 * which is what keeps day-of-week resampling honest.
 *
 * The step is the median gap rather than a day, so weekly or monthly series
 * count in their own units instead of being treated as full of holes.
 */
export function calendarPositions(index: IndexInfo): number[] {
  const xs = index.xs
  if (xs.length < 2) return xs.map((_, i) => i)
  const steps: number[] = []
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1]
    if (d > 0) steps.push(d)
  }
  if (steps.length === 0) return xs.map((_, i) => i)
  steps.sort((a, b) => a - b)
  const step = steps[Math.floor(steps.length / 2)]
  if (!(step > 0)) return xs.map((_, i) => i)
  const pos = xs.map((x) => Math.round((x - xs[0]) / step))
  // Ties would break the strictly-increasing contract the engine checks.
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] <= pos[i - 1]) pos[i] = pos[i - 1] + 1
  }
  return pos
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
    positions: calendarPositions(data.index),
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
