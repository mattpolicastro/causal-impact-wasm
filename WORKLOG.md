# WORKLOG

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
