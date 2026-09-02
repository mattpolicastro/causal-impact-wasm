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
  const nCov = Object.keys(data.covariates).length

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
      status: 'fail',
      title: 'No control series — this result is probably not trustworthy',
      detail: 'The counterfactual is extrapolated from the trend alone. Measured on a real daily conversion series, running this with no controls reported an effect on 38% of placebo windows where nothing had happened — against the 5% you are aiming for. The same series with one good control came in at 6%. Add a control that tracks your metric but was untouched by the intervention (the same metric on another device, market or category). Nothing else recovers this: flagging anomalous dates was measured to make no difference.',
    })
  } else if (nCov > preLength / 10) {
    items.push({
      id: 'covariates',
      status: 'warn',
      title: `Many covariates (${nCov}) for the pre-period length`,
      detail: 'Lots of controls relative to training data invites overfitting. The Bayesian engine prunes automatically; still, prefer a few well-chosen controls.',
    })
  }

  // Flagged days inside the measured window contaminate the effect directly:
  // whatever the sale did is being counted as intervention impact.
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
    if (inPost > 0 && nCov > 0) {
      // Measured on a real series: with a decent control, a sale inside the
      // window shifted a known +2% effect by less than a third of a point, and
      // dropping those days recovered nothing. Worth knowing, not worth acting on.
      items.push({
        id: 'flagged-days',
        status: 'info',
        title: `${inPost} flagged ${inPost === 1 ? 'day falls' : 'days fall'} inside the measured period`,
        detail: `${inPost} of ${postLength} days after the intervention are flagged in your file. Your control series covers those days too, which is what keeps this from mattering: on a real series with a good control, a sale inside the window moved a known +2% effect to +2.55% against +2.80% for a clean window, and dropping the days changed nothing. Leave them in and note it in the write-up. Do not shorten the window to avoid them — that traded a 6% false-positive rate for 18%.`,
      })
    } else if (inPost > 0) {
      const share = inPost / postLength
      items.push({
        id: 'flagged-days',
        status: share > 0.15 ? 'fail' : 'warn',
        title: `${inPost} flagged ${inPost === 1 ? 'day falls' : 'days fall'} inside the measured period, with no control series`,
        detail: `${inPost} of ${postLength} days after the intervention are flagged, and there is no control to account for them. Measured on a real series, that combination inflated a known +2% effect to +4.21%; excluding the flagged days brought it back to +2.65%. So excluding them would help here — but it does not rescue the run, because without a control this series produced false positives on 20-67% of windows where nothing had happened. Get a control series first; that is the fix.`,
      })
    } else if (inPre > 0) {
      items.push({
        id: 'flagged-days',
        status: 'info',
        title: `${inPre} flagged days in the pre-period, none in the measured window`,
        detail: 'Good: the period being measured is clean. The flagged days sit in the training history, where a decent control series absorbs them.',
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

  items.push({
    id: 'assumptions',
    status: 'info',
    title: 'Things no statistic can check',
    detail: 'Controls must be unaffected by the intervention, the intervention date must be right, and nothing else big may have happened at the same time. If any of these fail, the estimate is wrong regardless of the checks above.',
  })

  const order: DiagnosticStatus[] = ['fail', 'warn', 'pending', 'pass', 'info']
  return items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
}
