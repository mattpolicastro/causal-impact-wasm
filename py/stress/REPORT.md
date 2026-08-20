# Stress-test report

100 replicates per scenario/engine · alpha = 0.05 · guardrails mirrored from the UI (placebo re-run, pre-fit R² < 0.3, pre-period < 30).

| Scenario | Engine | sig. rate | metric | coverage | MAE | guard flag rate | sig. rate when guards pass |
|---|---|---|---|---|---|---|---|
| effect-10pct | bayes | 1.00 | power | 0.96 | 0.005 | 0.17 | 1.00 (n=83) |
| effect-10pct | mle | 1.00 | power | 0.81 | 0.005 | 0.35 | 1.00 (n=65) |
| effect-10pct-short-pre | bayes | 1.00 | power | 0.90 | 0.011 | 0.61 | 1.00 (n=39) |
| effect-10pct-short-pre | mle | 1.00 | power | 0.61 | 0.009 | 0.82 | 1.00 (n=18) |
| effect-5pct | bayes | 1.00 | power | 0.96 | 0.005 | 0.17 | 1.00 (n=83) |
| effect-5pct | mle | 1.00 | power | 0.84 | 0.005 | 0.35 | 1.00 (n=65) |
| null-easy | bayes | 0.04 | FPR | 0.96 | 0.004 | 0.17 | 0.02 (n=83) |
| null-easy | mle | 0.15 | FPR | 0.85 | 0.004 | 0.35 | 0.12 (n=65) |
| null-junk-covariates | bayes | 0.01 | FPR | 0.99 | 0.005 | 0.01 | 0.01 (n=99) |
| null-junk-covariates | mle | 0.54 | FPR | 0.46 | 0.010 | 0.58 | 0.57 (n=42) |
| null-no-covariates | bayes | 0.65 | FPR | 0.35 | 0.015 | 1.00 | — |
| null-no-covariates | mle | 0.73 | FPR | 0.27 | 0.016 | 1.00 | — |
| null-seasonal-misspec | bayes | 0.04 | FPR | 0.96 | 0.009 | 0.84 | 0.06 (n=16) |
| null-seasonal-misspec | mle | 0.04 | FPR | 0.96 | 0.006 | 0.91 | 0.11 (n=9) |
| null-short-pre | bayes | 0.10 | FPR | 0.90 | 0.010 | 0.61 | 0.03 (n=39) |
| null-short-pre | mle | 0.37 | FPR | 0.63 | 0.008 | 0.82 | 0.44 (n=18) |

## Scenario definitions

- **null-easy** — No effect, healthy setup: FPR should be ~alpha. (pre=100, post=30, effect=0.0, real cov=2, junk cov=0)
- **null-short-pre** — No effect, short pre-period: classic over-confidence regime. (pre=30, post=30, effect=0.0, real cov=2, junk cov=0)
- **null-junk-covariates** — No effect, 1 real + 8 junk controls: overfitting regime. (pre=100, post=30, effect=0.0, real cov=1, junk cov=8)
- **null-no-covariates** — No effect, trend-only counterfactual. (pre=100, post=30, effect=0.0, real cov=0, junk cov=0)
- **null-seasonal-misspec** — No effect, weekly cycle the model cannot express: fit check should flag these. (pre=100, post=30, effect=0.0, real cov=2, junk cov=0, seasonal misspec)
- **effect-5pct** — True +5% effect: power and coverage. (pre=100, post=30, effect=0.05, real cov=2, junk cov=0)
- **effect-10pct** — True +10% effect: power and coverage. (pre=100, post=30, effect=0.1, real cov=2, junk cov=0)
- **effect-10pct-short-pre** — True +10% effect with a short pre-period. (pre=30, post=30, effect=0.1, real cov=2, junk cov=0)

Reading guide: null scenarios want sig. rate ≈ alpha and coverage ≈ 0.95; effect scenarios want high sig. rate (power) with coverage ≈ 0.95. "Sig. rate when guards pass" shows the error rate an analyst sees after the sanity-check panel has filtered the untrustworthy runs.
