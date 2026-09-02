"""Prospective power simulation: how long must a pre/post test run?

Answers "what is the smallest effect we could detect in N days?" from a client's
own history, before any intervention has happened. Used to pick a test duration
up front, which is also what keeps the error rate honest — deciding to stop once
the interval happens to exclude zero inflates false positives badly.

Method (following the R reference implementation):
  1. Fit the Bayesian engine on real history.
  2. Take the real residual distribution rather than assuming Gaussian noise.
  3. Simulate many post-periods with a known injected effect.
  4. Record how often the credible interval clears the decision threshold.

Two decision rules, because "we found a lift" and "we did no harm" are different
questions and the second needs more data:
  superiority      - the interval must exclude zero (did this help?)
  non-inferiority  - the interval must exclude a pre-declared harm threshold
                     (did this avoid hurting by more than we can tolerate?)

Why this is fast enough to run in a browser
-------------------------------------------
CausalImpact fits on the pre-period only; post-period data never enters the fit.
So when the pre-period is held fixed, every replication would re-derive the same
posterior. We fit ONCE and reuse the draws across the whole duration x effect
grid, which turns hours of resampling into one Gibbs run plus vectorized numpy.

Given that, power has a closed form. Writing T for the summed counterfactual of
one simulated future, N for its summed noise, and `thresh` for the smallest
observed total that clears the decision rule, a test with true relative effect e
is detected when (1 + e) * T + N > thresh. Solving for e gives that replication's
critical effect,

    e* = (thresh - N) / T - 1

so power at e is just the fraction of replications with e* < e, and the minimum
detectable effect at any target power is a quantile of e*. Both come out of one
pass — no grid search, no interpolation.

What decides whether a longer test helps
----------------------------------------
MDE goes roughly as sqrt(N * sigma_level^2 + sigma_obs^2 / N) over the mean, so
which variance term dominates decides the direction, and it can go either way:

    good controls -> sigma_obs collapses -> level term wins -> MDE ~ sqrt(N),
                     and a longer test is actively WORSE
    weak controls -> sigma_obs is large  -> obs term wins   -> MDE ~ 1/sqrt(N),
                     and a longer test helps as intuition expects

So the counterintuitive case is the good one: the better the control series, the
sooner running longer stops paying and starts costing. `prior_level_sd` is the
dominant lever over this — on one realistic series, MDE at 84 days ran 2.70% at
0.001, 9.08% at 0.01 and 63.12% at 0.1. A plan computed at a different
prior_level_sd than the analysis will use is not a plan for that analysis, which
is why the caller must pass the value the analyst actually intends to run.

Two things that look like they should matter here and were measured not to.
Heteroscedasticity: a rate-derived count has variance scaling with its
denominator, ~2.5x between quiet and busy days, but scaling the residual
bootstrap by sqrt(denominator) moved MDE by 0.01pp. Holding traffic fixed and
swapping heteroscedastic noise for homoscedastic noise reproduced the wandering
curve exactly (6.53% vs 6.47% at 14 days), so the response's varying LEVEL is
what matters, not its varying noise. And the stand-in future window: a strong
seasonal cycle with steady traffic stays perfectly monotone.

Calibration
-----------
On weekly-seasonal data these estimates come out conservative, and deliberately
so. Measured false-positive rates at a true effect of zero, alpha=0.05, against
a nominal one-sided 2.5%:

    resampling            7d     14d     28d     56d
    day-by-day           2.6%    3.1%    2.6%    3.0%
    weekly blocks        0.0%    0.2%    0.5%    1.7%

Day-by-day resampling hits the nominal rate only because two errors cancel: it
assumes noise is independent, which is exactly the assumption the engine makes
and the data breaks. Weekly blocks model the data honestly, and the gap that
opens up is real conservatism the analyst will meet in the actual analysis —
the engine has no seasonal component, so it books day-of-week wobble as
observation noise and widens its interval accordingly. A planning tool should
predict the run they will really get, so weekly blocks are the default. Adding
a seasonal component to `bayes.py` would close the gap at its source.
"""

import numpy as np

import bayes

MIN_TRAIN = 30          # refuse to plan off a history too short to fit
DEFAULT_BLOCK = 7       # weekly blocks keep day-of-week structure in the noise


def _block_bootstrap(resid, n_out, n_sims, block, rng, phase=0):
    """Resample residuals in phase-aligned contiguous blocks: (n_sims, n_out).

    Sampling one day at a time throws away autocorrelation and day-of-week
    structure, making simulated series look tamer than the real thing. Blocks
    fix the autocorrelation, but blocks starting at arbitrary offsets still
    scramble the weekday: each block lands at a random phase, so a Tuesday
    residual can end up on a Saturday. Restricting starts to multiples of
    `block` keeps every resampled point on its own weekday.

    `phase` is the position of the first output point within the weekly cycle,
    so a post-period that does not begin on a multiple of `block` still lines up
    with the calendar.
    """
    block = max(1, min(block, len(resid) // 2))
    n_whole = len(resid) // block
    if n_whole < 2:                     # too little history to align; fall back
        idx = rng.integers(0, len(resid), size=(n_sims, n_out))
        return resid[idx]
    phase %= block
    n_blocks = int(np.ceil((n_out + phase) / block))
    starts = block * rng.integers(0, n_whole, size=(n_sims, n_blocks))
    idx = (starts[:, :, None] + np.arange(block)).reshape(n_sims, -1)
    return resid[idx[:, phase:phase + n_out]]


def simulate_power(y, X=None, *, durations, effects, alpha=0.05, n_sims=2000,
                   harm_threshold=None, power_target=0.8, block=DEFAULT_BLOCK,
                   prior_level_sd=0.01, niter=1000, burn=None, seed=None,
                   progress=None):
    """Estimate detection rates over a grid of test durations and effect sizes.

    `y` and `X` are the full historical series — no intervention has occurred.

    The model is fit once on ALL of that history, and each candidate duration
    varies only the forecast horizon. Getting here took two wrong turns worth
    recording, because both look reasonable:

    Holding out the longest candidate for every row made each row pay the
    longest candidate's cost, so merely offering a longer option degraded the
    short-duration estimates — the table changed depending on what else was in
    it. Holding out each duration's own tail fixed that but introduced a worse
    confound: rows then differed in training size, and more history lets the
    sampler infer a larger level drift, which widens the forecast band. A 7-day
    row fit on 173 points scored worse than one fit on 96, for reasons that had
    nothing to do with test length.

    Both are wrong for the same reason: a test that has not run yet does not
    consume history. Whatever length you pick, the real analysis will fit on
    everything you have. So training is held fixed at the full series and only
    the horizon moves, which is the only way rows compare like for like.

    The post-period covariate path is the last `duration` points of history,
    reused as a stand-in for the future. Nothing leaks from the response — the
    simulated futures are drawn from the posterior and real bootstrapped
    residuals — but if that tail is unusual (a promo, an outage), the
    counterfactual inherits it.

    `effects` and `harm_threshold` are relative, as fractions (0.02 is a 2%
    lift; a harm threshold of -0.02 means "a drop worse than 2% is
    unacceptable").
    """
    y = np.asarray(y, dtype=float)
    durations = sorted({int(d) for d in durations})
    effects = sorted(float(e) for e in effects)
    if not durations or durations[0] < 1:
        raise ValueError('durations must be positive integers.')
    if not effects:
        raise ValueError('Provide at least one effect size.')
    if not np.isfinite(y).all():
        raise ValueError('Power simulation requires history without gaps.')

    n_train = len(y)
    if n_train < MIN_TRAIN:
        raise ValueError(
            f'Need at least {MIN_TRAIN} time points of history to plan from; '
            f'got {n_train}. Pull more history.')
    if durations[-1] * 2 > n_train:
        raise ValueError(
            f'Cannot plan a {durations[-1]}-point test from {n_train} points of '
            f'history: the stand-in future would be most of the series. Pull '
            f'more history or shorten the longest duration considered.')

    if X is not None:
        X = np.asarray(X, dtype=float)
        if X.ndim == 1:
            X = X[:, None]
        if X.shape[0] != len(y):
            raise ValueError('Covariate rows must match the response length.')
        if not np.isfinite(X).all():
            raise ValueError('Covariates cannot contain missing values.')

    burn = max(100, niter // 5) if burn is None else int(burn)

    # --- one fit, on the whole history -------------------------------------
    mu_y, sd_y = y.mean(), y.std()
    if sd_y == 0:
        raise ValueError('Input response cannot be constant.')
    Xs = Xs_tr = None
    if X is not None and X.shape[1]:
        mu_x, sd_x = X.mean(axis=0), X.std(axis=0)
        sd_x[sd_x == 0] = 1.0
        Xs = Xs_tr = (X - mu_x) / sd_x

    draws = bayes.gibbs_fit((y - mu_y) / sd_y, Xs_tr, niter, burn,
                            prior_level_sd, seed, progress=progress)

    # Real residual noise, not a textbook assumption.
    fitted = bayes.fitted_pre(draws, Xs_tr, seed).mean(axis=0) * sd_y + mu_y
    resid = y - fitted

    rng = np.random.default_rng(seed)
    grid = np.empty((len(durations), len(effects)))
    mde = np.empty(len(durations))
    false_positive = np.empty(len(durations))

    for i, n_post in enumerate(durations):
        # Stand-in future covariates: the last n_post points of real history.
        Xs_post = Xs[n_train - n_post:] if Xs is not None else None

        # What the analysis would report as the counterfactual interval.
        pred = bayes.posterior_predict(draws, Xs_post, n_post, seed) * sd_y + mu_y
        totals = pred.sum(axis=1)
        hi = np.quantile(totals, 1.0 - alpha / 2.0)

        # Smallest observed total that clears the decision rule. The relative
        # effect's lower bound is observed / hi - 1, so requiring it to beat
        # `margin` means requiring observed > hi * (1 + margin).
        margin = 0.0 if harm_threshold is None else float(harm_threshold)
        if hi <= 0:
            raise ValueError('Counterfactual total is not positive; relative '
                             'effects are undefined for this series.')
        thresh = hi * (1.0 + margin)

        # A different plausible future per replication. Using the posterior mean
        # instead would leave observation noise as the only source of variation
        # and produce a near step-function power curve.
        truth = bayes.structural_paths(draws, Xs_post, n_post, rng) * sd_y + mu_y
        picks = rng.integers(0, truth.shape[0], size=n_sims)
        T = truth[picks].sum(axis=1)
        N = _block_bootstrap(resid, n_post, n_sims, block, rng,
                             phase=n_train).sum(axis=1)

        ok = T > 0
        crit = np.full(n_sims, np.inf)          # T <= 0 is never detectable
        crit[ok] = (thresh - N[ok]) / T[ok] - 1.0

        grid[i] = [(crit < e).mean() for e in effects]
        false_positive[i] = float((crit < 0.0).mean())
        mde[i] = float(np.quantile(crit, power_target))

    return {
        'durations': durations,
        'effects': effects,
        'power': grid.tolist(),
        'mde': mde.tolist(),
        'false_positive': false_positive.tolist(),
        'recommended_duration': _recommend(durations, mde),
        'mode': 'non_inferiority' if harm_threshold is not None else 'superiority',
        'harm_threshold': harm_threshold,
        'power_target': power_target,
        'alpha': alpha,
        'n_train': int(n_train),
        'n_sims': int(n_sims),
    }


KNEE_IMPROVEMENT = 0.05     # a longer test must beat the shorter one by this


def _recommend(durations, mde):
    """Shortest duration past which extending stops paying.

    These curves plateau — counterfactual uncertainty compounds about as fast as
    the effect accumulates — and once flat, the row that happens to sit lowest is
    noise. An earlier version anchored on the global minimum and inherited that
    noise: across five seeds on one series it returned 56, 21, 14, 21 and 14
    days, and ten times the simulations did not settle it, because the tolerance
    band itself moved with the noisy minimum.

    So this walks forward instead and stops where the next step no longer earns
    its keep, which only ever compares neighbours and never depends on where the
    overall minimum landed.
    """
    finite = [(int(d), float(m)) for d, m in zip(durations, mde) if np.isfinite(m)]
    if not finite:
        return None
    for (d, m), (_, nxt) in zip(finite, finite[1:]):
        if m <= 0:
            return d
        if (m - nxt) / abs(m) < KNEE_IMPROVEMENT:
            return d
    return finite[-1][0]
