export interface ParsedTable {
  name: string
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface Mapping {
  indexCol: string | null // null = row number
  yCol: string
  covariateCols: string[]
}

export interface IndexInfo {
  type: 'date' | 'int'
  xs: number[] // epoch seconds (date) or 0..n-1 (int)
  labels: string[] // display labels, same length
}

export interface PreparedData {
  index: IndexInfo
  y: number[]
  covariates: Record<string, number[]>
}

export interface AnalysisConfig {
  preStart: number
  t0: number // first post-intervention index
  postEnd: number
  alpha: number
  standardize: boolean
  seasonPeriod: number | null
  priorLevelSd: number | null // null = auto-optimize
  nSims: number
  seed: number
}

export interface SummaryScope {
  actual: number
  predicted: number
  predicted_lower: number
  predicted_upper: number
  abs_effect: number
  abs_effect_lower: number
  abs_effect_upper: number
  rel_effect: number
  rel_effect_lower: number
  rel_effect_upper: number
}

export interface AnalysisResult {
  series: Record<string, (number | null)[]>
  summary: { average: SummaryScope; cumulative: SummaryScope }
  p_value: number
  alpha: number
  summary_text: string
  report: string
}

export type WorkerRequest =
  | { type: 'init' }
  | { type: 'run'; payload: RunPayload }

export interface RunPayload {
  y: number[]
  covariates: Record<string, number[]>
  pre_period: [number, number]
  post_period: [number, number]
  alpha: number
  standardize: boolean
  nseasons?: { period: number }[]
  prior_level_sd: number | null
  n_sims: number
  seed: number
}

export type WorkerResponse =
  | { type: 'status'; stage: 'loading-runtime' | 'loading-packages' | 'installing' }
  | { type: 'ready' }
  | { type: 'result'; result: AnalysisResult }
  | { type: 'error'; error: string }
