import json

import numpy as np
import pytest

import runner
from tests.test_smoke import make_data


def bayes_payload(data, effect_cols=('X',), t0=70, **overrides):
    payload = {
        'engine': 'bayes',
        'y': data['y'].tolist(),
        'covariates': {c: data[c].tolist() for c in effect_cols} if effect_cols else None,
        'pre_period': [0, t0 - 1],
        'post_period': [t0, len(data) - 1],
        'alpha': 0.05,
        'seed': 42,
        'niter': 800,
        'burn': 200,
    }
    payload.update(overrides)
    return payload


def run_payload(payload):
    result = json.loads(runner.run_json(json.dumps(payload)))
    assert result['ok'] is True, result.get('error')
    return result


def test_recovers_known_effect():
    data = make_data(effect=10.0)
    result = run_payload(bayes_payload(data))
    avg = result['summary']['average']
    assert avg['abs_effect'] == pytest.approx(10.0, abs=2.0)
    assert avg['abs_effect_lower'] < 10.0 < avg['abs_effect_upper']
    assert result['p_value'] < 0.05
    assert result['engine'] == 'bayes'


def test_no_effect_is_not_significant():
    data = make_data(effect=0.0)
    result = run_payload(bayes_payload(data))
    avg = result['summary']['average']
    assert avg['abs_effect_lower'] < 0.0 < avg['abs_effect_upper']
    assert result['p_value'] > 0.05


def test_deterministic_given_seed():
    data = make_data(effect=10.0)
    a = runner.run_json(json.dumps(bayes_payload(data)))
    b = runner.run_json(json.dumps(bayes_payload(data)))
    assert a == b


def test_no_covariates():
    data = make_data(effect=15.0)
    result = run_payload(bayes_payload(data, effect_cols=()))
    assert result['summary']['average']['abs_effect'] == pytest.approx(15.0, abs=6.0)


def test_spike_and_slab_prunes_junk_covariates():
    rng = np.random.default_rng(99)
    data = make_data(effect=10.0)
    for j in range(6):
        data[f'junk{j}'] = rng.normal(0, 1, len(data)).cumsum()
    cols = ('X',) + tuple(f'junk{j}' for j in range(6))
    result = run_payload(bayes_payload(data, effect_cols=cols))
    probs = result['inclusion_probs']
    assert probs['X'] > 0.9
    junk_mean = np.mean([probs[f'junk{j}'] for j in range(6)])
    assert junk_mean < 0.5
    # Effect estimate survives the junk.
    assert result['summary']['average']['abs_effect'] == pytest.approx(10.0, abs=2.5)


def test_series_schema_matches_mle():
    data = make_data(effect=10.0)
    result = run_payload(bayes_payload(data))
    mle = json.loads(runner.run_json(json.dumps({
        **bayes_payload(data), 'engine': 'mle', 'standardize': True,
        'prior_level_sd': 0.01, 'n_sims': 500,
    })))
    assert set(result['series'].keys()) == set(mle['series'].keys())
    n = len(data)
    assert all(len(v) == n for v in result['series'].values())
    assert result['series']['post_cum_effects'][69] == 0.0
    assert 'Posterior Inference' in result['summary_text']
    assert len(result['report']) > 200


def test_agrees_with_mle_on_easy_data():
    data = make_data(effect=10.0)
    bayes_r = run_payload(bayes_payload(data))
    mle_r = json.loads(runner.run_json(json.dumps({
        **bayes_payload(data), 'engine': 'mle', 'standardize': True,
        'prior_level_sd': 0.01, 'n_sims': 1000,
    })))
    diff = abs(bayes_r['summary']['average']['abs_effect'] -
               mle_r['summary']['average']['abs_effect'])
    assert diff < 1.5


def test_seasonal_rejected():
    data = make_data(effect=10.0)
    result = json.loads(runner.run_json(json.dumps(
        bayes_payload(data, nseasons=[{'period': 7}]))))
    assert result['ok'] is False
    assert 'seasonal' in result['error'].lower()


@pytest.mark.slow
def test_false_positive_rate_near_alpha():
    """Null calibration: with no true effect, 'significant at 95%' should fire
    at roughly the nominal 5% rate. Loose bounds — 40 sims is a smoke check."""
    hits = 0
    sims = 40
    for i in range(sims):
        data = make_data(effect=0.0, seed=1000 + i)
        result = run_payload(bayes_payload(data, seed=i, niter=600, burn=150))
        avg = result['summary']['average']
        if not (avg['abs_effect_lower'] < 0.0 < avg['abs_effect_upper']):
            hits += 1
    assert hits <= 6, f'{hits}/{sims} false positives'
