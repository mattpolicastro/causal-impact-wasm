# causal-impact-wasm

[Google's CausalImpact](https://google.github.io/CausalImpact/) methodology —
counterfactual time-series inference for "what would y have been without the
intervention?" — running entirely in the browser. Upload a CSV, pick the
intervention point, get the classic three-panel plot, summary table, and prose
report. No server, no data upload: the model fits in a web worker via
[Pyodide](https://pyodide.org).

## How it works

- **Default engine — Bayesian** (`py/bayes.py`): a pure-numpy Gibbs sampler in
  the spirit of R's `bsts` as used by CausalImpact — local level via
  forward-filter backward-sampling, spike-and-slab (SSVS) variable selection
  over the control series, conjugate variance updates. Intervals include
  parameter uncertainty; unhelpful covariates are pruned automatically, and
  their posterior inclusion probabilities are reported in the UI.
- **Fast engine — MLE** (`py/causalimpact/`): a vendored, patched copy of
  [dafiti/causalimpact](https://github.com/dafiti/causalimpact) (`pycausalimpact`
  0.1.1, Apache 2.0), updated for numpy 2.4 / pandas 3.0 / statsmodels 0.14 —
  the exact versions Pyodide 314.0.5 ships. Kalman-filter maximum likelihood via
  `statsmodels.UnobservedComponents`; supports seasonal components; intervals
  ignore parameter uncertainty.
- **Guardrails**: every run is followed by automated sanity checks rendered in
  plain language — pre-period fit (R²), an automatic **placebo test** (re-run
  with a fake intervention inside the pre-period; a "significant" placebo fails
  the result), pre-period length, covariate-count, and marginal-significance
  warnings, plus a standing note on the assumptions no statistic can check.
- **Bridge**: `py/runner.py` is a JSON-in/JSON-out entrypoint; periods are
  integer positions (the JS side owns date semantics). Runs are deterministic
  given a seed, in both engines.
- **App**: Svelte 5 + Vite + TypeScript; uPlot charts with synced cursors;
  Pyodide loaded from the jsDelivr CDN inside a module worker (~20 MB one-time,
  cached by the browser).

### Fidelity vs the R package

The Bayesian engine follows the same model family and sampling scheme as
`bsts`/CausalImpact but is an independent implementation with its own default
priors (documented in `py/bayes.py`); it is validated by recovery and
null-calibration tests rather than draw-for-draw parity with R. (Running the R
package itself in the browser is impossible: `bsts` has no WebAssembly build in
the webR repository.) The MLE engine matches `pycausalimpact` behavior.

## Development

```sh
npm install && npm run dev        # app
cd py && uv venv --python 3.14 .venv \
  && VIRTUAL_ENV=.venv uv pip install \
     numpy==2.4.6 scipy==1.18.0 pandas==3.0.2 statsmodels==0.14.6 jinja2==3.1.6 pytest
.venv/bin/python -m pytest tests/  # engine tests, natively, on Pyodide-pinned versions
```

The Python pins mirror `pyodide-lock.json` for the Pyodide version in
`src/lib/worker/pyodide.worker.ts` — keep them in lockstep when bumping Pyodide.

Deploys are manual: `gh workflow run deploy-pages`.

### Validation

- `py/tests/` — unit + recovery tests for both engines (run on every change).
- `py/stress/harness.py` — error-rate stress harness: simulation grids with
  known ground truth measuring false-positive rate, power, CI coverage, and how
  often the UI's guardrails catch the bad regimes. Results in
  `py/stress/REPORT.md`.
- `py/tests/fixtures/` — known datasets from the CausalImpact ecosystem
  (classic ARMA, Dafiti's comparison data, VW dieselgate, google example;
  sourced from [tfcausalimpact](https://github.com/WillianFuks/tfcausalimpact)'s
  test fixtures, Apache 2.0) plus `generate_r_reference.R`, which runs the real
  R package on them. `test_r_parity.py` checks both engines against R's
  verdicts and intervals; the committed `r_reference.json` was generated with
  R CausalImpact 1.4.1 / bsts 0.9.11. Both engines pass on all four datasets —
  including the VW dieselgate case, where all three implementations land on
  ≈ −25% with overlapping intervals.

## License

Apache 2.0. Vendored `causalimpact` package © Google Inc. / Dafiti, Apache 2.0.
