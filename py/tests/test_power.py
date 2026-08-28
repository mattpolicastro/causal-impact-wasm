import numpy as np
import pytest

import power


def _history(n=240, seed=0):
    """Daily-ish series with a drifting level, a control, and weekly seasonality."""
    rng = np.random.default_rng(seed)
    level = 100.0 + np.cumsum(rng.normal(0, 0.3, n))
    control = level + rng.normal(0, 1.5, n)
    dow = 4.0 * np.sin(2 * np.pi * np.arange(n) / 7)
    y = level + dow + rng.normal(0, 2.0, n)
    return y, control[:, None]


def _run(y, X, **kw):
    kw.setdefault('durations', [7, 14, 28, 56])
    kw.setdefault('effects', [0.0, 0.02, 0.05, 0.10])
    kw.setdefault('n_sims', 1500)
    kw.setdefault('niter', 400)
    kw.setdefault('burn', 100)
    kw.setdefault('seed', 7)
    return power.simulate_power(y, X, **kw)


def test_power_rises_with_effect_size():
    res = _run(*_history())
    for row in res['power']:
        assert row == sorted(row), 'power must be monotone in true effect size'
        assert row[-1] > row[0], 'a 10% lift must beat a 0% lift'


def test_false_positive_rate_respects_alpha():
    """At a true effect of zero, every detection is a false one. A one-sided
    threshold at alpha/2 should hold them at or below that rate."""
    res = _run(*_history(), alpha=0.05)
    for d, fp in zip(res['durations'], res['false_positive']):
        assert fp <= 0.05, f'{d}-day false positive rate {fp:.3f} exceeds alpha'


def test_mde_agrees_with_the_power_grid():
    """MDE is defined as the effect reaching power_target, so the grid and the
    MDE are two views of one distribution and must not disagree."""
    res = _run(*_history(), power_target=0.8)
    for row, m in zip(res['power'], res['mde']):
        for e, p in zip(res['effects'], row):
            if e < m:
                assert p <= 0.8 + 0.01, 'effects below the MDE cannot hit target power'
            else:
                assert p >= 0.8 - 0.01, 'effects at or above the MDE must hit it'


def test_a_longer_test_beats_a_very_short_one():
    """Note this is deliberately NOT a monotonicity check. Under a local level,
    the counterfactual's summed variance grows faster than the effect
    accumulates, so MDE eventually turns back upward — a longer test can be
    genuinely worse. Only the early part of the curve is reliably improving."""
    res = _run(*_history(), durations=[7, 28], effects=[0.05])
    assert res['mde'][1] < res['mde'][0]


def test_non_inferiority_threshold_is_easier_to_clear():
    """At the same true effect, clearing 'no worse than -2%' is a weaker claim
    than clearing zero, so it must be reached at least as often."""
    y, X = _history()
    lift = _run(y, X)
    noharm = _run(y, X, harm_threshold=-0.02)
    assert noharm['mode'] == 'non_inferiority'
    for a, b in zip(lift['power'], noharm['power']):
        assert all(x <= yy + 1e-12 for x, yy in zip(a, b))
    # Shifting the bar down by the threshold shifts the MDE by about as much.
    for lo, hi in zip(noharm['mde'], lift['mde']):
        assert lo < hi
        assert abs((hi - lo) - 0.02) < 0.01


def test_seed_makes_it_reproducible():
    y, X = _history()
    assert _run(y, X)['power'] == _run(y, X)['power']
    assert _run(y, X, seed=99)['power'] != _run(y, X, seed=7)['power']


def test_works_without_covariates():
    y, _ = _history()
    res = power.simulate_power(y, None, durations=[14, 28], effects=[0.0, 0.10],
                               n_sims=500, niter=300, burn=100, seed=3)
    assert res['power'][0][-1] > res['power'][0][0]


def test_recommends_a_duration_that_was_offered():
    res = _run(*_history())
    assert res['recommended_duration'] in res['durations']


def test_rejects_history_too_short_to_plan_from():
    y, X = _history(n=40)
    with pytest.raises(ValueError, match='at least'):
        power.simulate_power(y, X, durations=[28], effects=[0.05], seed=1)


def test_rejects_gaps_in_history():
    y, X = _history()
    y[10] = np.nan
    with pytest.raises(ValueError, match='without gaps'):
        power.simulate_power(y, X, durations=[14], effects=[0.05], seed=1)


def test_block_bootstrap_preserves_weekly_structure():
    """Day-by-day resampling would flatten the weekly cycle; blocks keep it.
    This is what stands in for the seasonal component the engine lacks."""
    rng = np.random.default_rng(0)
    resid = 5.0 * np.sin(2 * np.pi * np.arange(140) / 7)
    lag7 = lambda a: np.mean([np.corrcoef(r[:-7], r[7:])[0, 1] for r in a])
    assert lag7(power._block_bootstrap(resid, 70, 400, 7, rng)) > 0.99
    assert lag7(power._block_bootstrap(resid, 70, 400, 1, rng)) < 0.3

    # A non-zero phase must shift the cycle, not break it.
    shifted = power._block_bootstrap(resid, 70, 400, 7, rng, phase=3)
    assert lag7(shifted) > 0.99
    assert np.allclose(shifted[:, 0], resid[3], atol=1e-9)
