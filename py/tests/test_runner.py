import json

import numpy as np
import pytest

import runner
from tests.test_smoke import make_data


def make_payload(**overrides):
    data = make_data(effect=10.0)
    payload = {
        'y': data['y'].tolist(),
        'covariates': {'X': data['X'].tolist()},
        'pre_period': [0, 69],
        'post_period': [70, 99],
        'alpha': 0.05,
        'seed': 42,
    }
    payload.update(overrides)
    return payload


def test_run_json_roundtrip():
    result = json.loads(runner.run_json(json.dumps(make_payload())))
    assert result['ok'] is True
    assert result['summary']['average']['abs_effect'] == pytest.approx(10.0, abs=2.0)
    assert result['p_value'] < 0.05
    assert 'Posterior Inference' in result['summary_text']
    n = 100
    for name, values in result['series'].items():
        assert len(values) == n, name
    # Predictions cover every point; cumulative series exist only around post period.
    assert all(v is not None for v in result['series']['preds'])
    assert result['series']['post_cum_effects'][0] is None
    assert result['series']['post_cum_effects'][69] == 0.0
    assert result['series']['post_cum_effects'][99] == pytest.approx(300.0, rel=0.35)


def test_run_json_seed_reproducible():
    a = runner.run_json(json.dumps(make_payload()))
    b = runner.run_json(json.dumps(make_payload()))
    assert a == b


def test_run_json_error_is_reported():
    result = json.loads(runner.run_json(json.dumps(make_payload(pre_period=[0, 1]))))
    assert result['ok'] is False
    assert 'pre_period' in result['error']


def test_run_json_no_covariates():
    payload = make_payload(covariates=None)
    result = json.loads(runner.run_json(json.dumps(payload)))
    assert result['ok'] is True


def test_run_json_covariate_length_mismatch():
    payload = make_payload(covariates={'X': [1.0, 2.0]})
    result = json.loads(runner.run_json(json.dumps(payload)))
    assert result['ok'] is False
    assert 'rows' in result['error']
