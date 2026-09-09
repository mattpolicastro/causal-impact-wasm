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
  /** Labels flagged by an exclude column in the source file, if there was one. */
  flaggedLabels: string[]
  /** Labels removed from the fit, so the result can say what it left out. */
  excludedLabels?: string[]
}

export type Engine = 'bayes' | 'mle'

export interface AnalysisConfig {
  engine: Engine
  preStart: number
  t0: number // first post-intervention index
  postEnd: number
  alpha: number
  standardize: boolean
  seasonPeriod: number | null
  priorLevelSd: number | null // null = auto-optimize (MLE engine only)
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
  engine: Engine
  inclusion_probs?: Record<string, number>
  /**
   * Covariates removed before fitting because they had no variance over the
   * window the engine standardizes on. Zero-variance columns carry no
   * information and break every engine, so they are dropped rather than
   * passed through; surface them so the analyst knows their column was
   * ignored.
   */
  dropped_covariates?: string[]
}

/** Planning a test that has not run yet: history only, no intervention date. */
export type PowerMode = 'lift' | 'no-harm'

export interface PowerConfig {
  mode: PowerMode
  /** Labels (ISO dates or row numbers) to drop before fitting. */
  excludedLabels: string[]
  /** Must match what the real analysis will run: it dominates the answer. */
  priorLevelSd: number
  /** Negative fraction: -0.02 means "a drop worse than 2% is unacceptable". */
  harmThreshold: number
  alpha: number
  powerTarget: number
  durations: number[]
  effects: number[]
  nSims: number
  seed: number
}

export interface PowerPayload {
  task: 'power'
  y: number[]
  covariates: Record<string, number[]>
  durations: number[]
  effects: number[]
  /** Each row's place on the calendar; differs from its index once rows are excluded. */
  positions: number[] | null
  alpha: number
  n_sims: number
  harm_threshold: number | null
  power_target: number
  prior_level_sd: number
  niter: number
  seed: number
}

export interface PowerResult {
  durations: number[]
  effects: number[]
  /** power[durationIndex][effectIndex], each 0..1 */
  power: number[][]
  /** Smallest detectable effect at power_target, one per duration. */
  mde: number[]
  false_positive: number[]
  recommended_duration: number | null
  mode: 'superiority' | 'non_inferiority'
  harm_threshold: number | null
  power_target: number
  alpha: number
  /** Points the model was fit on: the whole history, for every duration. */
  n_train: number
  n_sims: number
  covariate_names: string[]
  /**
   * Covariates removed before fitting because they had no variance over the
   * window the engine standardizes on. Zero-variance columns carry no
   * information and break every engine, so they are dropped rather than
   * passed through; surface them so the analyst knows their column was
   * ignored.
   */
  dropped_covariates?: string[]
}

export type WorkerRequest =
  | { type: 'init' }
  | { type: 'run'; payload: RunPayload }
  | { type: 'power'; payload: PowerPayload }

export interface RunPayload {
  engine: Engine
  y: number[]
  covariates: Record<string, number[]>
  pre_period: [number, number]
  post_period: [number, number]
  alpha: number
  standardize: boolean
  nseasons?: { period: number }[]
  prior_level_sd: number | null
  n_sims: number
  niter?: number
  seed: number
}

export type WorkerResponse =
  | { type: 'status'; stage: 'loading-runtime' | 'loading-packages' | 'installing' }
  | { type: 'ready' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: AnalysisResult | PowerResult }
  | { type: 'error'; error: string }
