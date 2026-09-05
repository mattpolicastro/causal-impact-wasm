# WORKLOG

## 2026-09-04 — First external contribution: "Plan a test" mode + constant-covariate fix

- **Merged PR #1** (@BrokLori, 6 commits): prospective power simulation — "how
  long must this test run?", estimated from history before any intervention has
  happened. New `py/power.py` + 15 tests, `task: 'power'` dispatch in
  `runner.py`, a "Measure an impact" / "Plan a test" mode switch, and
  exclude-column parsing so the event calendar travels in the CSV.
- Review confirmed the claims: `structural_paths()` split out of
  `posterior_predict()` preserves RNG draw order, so output is bit-identical to
  main (checked directly) and `test_r_parity` still passes; `npm run check` 0
  errors, 2 pre-existing warnings.
- **Two findings of hers worth keeping.** `prior_level_sd` dominates the
  planning answer — MDE at 84 days was 2.70% at 0.001, 9.08% at 0.01, 63.12%
  at 0.1, so the two `ModelConfig` presets are not a minor tuning knob. And
  day-of-week on real e-commerce data is ±6%, not the ±30% our synthetic
  fixtures assume: the missing `nseasons` support in the Bayesian engine is
  worth having but is *not* what is costing accuracy on real series.
- Counterintuitive result the planner exposes: whether a longer test helps
  depends on which variance term dominates. Good controls collapse `sigma_obs`,
  the random-walk level takes over, and MDE grows as sqrt(N) — a longer test
  becomes actively *worse*. The better the control series, the sooner that
  happens.
- **Constant-covariate crash fixed** (`6792648`; she reported it, traced here).
  Broke all three entrypoints for different reasons: the MLE path standardizes
  with `std.fillna(1)` (`causalimpact/misc.py`), which catches an all-NaN column
  but not a zero one, so 0/0 → NaN and statsmodels rejects the design matrix;
  the Bayesian path already guards the divide (`sd_x[sd_x == 0] = 1.0`) but is
  left with a zero column that makes the spike-and-slab marginal likelihood
  singular. **Each engine carries exactly the guard the other one lacks**, and
  neither is sufficient — so the fix belongs in `run()` at the contract
  boundary, not in either engine.
- Wider than reported: it also fires when a column is flat across the
  pre-period but moves afterwards (a channel that was zero until launch), so
  the check looks at the window the engine actually fits and standardizes on.
  Near-constant is fine — 1e-12 relative jitter runs clean in both engines — so
  the trigger is exact zero variance; a tolerance would silently discard
  legitimate steady controls.
- Tests hold the fix to *lossless*, not "does not crash": with the flat column
  dropped, series and summary are identical to omitting it from the payload,
  including the fallback to a no-covariate run. **54 tests pass** (was 29).
- **Open — `recommended_duration` is seed-unstable.** Measured 21 to 84 days
  across 12 seeds on one fixed series. The MDE curve underneath is precise
  (sd ≈ 0.1pp on 2–3pp values); the knee test in `_recommend` compares
  neighbours whose difference is the same size as its own noise. Merged
  knowingly — the full MDE table is shown alongside the headline. Options:
  average the knee over several RNG streams, normalise the threshold per time
  point rather than per step (the grid steps by 7 then by 14), or drop the
  single number for a banded curve.
- **Open — `dropped_covariates`** is returned and declared in `types.ts` but no
  UI reads it, so a constant column is currently dropped silently. Relatedly,
  `inferMapping` still auto-selects constant columns; now harmless rather than
  fatal, but a padded export still gets one picked for it.

## 2026-08-19 (evening) — validation: R parity, fixtures, stress harness

- **R parity (gold standard)**: compiled R CausalImpact 1.4.1 + bsts 0.9.11
  (brew formula R needs source builds — the `r-app` cask would've taken CRAN
  binaries; needs interactive sudo). `tests/fixtures/generate_r_reference.R`
  runs the real R package on four known datasets (classic ARMA null, google
  example, Dafiti comparison data, VW dieselgate — fixtures from tfcausalimpact,
  Apache 2.0); `test_r_parity.py` checks both engines against it. **All 8 pass**;
  on dieselgate all three implementations land on ≈ −25%. `r_reference.json`
  is committed so parity runs without R.
- **Stress harness** (`py/stress/harness.py`): 8 scenarios × 100 reps × both
  engines, measuring FPR/power/coverage plus UI-guardrail catch rates. Findings:
  - Bayes is calibrated (FPR 1–10%, coverage 0.90–0.99); MLE is not in the bad
    regimes (junk covariates FPR **54%**, short pre-period 37%) — confirms the
    default-engine choice.
  - Trend-only (no covariates) on drifting data is invalid in *both* engines
    (FPR ~65–73%) — but guards flag it 100% of the time.
  - Guardrails after recalibration: flag ~17% of healthy runs, 61–100% of bad
    regimes; "protected FPR" (runs the panel lets through) ≤ 3% for bayes.
- **Guardrail recalibration from the data**: placebo window now mirrors the
  real post-period length (half/half split was harsher than the real analysis
  and over-fired); R² demoted from hard gate to info/caution (fail only < 0.3)
  because low R² widens intervals rather than breaking calibration — the
  seasonal-misspec scenario keeps FPR at 4% despite bad fit.
- Added VW dieselgate as a third in-app sample dataset.
- Dev server: vite `allowedHosts` now includes mac-studio / mac-studio.local.

## 2026-08-19 (later) — v2: Bayesian engine + guardrails

- **Track 2**: pure-numpy Gibbs sampler (`py/bayes.py`) — FFBS local level,
  SSVS spike-and-slab over covariates, conjugate variance updates, truncated
  level-sd prior matching CausalImpact's convention (fraction of sd(y), df=32).
  Deterministic given seed; ~300ms native / ~1-2s wasm for n=180, niter=1000.
  Now the default engine; MLE remains as "fast approximation" (and the only
  seasonal-capable engine). Reports posterior inclusion probabilities in UI.
  Tests: effect recovery, null non-significance, junk-covariate pruning
  (real X included ~100%, junk pruned), MLE agreement on easy data, null
  calibration (40-sim false-positive smoke test, `-m slow`).
- **Track 1**: automated sanity checks after every run (`src/lib/diagnostics.ts`
  + DiagnosticsPanel): pre-period fit R², automatic placebo re-run with fake
  intervention mid-pre-period, pre-period-length and covariate-count warnings,
  marginal-significance caution, and a fixed note on unverifiable assumptions.
  Panel sorts failures first and headlines "N problems found" for naive users.
- Verified end-to-end in browser: Bayesian result matches native to the digit;
  placebo auto-runs; the fit check correctly flagged unmodeled weekly
  seasonality in the ad-campaign sample (R²=0.66 caution).
- Next: systematic error-rate stress testing (false-positive/coverage sweeps).

## 2026-08-19 — Project bootstrap: CausalImpact in the browser

- Researched feasibility: webR route is dead (`bsts`/`BoomSpikeSlab` have no wasm
  builds; CausalImpact is indexed but uninstallable), TFP and PyMC ports can't run
  in Pyodide. Chose statsmodels route: vendored `pycausalimpact` 0.1.1.
- Patched the vendored engine for Pyodide 314.0.5's stack (numpy 2.4.6,
  pandas 3.0.2, statsmodels 0.14.6): pandas-3 positional indexing, removed
  `applymap`, dropped matplotlib `Plot` mixin, fixed fit-kwarg leakage, threaded a
  seeded `RandomState` through `simulate(random_state=)` for determinism.
  12 pytest cases in `py/tests/` on Pyodide-pinned venv.
- Built Svelte 5 + Vite app: CSV ingest (upload/paste/samples), column mapping,
  click-to-set intervention with pre-period shading, model config, Pyodide module
  worker (jsDelivr CDN), synced 3-panel uPlot results, summary table, prose
  report, CSV/PNG/report exports.
- Verified parity: browser and native produce identical numbers (same seed) on
  both sample datasets; recovered known effects (+8% → 8.5% [7.5, 9.5]).
- Deployed: https://mattpolicastro.github.io/causal-impact-wasm/ (manual
  `gh workflow run deploy-pages`).
- Gotcha: Chrome on the Mac Studio cannot reach loopback (extension/browser
  blocks it silently) — browser-test dev servers via LAN IP with `--host`.
