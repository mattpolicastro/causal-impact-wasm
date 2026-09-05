"""A zero-variance covariate must not crash any engine.

Reported by @BrokLori while running the planner against real client data: a
padded export or a region that is flat over the window took down both engines
with messages that told an analyst nothing.

    bayes: LinAlgError: Matrix is not positive definite
    mle:   MissingDataError: exog contains inf or nans

Dropping such a column is lossless, so the bar here is not "does not crash" but
"identical to never having passed it".
"""

import numpy as np
import pytest

import runner


def _history(n=120, seed=0):
    rng = np.random.default_rng(seed)
    level = 100.0 + np.cumsum(rng.standard_normal(n))
    return level + rng.standard_normal(n), level + rng.standard_normal(n) * 0.5


def _payload(covariates, **kw):
    y, _ = _history()
    return dict(y=y.tolist(), pre_period=[0, 89], post_period=[90, 119],
                seed=1, covariates=covariates, **kw)


def _flat(n=120):
    return [7.0] * n


def _flat_in_pre_only(n=120, t0=90, seed=1):
    rng = np.random.default_rng(seed)
    return np.concatenate([np.full(t0, 7.0),
                           7.0 + rng.standard_normal(n - t0)]).tolist()


@pytest.mark.parametrize('engine', ['bayes', 'mle'])
@pytest.mark.parametrize('name,column', [
    ('flat', _flat()),
    ('flat_pre', _flat_in_pre_only()),
])
def test_constant_covariate_is_dropped_not_fatal(engine, name, column):
    _, control = _history()
    got = runner.run(_payload({'ctl': control.tolist(), name: column}, engine=engine))
    ref = runner.run(_payload({'ctl': control.tolist()}, engine=engine))

    assert got['dropped_covariates'] == [name]
    assert got['summary'] == ref['summary'], 'dropping must not move the estimate'
    assert got['series'] == ref['series']


@pytest.mark.parametrize('engine', ['bayes', 'mle'])
def test_all_covariates_constant_falls_back_to_none(engine):
    got = runner.run(_payload({'flat': _flat()}, engine=engine))
    ref = runner.run(_payload({}, engine=engine))
    assert got['dropped_covariates'] == ['flat']
    assert got['summary'] == ref['summary']


@pytest.mark.parametrize('engine', ['bayes', 'mle'])
def test_good_covariates_are_untouched(engine):
    _, control = _history()
    got = runner.run(_payload({'ctl': control.tolist()}, engine=engine))
    assert got['dropped_covariates'] == []


def test_near_constant_covariate_is_kept():
    """Only exact zero variance is a problem; both engines handle 1e-12 relative
    jitter. A tolerance here would silently discard legitimate steady controls."""
    rng = np.random.default_rng(0)
    _, control = _history()
    near = (1e6 + rng.standard_normal(120) * 1e6 * 1e-12).tolist()
    got = runner.run(_payload({'ctl': control.tolist(), 'near': near}, engine='bayes'))
    assert got['dropped_covariates'] == []


def test_power_task_drops_constant_covariates():
    """The planner fits the same sampler, so it failed the same way."""
    rng = np.random.default_rng(0)
    n = 180
    level = 1000 + np.cumsum(rng.standard_normal(n) * 4)
    y = level * (1 + rng.standard_normal(n) * 0.05)
    control = level * (1 + rng.standard_normal(n) * 0.02)
    base = dict(task='power', y=y.tolist(), durations=[7, 14, 28],
                effects=[0.02, 0.05], positions=list(range(n)), n_sims=400,
                niter=300, seed=1)

    got = runner.run(dict(base, covariates={'ctl': control.tolist(),
                                            'flat': [7.0] * n}))
    ref = runner.run(dict(base, covariates={'ctl': control.tolist()}))

    assert got['dropped_covariates'] == ['flat']
    assert got['covariate_names'] == ['ctl'], 'a dropped column must not be reported as used'
    assert got['mde'] == ref['mde']
