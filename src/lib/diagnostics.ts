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
  // The placebo window mirrors the real post-period length (capped at a third
  // of the pre-period) so the check is as hard as the real analysis — no
  // harder. A half/half split trains on too little and evaluates too long,
  // which makes the placebo fail on perfectly healthy data.
  const postLength = config.postEnd - config.t0 + 1
  const window = Math.max(5, Math.min(postLength, Math.floor(preLength / 3)))
  const fakeT0 = config.t0 - window
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
  // Count the covariates the engine actually fitted, not the ones supplied.
  // Zero-variance columns are dropped at the runner boundary, so a single
  // constant control would otherwise read as "has a control" everywhere below —
  // silencing the no-control warning on a run that had none.
  const dropped = result.dropped_covariates ?? []
  const nCov = Object.keys(data.covariates).length - dropped.length

  if (dropped.length) {
    items.push({
      id: 'dropped-covariates',
      status: 'warn',
      title: `${dropped.length === 1 ? 'Control series ignored' : `${dropped.length} control series ignored`}: ${dropped.join(', ')}`,
      detail: `Never changes over the period the model trains on, so it carries no information and was dropped. Often a padded export, or a channel that was flat until it launched. Everything below counts ${nCov} usable control${nCov === 1 ? '' : 's'}.`,
    })
  }

  // Low R² mostly reflects noisy data, which the intervals already absorb by
  // widening (verified in the stress harness: misspecified-fit scenarios keep
  // nominal false-positive rates). It only becomes a problem when the model
  // explains almost nothing.
  const fit = prePeriodFit(data, config, result)
  if (fit) {
    const pct = (fit.r2 * 100).toFixed(0)
    if (fit.r2 >= 0.7) {
      items.push({
        id: 'fit',
        status: 'pass',
        title: 'Model tracks the pre-period well',
        detail: `The counterfactual explains ${pct}% of the variation before the intervention (R² = ${fit.r2.toFixed(2)}).`,
      })
    } else if (fit.r2 >= 0.3) {
      items.push({
        id: 'fit',
        status: 'info',
        title: 'Noisy pre-period fit',
        detail: `The counterfactual explains ${pct}% of pre-intervention variation. That mostly means your metric is noisy: intervals widen to compensate, so the verdict stays honest, but small effects will be hard to detect.`,
      })
    } else {
      items.push({
        id: 'fit',
        status: 'fail',
        title: 'Model explains almost nothing',
        detail: `R² = ${fit.r2.toFixed(2)} before the intervention — the counterfactual is barely better than guessing. Consider control series that actually track your metric, or a longer pre-period.`,
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

  // Flagged days inside the measured window. Placebo sweeps on a real daily
  // conversion series, with a known +2% effect injected, put numbers on this:
  //   with a control:  clean window estimated +2.80%, sale in window +2.55%,
  //                    dropping the flagged days +2.68% — no material difference
  //   no control:      sale in window +4.21%, dropping the days +2.65%
  //   shortening the window to avoid a sale: 18% false positives against 6%
  // Hence: informational when controls are present, a caution when they are not.
  if (data.flaggedLabels.length) {
    const flagged = new Set(data.flaggedLabels)
    let inPost = 0
    let inPre = 0
    for (let i = config.preStart; i <= config.postEnd; i++) {
      if (!flagged.has(data.index.labels[i])) continue
      if (i >= config.t0) inPost++
      else inPre++
    }
    const postLength = config.postEnd - config.t0 + 1
    const label = `${inPost} flagged ${inPost === 1 ? 'day falls' : 'days fall'} inside the measured period`
    if (inPost > 0 && nCov > 0) {
      items.push({
        id: 'flagged-days',
        status: 'info',
        title: label,
        detail: `${inPost} of ${postLength} days after the intervention are flagged. Your controls cover those days too, so this is unlikely to move the result — leave them in and note it. Shortening the window to avoid them tests worse than keeping them.`,
      })
    } else if (inPost > 0) {
      items.push({
        id: 'flagged-days',
        status: 'warn',
        title: `${label}, with no control series`,
        detail: `${inPost} of ${postLength} days after the intervention are flagged, with no control to account for them. Whatever happened on those days is being read as intervention impact. Excluding them gives a cleaner estimate here, or report the effect as including them.`,
      })
    } else if (inPre > 0) {
      items.push({
        id: 'flagged-days',
        status: 'info',
        title: `${inPre} flagged days in the pre-period, none in the measured window`,
        detail: 'The period being measured is clean. The flagged days sit in the training history.',
      })
    }
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

  const excluded = data.excludedLabels ?? []
  if (excluded.length) {
    const shown = excluded.slice(0, 6).join(', ')
    items.push({
      id: 'excluded',
      status: 'info',
      title: `${excluded.length} flagged ${excluded.length === 1 ? 'day' : 'days'} excluded from the pre-period`,
      detail: `${shown}${excluded.length > 6 ? `, and ${excluded.length - 6} more` : ''}. These rows were removed before fitting, so the pre-period is that many points shorter than the file. Flagged days in the measured window are never removed.`,
    })
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
