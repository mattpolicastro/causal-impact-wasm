"""JSON-in/JSON-out entrypoint for the web worker.

The JS side owns index semantics (dates, labels); everything here is positional.
Periods are inclusive integer positions into the data arrays.
"""

import json
import math

import pandas as pd

from causalimpact import CausalImpact

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


def run(payload):
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
    }


def run_json(payload_json):
    try:
        result = run(json.loads(payload_json))
    except Exception as e:  # surface any engine failure to the UI as a message
        result = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
    return json.dumps(result)
