import Papa from 'papaparse'
import type {
  AnalysisConfig,
  IndexInfo,
  Mapping,
  ParsedTable,
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
