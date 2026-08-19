import numpy as np
import pandas as pd
import pytest

from causalimpact import CausalImpact


def make_data(effect=10.0, n=100, t0=70, seed=12345):
    rng = np.random.default_rng(seed)
    x = 100 + np.cumsum(rng.normal(0, 1, n)) * 0.5 + rng.normal(0, 1, n)
    y = 1.2 * x + rng.normal(0, 1, n)
    y[t0:] += effect
    return pd.DataFrame({'y': y, 'X': x})


def test_end_to_end_recovers_known_effect():
    data = make_data(effect=10.0)
    ci = CausalImpact(data, [0, 69], [70, 99])
    summary = ci.summary_data
    abs_effect = summary.loc['abs_effect', 'average']
    assert abs_effect == pytest.approx(10.0, abs=2.0)
    assert summary.loc['abs_effect_lower', 'average'] < abs_effect
    assert summary.loc['abs_effect_upper', 'average'] > abs_effect
    assert ci.p_value < 0.05


def test_no_effect_not_significant():
    data = make_data(effect=0.0)
    ci = CausalImpact(data, [0, 69], [70, 99])
    assert abs(ci.summary_data.loc['abs_effect', 'average']) < 2.0
    assert ci.p_value > 0.05


def test_datetime_index():
    data = make_data(effect=10.0)
    data.index = pd.date_range('2024-01-01', periods=len(data), freq='D')
    ci = CausalImpact(data, ['2024-01-01', '2024-03-10'], ['2024-03-11', '2024-04-09'])
    assert ci.summary_data.loc['abs_effect', 'average'] == pytest.approx(10.0, abs=2.0)
    assert len(ci.inferences) >= len(data)


def test_no_covariates():
    data = make_data(effect=15.0)[['y']]
    ci = CausalImpact(data, [0, 69], [70, 99])
    assert ci.summary_data.loc['abs_effect', 'average'] == pytest.approx(15.0, abs=6.0)


def test_seasonal_component():
    data = make_data(effect=10.0)
    t = np.arange(len(data))
    data['y'] = data['y'] + 3 * np.sin(2 * np.pi * t / 7)
    ci = CausalImpact(data, [0, 69], [70, 99], nseasons=[{'period': 7}])
    assert ci.summary_data.loc['abs_effect', 'average'] == pytest.approx(10.0, abs=3.0)


def test_summary_and_report_render():
    data = make_data(effect=10.0)
    ci = CausalImpact(data, [0, 69], [70, 99])
    s = ci.summary()
    r = ci.summary('report')
    assert 'Posterior Inference' in s
    assert 'Actual' in s
    assert len(r) > 200


def test_inferences_columns_complete():
    data = make_data(effect=10.0)
    ci = CausalImpact(data, [0, 69], [70, 99])
    expected = {
        'preds', 'preds_lower', 'preds_upper',
        'post_preds', 'post_preds_lower', 'post_preds_upper',
        'post_cum_y', 'post_cum_pred', 'post_cum_pred_lower', 'post_cum_pred_upper',
        'point_effects', 'point_effects_lower', 'point_effects_upper',
        'post_cum_effects', 'post_cum_effects_lower', 'post_cum_effects_upper',
    }
    assert expected == set(ci.inferences.columns)
