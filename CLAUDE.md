# causal-impact-wasm

Browser-hosted CausalImpact: Svelte 5 + Vite app running two Python engines on
Pyodide in a web worker — `py/bayes.py` (default: numpy Gibbs sampler, local
level + spike-and-slab regression) and `py/causalimpact/` (vendored, patched
`pycausalimpact` MLE). See README.md for architecture.

Audience note: this is deployed to inexperienced analysts. The sanity-check
panel (`src/lib/diagnostics.ts`: pre-period fit, automatic placebo run, regime
warnings) is a load-bearing safety feature, not decoration — don't weaken its
wording or thresholds without deliberate review.

## Invariants

- **Python pins mirror Pyodide.** `py/.venv` and the pins in README must match
  the package versions in `pyodide-lock.json` for the `PYODIDE_VERSION` set in
  `src/lib/worker/pyodide.worker.ts`. Bumping Pyodide means re-pinning the venv
  and re-running `py` tests before anything else.
- **`py/runner.py` is the only Python↔JS contract.** Positional integer periods,
  JSON both ways; JS owns index/date semantics. Don't leak pandas objects across.
- **The worker imports `py/**` via Vite `?raw`** — Python source ships inside the
  worker bundle and is written to the Pyodide FS at init. New Python files must be
  added to the `FILES` map in the worker.
- **Vendored engine changes need a test.** `py/tests/` runs natively
  (`py/.venv/bin/python -m pytest tests/` from `py/`) and is the parity oracle
  for what the browser computes — same seed produces identical numbers in both.

## Testing

- Engine: `cd py && .venv/bin/python -m pytest tests/` (`-m slow` adds the
  null-calibration sweep; `test_r_parity.py` runs only if
  `tests/fixtures/r_reference.json` exists — regenerate it with
  `Rscript tests/fixtures/generate_r_reference.R` after engine changes)
- Error rates: `py/.venv/bin/python py/stress/harness.py --reps 100` → rewrites
  `py/stress/REPORT.md`; run after any change to either engine's inference
- App: `npm run check` (svelte-check), `npm run build`
- Browser e2e is manual; Chrome on this machine cannot reach loopback — use the
  LAN IP (`ipconfig getifaddr en0`) with `npm run dev -- --host`.

## Deploy

GitHub Pages, manual only (Actions-minutes budget): `gh workflow run deploy-pages`.
`GITHUB_PAGES=1` sets the Vite base path.
