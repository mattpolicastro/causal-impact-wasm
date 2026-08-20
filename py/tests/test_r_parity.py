"""Parity against the real R CausalImpact package on shared fixture datasets.

Reference outputs come from tests/fixtures/generate_r_reference.R. The engines
are independent implementations (different samplers, different RNGs), so parity
is judged at the level that matters for conclusions:
  - same significance verdict,
  - point estimates close relative to R's own interval width,
  - overlapping credible intervals.
"""

import json
from pathlib import Path

import pandas as pd
import pytest

import runner

FIXTURES = Path(__file__).parent / 'fixtures'
REFERENCE = FIXTURES / 'r_reference.json'

DATASETS = {
    'arma_data': ('arma_data.csv', 'y', ['X']),
    'google_data': ('google_data.csv', 'y', ['x1', 'x2']),
    'comparison_data': ('comparison_data.csv', 'CHANGED',
                        ['NOT_CHANGED_1', 'NOT_CHANGED_2', 'NOT_CHANGED_3']),
    'volks_data': ('volks_data.csv', 'volkswagen', ['bmw', 'allianz']),
}

pytestmark = pytest.mark.skipif(
    not REFERENCE.exists(),
    reason='r_reference.json not generated (run generate_r_reference.R)',
)


def load_cases():
    if not REFERENCE.exists():
        return []
    return json.loads(REFERENCE.read_text())['cases']


def run_engine(case, engine):
    filename, ycol, xcols = DATASETS[case['name']]
    df = pd.read_csv(FIXTURES / filename)
    payload = {
        'engine': engine,
        'y': df[ycol].tolist(),
        'covariates': {c: df[c].tolist() for c in xcols},
        'pre_period': case['pre_period'],
        'post_period': case['post_period'],
        'alpha': 0.05,
        'seed': 1,
        'standardize': True,
        'prior_level_sd': 0.01,
        'n_sims': 1000,
        'niter': 1000,
        'burn': 200,
    }
    result = json.loads(runner.run_json(json.dumps(payload)))
    assert result['ok'], result.get('error')
    return result


def significant(scope):
    return (scope['rel_effect_lower'] > 0) == (scope['rel_effect_upper'] > 0)


@pytest.mark.parametrize('engine', ['bayes', 'mle'])
@pytest.mark.parametrize('case', load_cases(), ids=lambda c: c['name'])
def test_parity_with_r(case, engine):
    ours = run_engine(case, engine)['summary']['average']
    r = case['average']

    r_width = r['rel_effect_upper'] - r['rel_effect_lower']
    # Same qualitative verdict.
    assert significant(ours) == significant(r), (
        f"verdict mismatch: ours {ours['rel_effect_lower']:.4f}..{ours['rel_effect_upper']:.4f} "
        f"vs R {r['rel_effect_lower']:.4f}..{r['rel_effect_upper']:.4f}")
    # Point estimate within one R-interval-width of R's estimate.
    assert abs(ours['rel_effect'] - r['rel_effect']) < max(r_width, 0.01), (
        f"rel_effect {ours['rel_effect']:.4f} vs R {r['rel_effect']:.4f}")
    # Intervals overlap.
    assert ours['rel_effect_lower'] < r['rel_effect_upper']
    assert r['rel_effect_lower'] < ours['rel_effect_upper']
