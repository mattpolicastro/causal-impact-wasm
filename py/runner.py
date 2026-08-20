"""JSON-in/JSON-out entrypoint for the web worker.

The JS side owns index semantics (dates, labels); everything here is positional.
Periods are inclusive integer positions into the data arrays.
"""

import json
import math

import numpy as np
import pandas as pd

import bayes
from causalimpact import CausalImpact
from causalimpact.misc import get_z_score
from causalimpact.summary import REPORT_TMPL, SUMMARY_TMPL

SERIES_COLUMNS = [
    'preds', 'preds_lower', 'preds_upper',
    'post_preds', 'post_preds_lower', 'post_preds_upper',
    'post_cum_y', 'post_cum_pred', 'post_cum_pred_lower', 'post_cum_pred_upper',
    'point_effects', 'point_effects_lower', 'point_effects_upper',
    'post_cum_effects', 'post_cum_effects_lower', 'post_cum_effects_upper',
]


def _clean(values):
    return [None if (v is None or (isinstance(v, float) and not math.isfinite(v))) else float(v)
            for v in values]


def _quantiles(draws_2d, alpha):
    lower = np.quantile(draws_2d, alpha / 2.0, axis=0)
    upper = np.quantile(draws_2d, 1.0 - alpha / 2.0, axis=0)
    return lower, upper


def run_bayes(payload):
    """Spike-and-slab Bayesian engine; same output contract as the MLE path."""
    y = np.asarray(payload['y'], dtype=float)
    covariates = payload.get('covariates') or {}
    n = len(y)
    X = None
    if covariates:
        X = np.column_stack([np.asarray(v, dtype=float) for v in covariates.values()])
        if X.shape[0] != n:
            raise ValueError('Covariate rows must match y.')
        if not np.isfinite(X).all():
            raise ValueError('Covariates cannot contain missing values.')
    if payload.get('nseasons'):
        raise ValueError('The Bayesian engine does not support seasonal components '
                         'yet; use the fast (MLE) engine for seasonal models.')

    p0, p1 = (int(v) for v in payload['pre_period'])
    q0, q1 = (int(v) for v in payload['post_period'])
    if p1 - p0 < 3:
        raise ValueError('pre_period must span at least 3 time points.')
    if q0 <= p1:
        raise ValueError('post_period must start after pre_period ends.')
    alpha = float(payload.get('alpha', 0.05))
    prior_level_sd = payload.get('prior_level_sd')
    prior_level_sd = 0.01 if prior_level_sd is None else float(prior_level_sd)
    niter = int(payload.get('niter', 1000))
    burn = int(payload.get('burn', max(100, niter // 5)))
    seed = payload.get('seed')
    seed = int(seed) if seed is not None else None
    progress = payload.get('_progress')

    y_pre, y_post = y[p0:p1 + 1], y[q0:q1 + 1]
    if not np.isfinite(y_pre).all() or not np.isfinite(y_post).all():
        raise ValueError('The Bayesian engine requires a response without '
                         'missing values in the pre and post periods.')
    mu_y, sd_y = y_pre.mean(), y_pre.std()
    if sd_y == 0:
        raise ValueError('Input response cannot be constant.')
    ys_pre = (y_pre - mu_y) / sd_y

    Xs_pre = Xs_post = None
    if X is not None:
        mu_x, sd_x = X[p0:p1 + 1].mean(axis=0), X[p0:p1 + 1].std(axis=0)
        sd_x[sd_x == 0] = 1.0
        Xs = (X - mu_x) / sd_x
        Xs_pre, Xs_post = Xs[p0:p1 + 1], Xs[q0:q1 + 1]

    draws = bayes.gibbs_fit(ys_pre, Xs_pre, niter, burn, prior_level_sd, seed,
                            progress=progress)
    pred_post = bayes.posterior_predict(draws, Xs_post, len(y_post), seed)
    pred_pre = bayes.fitted_pre(draws, Xs_pre, seed)

    # Back to the original scale.
    pred_post = pred_post * sd_y + mu_y
    pred_pre = pred_pre * sd_y + mu_y

    nan = np.full(n, np.nan)
    series = {name: nan.copy() for name in SERIES_COLUMNS}

    pre_idx = slice(p0, p1 + 1)
    post_idx = slice(q0, q1 + 1)

    pre_lower, pre_upper = _quantiles(pred_pre, alpha)
    post_lower, post_upper = _quantiles(pred_post, alpha)
    series['preds'][pre_idx] = pred_pre.mean(axis=0)
    series['preds'][post_idx] = pred_post.mean(axis=0)
    series['preds_lower'][pre_idx] = pre_lower
    series['preds_lower'][post_idx] = post_lower
    series['preds_upper'][pre_idx] = pre_upper
    series['preds_upper'][post_idx] = post_upper
    series['post_preds'][post_idx] = pred_post.mean(axis=0)
    series['post_preds_lower'][post_idx] = post_lower
    series['post_preds_upper'][post_idx] = post_upper

    observed = np.concatenate([y_pre, y_post])
    both_idx = np.r_[np.arange(p0, p1 + 1), np.arange(q0, q1 + 1)]
    series['point_effects'][both_idx] = observed - series['preds'][both_idx]
    series['point_effects_lower'][both_idx] = observed - series['preds_upper'][both_idx]
    series['point_effects_upper'][both_idx] = observed - series['preds_lower'][both_idx]

    # Cumulative series: a leading zero at the last pre-period point.
    cum_pred_draws = np.cumsum(pred_post, axis=1)
    cum_eff_draws = np.cumsum(y_post[None, :] - pred_post, axis=1)
    cum_lower, cum_upper = _quantiles(cum_pred_draws, alpha)
    ce_lower, ce_upper = _quantiles(cum_eff_draws, alpha)
    cum_idx = np.r_[p1, np.arange(q0, q1 + 1)]
    series['post_cum_y'][cum_idx] = np.r_[0.0, np.cumsum(y_post)]
    series['post_cum_pred'][cum_idx] = np.r_[0.0, cum_pred_draws.mean(axis=0)]
    series['post_cum_pred_lower'][cum_idx] = np.r_[0.0, cum_lower]
    series['post_cum_pred_upper'][cum_idx] = np.r_[0.0, cum_upper]
    series['post_cum_effects'][cum_idx] = np.r_[0.0, cum_eff_draws.mean(axis=0)]
    series['post_cum_effects_lower'][cum_idx] = np.r_[0.0, ce_lower]
    series['post_cum_effects_upper'][cum_idx] = np.r_[0.0, ce_upper]

    # Summary from posterior draws.
    n_post = len(y_post)
    sum_pred_draws = pred_post.sum(axis=1)
    sum_y = float(y_post.sum())
    mean_y = float(y_post.mean())
    avg_pred_draws = sum_pred_draws / n_post
    abs_avg_draws = mean_y - avg_pred_draws
    abs_sum_draws = sum_y - sum_pred_draws
    rel_draws = abs_sum_draws / sum_pred_draws

    def qpair(d):
        return float(np.quantile(d, alpha / 2.0)), float(np.quantile(d, 1.0 - alpha / 2.0))

    avg_pred_lo, avg_pred_hi = qpair(avg_pred_draws)
    sum_pred_lo, sum_pred_hi = qpair(sum_pred_draws)
    abs_avg_lo, abs_avg_hi = qpair(abs_avg_draws)
    abs_sum_lo, abs_sum_hi = qpair(abs_sum_draws)
    rel_lo, rel_hi = qpair(rel_draws)

    summary = {
        'average': {
            'actual': mean_y,
            'predicted': float(avg_pred_draws.mean()),
            'predicted_lower': avg_pred_lo,
            'predicted_upper': avg_pred_hi,
            'abs_effect': float(abs_avg_draws.mean()),
            'abs_effect_lower': abs_avg_lo,
            'abs_effect_upper': abs_avg_hi,
            'rel_effect': float(rel_draws.mean()),
            'rel_effect_lower': rel_lo,
            'rel_effect_upper': rel_hi,
        },
        'cumulative': {
            'actual': sum_y,
            'predicted': float(sum_pred_draws.mean()),
            'predicted_lower': sum_pred_lo,
            'predicted_upper': sum_pred_hi,
            'abs_effect': float(abs_sum_draws.mean()),
            'abs_effect_lower': abs_sum_lo,
            'abs_effect_upper': abs_sum_hi,
            'rel_effect': float(rel_draws.mean()),
            'rel_effect_lower': rel_lo,
            'rel_effect_upper': rel_hi,
        },
    }

    keep = sum_pred_draws.shape[0]
    tail = min(int((sum_pred_draws >= sum_y).sum()), int((sum_pred_draws <= sum_y).sum()))
    p_value = (tail + 1) / (keep + 1)

    tmpl_args = dict(summary=summary, alpha=alpha, p_value=p_value, digits=2)
    inclusion = (
        {name: float(p) for name, p in
         zip(covariates.keys(), draws['gamma'].mean(axis=0))}
        if covariates else {}
    )

    return {
        'ok': True,
        'series': {col: _clean(values.tolist()) for col, values in series.items()},
        'summary': summary,
        'p_value': float(p_value),
        'alpha': alpha,
        'summary_text': SUMMARY_TMPL.render(z_score=get_z_score(1 - alpha / 2.0), **tmpl_args),
        'report': REPORT_TMPL.render(**tmpl_args),
        'engine': 'bayes',
        'inclusion_probs': inclusion,
    }


def run(payload):
    if payload.get('engine') == 'bayes':
        return run_bayes(payload)
    y = payload['y']
    covariates = payload.get('covariates') or {}
    n = len(y)
    columns = {'y': y}
    for name, values in covariates.items():
        if len(values) != n:
            raise ValueError(f'Covariate {name!r} has {len(values)} rows, expected {n}.')
        columns[name] = values
    data = pd.DataFrame(columns, index=pd.RangeIndex(n), dtype=float)

    kwargs = {}
    if payload.get('nseasons'):
        kwargs['nseasons'] = [
            {k: int(v) for k, v in season.items()} for season in payload['nseasons']
        ]
    if 'standardize' in payload:
        kwargs['standardize'] = bool(payload['standardize'])
    if 'prior_level_sd' in payload:
        v = payload['prior_level_sd']
        kwargs['prior_level_sd'] = None if v is None else float(v)
    if payload.get('n_sims'):
        kwargs['n_sims'] = int(payload['n_sims'])

    seed = payload.get('seed')
    if seed is not None:
        kwargs['seed'] = int(seed)

    ci = CausalImpact(
        data,
        [int(p) for p in payload['pre_period']],
        [int(p) for p in payload['post_period']],
        alpha=float(payload.get('alpha', 0.05)),
        **kwargs,
    )

    inferences = ci.inferences.reindex(pd.RangeIndex(n))
    series = {col: _clean(inferences[col].tolist()) for col in SERIES_COLUMNS}

    summary = {
        scope: {k: float(v) for k, v in values.items()}
        for scope, values in ci.summary_data.to_dict().items()
    }

    return {
        'ok': True,
        'series': series,
        'summary': summary,
        'p_value': float(ci.p_value),
        'alpha': float(ci.alpha),
        'summary_text': ci.summary(),
        'report': ci.summary('report'),
        'engine': 'mle',
    }


def run_json(payload_json, progress=None):
    try:
        payload = json.loads(payload_json)
        if progress is not None:
            payload['_progress'] = progress
        result = run(payload)
    except Exception as e:  # surface any engine failure to the UI as a message
        result = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
    return json.dumps(result)
