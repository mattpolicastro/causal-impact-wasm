"""Error-rate stress harness for both engines.

Simulates data with known ground truth across scenarios, runs the engine plus
the same guardrails the UI applies (placebo re-run, pre-period fit R2), and
reports false-positive rate, power, CI coverage, estimation error, and how
often the guardrails flag runs — including the FPR among runs the guardrails
would have let through ("protected FPR").

Usage (from py/, with the pinned venv):
    .venv/bin/python stress/harness.py --reps 100 --out stress
Writes stress/REPORT.md and stress/results.json.
"""

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import runner  # noqa: E402


@dataclass
class Scenario:
    name: str
    n_pre: int = 100
    n_post: int = 30
    effect: float = 0.0          # relative lift applied to post-period y
    n_real_cov: int = 2          # covariates that actually drive y
    n_junk_cov: int = 0          # random walks unrelated to y
    seasonal_misspec: bool = False  # weekly cycle in y not carried by covariates
    description: str = ''


SCENARIOS = [
    Scenario('null-easy', description='No effect, healthy setup: FPR should be ~alpha.'),
    Scenario('null-short-pre', n_pre=30,
             description='No effect, short pre-period: classic over-confidence regime.'),
    Scenario('null-junk-covariates', n_real_cov=1, n_junk_cov=8,
             description='No effect, 1 real + 8 junk controls: overfitting regime.'),
    Scenario('null-no-covariates', n_real_cov=0,
             description='No effect, trend-only counterfactual.'),
    Scenario('null-seasonal-misspec', seasonal_misspec=True,
             description='No effect, weekly cycle the model cannot express: '
                         'fit check should flag these.'),
    Scenario('effect-5pct', effect=0.05,
             description='True +5% effect: power and coverage.'),
    Scenario('effect-10pct', effect=0.10,
             description='True +10% effect: power and coverage.'),
    Scenario('effect-10pct-short-pre', effect=0.10, n_pre=30,
             description='True +10% effect with a short pre-period.'),
]

ALPHA = 0.05


def simulate(sc: Scenario, seed: int):
    rng = np.random.default_rng(seed)
    n = sc.n_pre + sc.n_post
    covariates = {}
    signal = np.zeros(n)
    for j in range(sc.n_real_cov):
        x = 100 + np.cumsum(rng.normal(0, 1, n)) * 0.6 + rng.normal(0, 1, n)
        covariates[f'x{j}'] = x
        signal = signal + (0.8 / max(sc.n_real_cov, 1)) * x
    for j in range(sc.n_junk_cov):
        covariates[f'junk{j}'] = 100 + np.cumsum(rng.normal(0, 1, n)) * 0.6
    if sc.n_real_cov == 0:
        signal = 100 + np.cumsum(rng.normal(0, 0.3, n))  # latent trend
    y = signal + rng.normal(0, 1.5, n)
    if sc.seasonal_misspec:
        y = y + 4.0 * np.sin(2 * np.pi * np.arange(n) / 7)
    y[sc.n_pre:] *= 1.0 + sc.effect
    return y, covariates


def payload_for(sc, y, covariates, engine, pre, post, seed):
    return {
        'engine': engine,
        'y': y.tolist(),
        'covariates': {k: v.tolist() for k, v in covariates.items()} or None,
        'pre_period': list(pre),
        'post_period': list(post),
        'alpha': ALPHA,
        'seed': seed,
        'standardize': True,
        'prior_level_sd': 0.01,
        'n_sims': 500,   # mle
        'niter': 800,    # bayes
        'burn': 200,
    }


def pre_fit_r2(result, y, pre):
    """Mirror of the UI's pre-period fit check (skips the first pre point)."""
    preds = result['series']['preds'][pre[0] + 1:pre[1] + 1]
    ys = y[pre[0] + 1:pre[1] + 1]
    pairs = [(a, b) for a, b in zip(ys, preds) if b is not None]
    if len(pairs) < 5:
        return None
    ys = np.array([a for a, _ in pairs])
    preds = np.array([b for _, b in pairs])
    ss_tot = ((ys - ys.mean()) ** 2).sum()
    if ss_tot == 0:
        return 0.0
    return 1.0 - ((ys - preds) ** 2).sum() / ss_tot


def significant(result):
    avg = result['summary']['average']
    return np.sign(avg['rel_effect_lower']) == np.sign(avg['rel_effect_upper'])


def run_one(args):
    sc, engine, rep = args
    seed = 20_000 + rep
    y, covariates = simulate(sc, seed)
    pre = (0, sc.n_pre - 1)
    post = (sc.n_pre, sc.n_pre + sc.n_post - 1)
    main = json.loads(runner.run_json(json.dumps(
        payload_for(sc, y, covariates, engine, pre, post, seed))))
    if not main['ok']:
        return {'scenario': sc.name, 'engine': engine, 'rep': rep, 'error': main['error']}

    avg = main['summary']['average']
    # Guardrails, as the UI applies them (placebo window mirrors the real
    # post-period length, capped at a third of the pre-period).
    r2 = pre_fit_r2(main, y, pre)
    window = max(5, min(sc.n_post, sc.n_pre // 3))
    fake_t0 = sc.n_pre - window
    placebo = json.loads(runner.run_json(json.dumps(
        payload_for(sc, y, covariates, engine, (pre[0], fake_t0 - 1),
                    (fake_t0, sc.n_pre - 1), seed))))
    placebo_failed = placebo['ok'] and significant(placebo)
    guard_flagged = bool(placebo_failed or (r2 is not None and r2 < 0.3)
                         or sc.n_pre < 30)

    return {
        'scenario': sc.name,
        'engine': engine,
        'rep': rep,
        'true_effect': sc.effect,
        'estimate': avg['rel_effect'],
        'ci': [avg['rel_effect_lower'], avg['rel_effect_upper']],
        'significant': bool(significant(main)),
        'covered': bool(avg['rel_effect_lower'] <= sc.effect <= avg['rel_effect_upper']),
        'p_value': main['p_value'],
        'r2': r2,
        'placebo_failed': bool(placebo_failed),
        'guard_flagged': guard_flagged,
    }


def summarize(rows):
    out = []
    keys = sorted({(r['scenario'], r['engine']) for r in rows if 'error' not in r})
    for scenario, engine in keys:
        rs = [r for r in rows if r.get('scenario') == scenario
              and r.get('engine') == engine and 'error' not in r]
        n = len(rs)
        sig = [r for r in rs if r['significant']]
        clean = [r for r in rs if not r['guard_flagged']]
        sc = next(s for s in SCENARIOS if s.name == scenario)
        is_null = sc.effect == 0.0
        out.append({
            'scenario': scenario,
            'engine': engine,
            'n': n,
            'sig_rate': len(sig) / n,
            'metric': 'FPR' if is_null else 'power',
            'coverage': sum(r['covered'] for r in rs) / n,
            'mae': float(np.mean([abs(r['estimate'] - r['true_effect']) for r in rs])),
            'flag_rate': sum(r['guard_flagged'] for r in rs) / n,
            'protected_sig_rate':
                (sum(r['significant'] for r in clean) / len(clean)) if clean else None,
            'n_clean': len(clean),
        })
    return out


def render_report(summary, reps):
    lines = [
        '# Stress-test report',
        '',
        f'{reps} replicates per scenario/engine · alpha = {ALPHA} · '
        'guardrails mirrored from the UI (placebo re-run, pre-fit R² < 0.3, pre-period < 30).',
        '',
        '| Scenario | Engine | sig. rate | metric | coverage | MAE | guard flag rate | sig. rate when guards pass |',
        '|---|---|---|---|---|---|---|---|',
    ]
    for s in summary:
        prot = ('—' if s['protected_sig_rate'] is None
                else f"{s['protected_sig_rate']:.2f} (n={s['n_clean']})")
        lines.append(
            f"| {s['scenario']} | {s['engine']} | {s['sig_rate']:.2f} | {s['metric']} "
            f"| {s['coverage']:.2f} | {s['mae']:.3f} | {s['flag_rate']:.2f} | {prot} |")
    lines += ['', '## Scenario definitions', '']
    for sc in SCENARIOS:
        lines.append(f"- **{sc.name}** — {sc.description} "
                     f"(pre={sc.n_pre}, post={sc.n_post}, effect={sc.effect}, "
                     f"real cov={sc.n_real_cov}, junk cov={sc.n_junk_cov}"
                     f"{', seasonal misspec' if sc.seasonal_misspec else ''})")
    lines += [
        '',
        'Reading guide: null scenarios want sig. rate ≈ alpha and coverage ≈ 0.95; '
        'effect scenarios want high sig. rate (power) with coverage ≈ 0.95. '
        '"Sig. rate when guards pass" shows the error rate an analyst sees after '
        'the sanity-check panel has filtered the untrustworthy runs.',
    ]
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reps', type=int, default=100)
    ap.add_argument('--engines', nargs='+', default=['bayes', 'mle'])
    ap.add_argument('--scenarios', nargs='+', default=None)
    ap.add_argument('--out', default='stress')
    ap.add_argument('--workers', type=int, default=None)
    args = ap.parse_args()

    scenarios = [s for s in SCENARIOS
                 if args.scenarios is None or s.name in args.scenarios]
    tasks = [(sc, engine, rep)
             for sc in scenarios for engine in args.engines
             for rep in range(args.reps)]
    print(f'{len(tasks)} runs ({len(tasks) * 2} fits incl. placebo)…')
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(run_one, tasks, chunksize=4))

    errors = [r for r in rows if 'error' in r]
    if errors:
        print(f'{len(errors)} runs errored; first: {errors[0]["error"]}')
    summary = summarize(rows)

    out = Path(__file__).resolve().parent
    (out / 'results.json').write_text(json.dumps(
        {'reps': args.reps, 'summary': summary, 'errors': errors,
         'scenarios': [asdict(s) for s in scenarios]}, indent=1))
    (out / 'REPORT.md').write_text(render_report(summary, args.reps))
    print(f'Wrote {out}/REPORT.md')
    for s in summary:
        print(f"{s['scenario']:28s} {s['engine']:5s} "
              f"{s['metric']}={s['sig_rate']:.2f} cov={s['coverage']:.2f} "
              f"flag={s['flag_rate']:.2f}")


if __name__ == '__main__':
    main()
