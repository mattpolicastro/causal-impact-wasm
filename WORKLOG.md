# WORKLOG

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
