# causal-impact-wasm

[Google's CausalImpact](https://google.github.io/CausalImpact/) methodology —
counterfactual time-series inference for "what would y have been without the
intervention?" — running entirely in the browser. Upload a CSV, pick the
intervention point, get the classic three-panel plot, summary table, and prose
report. No server, no data upload: the model fits in a web worker via
[Pyodide](https://pyodide.org).

## How it works

- **Engine**: a vendored, patched copy of
  [dafiti/causalimpact](https://github.com/dafiti/causalimpact) (`pycausalimpact`
  0.1.1, Apache 2.0) in `py/causalimpact/`, updated for numpy 2.4 / pandas 3.0 /
  statsmodels 0.14 — the exact versions Pyodide 314.0.5 ships. It fits a
  structural time-series model (local level + covariate regression, optional
  seasonality) with `statsmodels.UnobservedComponents` and derives pointwise and
  cumulative effects, credible intervals, and a tail-area p-value from simulated
  forecasts.
- **Bridge**: `py/runner.py` is a JSON-in/JSON-out entrypoint; periods are
  integer positions (the JS side owns date semantics). Runs are deterministic
  given a seed.
- **App**: Svelte 5 + Vite + TypeScript; uPlot charts with synced cursors;
  Pyodide loaded from the jsDelivr CDN inside a module worker (~20 MB one-time,
  cached by the browser).

### Fidelity vs the R package

The R original samples a Bayesian spike-and-slab model by MCMC (`bsts`). This
port — like `pycausalimpact` — fits by maximum likelihood via Kalman filtering.
Point estimates and intervals are close in practice but not identical. (Running
the R package itself in the browser is currently impossible: `bsts` has no
WebAssembly build in the webR repository.)

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

## License

Apache 2.0. Vendored `causalimpact` package © Google Inc. / Dafiti, Apache 2.0.
