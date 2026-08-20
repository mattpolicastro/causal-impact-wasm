import type { AnalysisConfig, AnalysisResult, PreparedData } from './types'

export type DiagnosticStatus = 'pass' | 'warn' | 'fail' | 'info' | 'pending'

export interface DiagnosticItem {
  id: string
  status: DiagnosticStatus
  title: string
  detail: string
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function prePeriodFit(
  data: PreparedData,
  config: AnalysisConfig,
  result: AnalysisResult,
): { r2: number; scaledMae: number } | null {
  const ys: number[] = []
  const preds: number[] = []
  // Skip the first pre-period point: the MLE engine's diffuse-filter artifact.
  for (let i = config.preStart + 1; i < config.t0; i++) {
    const p = result.series.preds[i]
    const y = data.y[i]
    if (p != null && Number.isFinite(y)) {
      ys.push(y)
      preds.push(p)
    }
  }
  if (ys.length < 5) return null
  const yBar = mean(ys)
  let ssRes = 0
  let ssTot = 0
  let mae = 0
  for (let i = 0; i < ys.length; i++) {
    ssRes += (ys[i] - preds[i]) ** 2
    ssTot += (ys[i] - yBar) ** 2
    mae += Math.abs(ys[i] - preds[i])
  }
  mae /= ys.length
  const sd = Math.sqrt(ssTot / ys.length)
  return { r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, scaledMae: sd > 0 ? mae / sd : Infinity }
}

export function placeboConfig(config: AnalysisConfig): AnalysisConfig | null {
  const preLength = config.t0 - config.preStart
  if (preLength < 20) return null
  const fakeT0 = config.preStart + Math.floor(preLength / 2)
  return { ...config, t0: fakeT0, postEnd: config.t0 - 1 }
}

function significant(result: AnalysisResult): boolean {
  const { rel_effect_lower: lo, rel_effect_upper: hi } = result.summary.average
  return Math.sign(lo) === Math.sign(hi)
}

export function assess(
  data: PreparedData,
  config: AnalysisConfig,
  result: AnalysisResult,
  placebo: AnalysisResult | 'pending' | 'skipped' | { error: string },
): DiagnosticItem[] {
  const items: DiagnosticItem[] = []
  const preLength = config.t0 - config.preStart
  const nCov = Object.keys(data.covariates).length

  const fit = prePeriodFit(data, config, result)
  if (fit) {
    const pct = (fit.r2 * 100).toFixed(0)
    if (fit.r2 >= 0.8) {
      items.push({
        id: 'fit',
        status: 'pass',
        title: 'Model tracks the pre-period well',
        detail: `The counterfactual explains ${pct}% of the variation before the intervention (R² = ${fit.r2.toFixed(2)}).`,
      })
    } else if (fit.r2 >= 0.5) {
      items.push({
        id: 'fit',
        status: 'warn',
        title: 'Mediocre pre-period fit',
        detail: `The counterfactual explains only ${pct}% of pre-intervention variation. The effect estimate inherits that noise — treat the size of the effect as rough.`,
      })
    } else {
      items.push({
        id: 'fit',
        status: 'fail',
        title: 'Poor pre-period fit',
        detail: `The model can't explain your metric even before the intervention (R² = ${fit.r2.toFixed(2)}). Its "what would have happened" baseline is unreliable — consider better control series or a longer pre-period.`,
      })
    }
  }

  if (placebo === 'pending') {
    items.push({
      id: 'placebo',
      status: 'pending',
      title: 'Placebo check running…',
      detail: 'Re-running the analysis with a fake intervention date inside the pre-period, where there should be no effect.',
    })
  } else if (placebo === 'skipped') {
    items.push({
      id: 'placebo',
      status: 'info',
      title: 'Placebo check skipped',
      detail: 'The pre-period is too short (< 20 points) to hold out a placebo window.',
    })
  } else if ('error' in (placebo as object)) {
    items.push({
      id: 'placebo',
      status: 'info',
      title: 'Placebo check failed to run',
      detail: (placebo as { error: string }).error,
    })
  } else {
    const p = placebo as AnalysisResult
    if (significant(p)) {
      items.push({
        id: 'placebo',
        status: 'fail',
        title: 'Placebo check failed',
        detail: `A fake intervention placed inside the pre-period also shows a "significant" effect (${(p.summary.average.rel_effect * 100).toFixed(1)}%). The model finds effects where none exist here, so the headline result should not be trusted.`,
      })
    } else {
      items.push({
        id: 'placebo',
        status: 'pass',
        title: 'Placebo check passed',
        detail: 'A fake intervention inside the pre-period shows no significant effect — the model is not hallucinating impact on this data.',
      })
    }
  }

  if (preLength >= 50) {
    items.push({
      id: 'pre-length',
      status: 'pass',
      title: `Pre-period length OK (${preLength} points)`,
      detail: 'Enough history for the model to learn the relationship between your metric and its controls.',
    })
  } else if (preLength >= 30) {
    items.push({
      id: 'pre-length',
      status: 'warn',
      title: `Short pre-period (${preLength} points)`,
      detail: 'Intervals get optimistic with little training history. Prefer 50+ points when you can.',
    })
  } else {
    items.push({
      id: 'pre-length',
      status: 'fail',
      title: `Very short pre-period (${preLength} points)`,
      detail: 'With fewer than 30 training points the uncertainty is understated and the model can be badly fooled. Extend the pre-period if at all possible.',
    })
  }

  if (nCov === 0) {
    items.push({
      id: 'covariates',
      status: 'warn',
      title: 'No control series',
      detail: 'The counterfactual is extrapolated from the trend alone, which is weak. Add control series that track your metric but were not touched by the intervention (other markets, unaffected products…).',
    })
  } else if (nCov > preLength / 10) {
    items.push({
      id: 'covariates',
      status: 'warn',
      title: `Many covariates (${nCov}) for the pre-period length`,
      detail: 'Lots of controls relative to training data invites overfitting. The Bayesian engine prunes automatically; still, prefer a few well-chosen controls.',
    })
  }

  const avg = result.summary.average
  if (!significant(result)) {
    items.push({
      id: 'significance',
      status: 'info',
      title: 'No significant effect detected',
      detail: 'The confidence interval includes zero. That is a finding, not a failure — but do not report the point estimate as an effect.',
    })
  } else {
    const margin = Math.min(Math.abs(avg.rel_effect_lower), Math.abs(avg.rel_effect_upper))
    if (margin < Math.abs(avg.rel_effect) * 0.2) {
      items.push({
        id: 'significance',
        status: 'warn',
        title: 'Marginal significance',
        detail: 'The interval barely excludes zero. Small modelling choices could flip this conclusion — treat it as suggestive, not established.',
      })
    }
  }

  items.push({
    id: 'assumptions',
    status: 'info',
    title: 'Things no statistic can check',
    detail: 'Controls must be unaffected by the intervention, the intervention date must be right, and nothing else big may have happened at the same time. If any of these fail, the estimate is wrong regardless of the checks above.',
  })

  const order: DiagnosticStatus[] = ['fail', 'warn', 'pending', 'pass', 'info']
  return items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
}
