"""Bayesian structural time-series engine: local level + spike-and-slab regression.

A pure-numpy Gibbs sampler in the spirit of bsts as used by R's CausalImpact:
  y_t = mu_t + x_t' beta + eps_t,   eps_t ~ N(0, sigma_obs^2)
  mu_{t+1} = mu_t + eta_t,          eta_t ~ N(0, sigma_level^2)

Sampling steps per iteration:
  1. FFBS (Carter-Kohn) for the level states given betas and variances.
  2. SSVS for inclusion indicators gamma with beta and sigma_obs^2 integrated
     out (normal-inverse-gamma conjugacy, Zellner-style information prior with
     diagonal shrinkage), then draw sigma_obs^2 and beta_gamma.
  3. Conjugate inverse-gamma draw for sigma_level^2, truncated above.

Data is standardized internally by pre-period mean/sd, so prior_level_sd is a
fraction of sd(y) — the same convention as R's CausalImpact.
"""

import numpy as np

# Prior weights (data is standardized, so these are on the sd(y)=1 scale).
LEVEL_PRIOR_DF = 32.0          # CausalImpact's SdPrior sample.size for the level
LEVEL_SD_UPPER = 1.0           # truncate sigma_level at sd(y)
OBS_PRIOR_DF = 0.01            # near-uninformative prior on observation noise
OBS_PRIOR_GUESS = 0.5
PRIOR_INFO_WEIGHT = 1.0        # Zellner prior worth ~1 observation
DIAGONAL_SHRINKAGE = 0.5
PRIOR_INCLUSION_PROB = 0.5
INIT_STATE_VAR = 100.0


def _ffbs(z, sigma_obs2, sigma_level2, rng):
    """Forward-filter backward-sample the local level for series z."""
    n = len(z)
    m = np.empty(n)
    p = np.empty(n)
    m_prev, p_prev = 0.0, INIT_STATE_VAR
    for t in range(n):
        p_pred = p_prev + sigma_level2
        gain = p_pred / (p_pred + sigma_obs2)
        m_prev = m_prev + gain * (z[t] - m_prev)
        p_prev = (1.0 - gain) * p_pred
        m[t], p[t] = m_prev, p_prev
    mu = np.empty(n)
    mu[-1] = rng.normal(m[-1], np.sqrt(p[-1]))
    for t in range(n - 2, -1, -1):
        h = p[t] / (p[t] + sigma_level2)
        mean = m[t] + h * (mu[t + 1] - m[t])
        var = p[t] * (1.0 - h)
        mu[t] = rng.normal(mean, np.sqrt(max(var, 0.0)))
    return mu


def _log_marginal(e, X, gamma, prior_prec):
    """Log marginal of the regression target e under inclusion set gamma,
    with beta and sigma_obs^2 integrated out (up to gamma-independent terms)."""
    n = len(e)
    sse_prior = OBS_PRIOR_DF * OBS_PRIOR_GUESS ** 2 + e @ e
    k = int(gamma.sum())
    log_prior = k * np.log(PRIOR_INCLUSION_PROB) + \
        (len(gamma) - k) * np.log1p(-PRIOR_INCLUSION_PROB)
    if k == 0:
        return log_prior - 0.5 * (OBS_PRIOR_DF + n) * np.log(sse_prior)
    Xg = X[:, gamma]
    omega = prior_prec[np.ix_(gamma, gamma)]
    vn_inv = omega + Xg.T @ Xg
    xte = Xg.T @ e
    ln = np.linalg.cholesky(vn_inv)
    lo = np.linalg.cholesky(omega)
    u = np.linalg.solve(ln, xte)
    quad = u @ u
    logdet_vn_inv = 2.0 * np.log(np.diag(ln)).sum()
    logdet_omega = 2.0 * np.log(np.diag(lo)).sum()
    return (
        log_prior
        + 0.5 * (logdet_omega - logdet_vn_inv)
        - 0.5 * (OBS_PRIOR_DF + n) * np.log(sse_prior - quad)
    )


def _sample_regression(e, X, gamma, prior_prec, rng):
    """Draw sigma_obs^2 and beta given inclusion set gamma."""
    n = len(e)
    k = int(gamma.sum())
    if k == 0:
        sse = OBS_PRIOR_DF * OBS_PRIOR_GUESS ** 2 + e @ e
        sigma_obs2 = sse / (2.0 * rng.gamma((OBS_PRIOR_DF + n) / 2.0))
        return sigma_obs2, np.zeros(len(gamma))
    Xg = X[:, gamma]
    omega = prior_prec[np.ix_(gamma, gamma)]
    vn_inv = omega + Xg.T @ Xg
    vn = np.linalg.inv(vn_inv)
    bn = vn @ (Xg.T @ e)
    sse = OBS_PRIOR_DF * OBS_PRIOR_GUESS ** 2 + e @ e - bn @ vn_inv @ bn
    sigma_obs2 = sse / (2.0 * rng.gamma((OBS_PRIOR_DF + n) / 2.0))
    chol = np.linalg.cholesky(sigma_obs2 * vn)
    beta = np.zeros(X.shape[1])
    beta[gamma] = bn + chol @ rng.standard_normal(k)
    return sigma_obs2, beta


def _sample_level_var(mu, prior_guess, rng):
    diffs = np.diff(mu)
    df = LEVEL_PRIOR_DF + len(diffs)
    ss = LEVEL_PRIOR_DF * prior_guess ** 2 + diffs @ diffs
    for _ in range(100):
        draw = ss / (2.0 * rng.gamma(df / 2.0))
        if draw <= LEVEL_SD_UPPER ** 2:
            return draw
    return LEVEL_SD_UPPER ** 2


def gibbs_fit(y, X, niter, burn, prior_level_sd, seed, progress=None):
    """Run the Gibbs sampler on (standardized) pre-period data.

    Returns dict of post-burn-in draws.
    """
    rng = np.random.default_rng(seed)
    n = len(y)
    k = X.shape[1] if X is not None else 0
    if k:
        xtx = X.T @ X / n
        avg = (1.0 - DIAGONAL_SHRINKAGE) * xtx + \
            DIAGONAL_SHRINKAGE * np.diag(np.diag(xtx))
        prior_prec = PRIOR_INFO_WEIGHT * avg
        gamma = np.ones(k, dtype=bool)
    else:
        prior_prec = np.zeros((0, 0))
        gamma = np.zeros(0, dtype=bool)

    beta = np.zeros(k)
    sigma_obs2 = OBS_PRIOR_GUESS ** 2
    sigma_level2 = prior_level_sd ** 2

    keep = niter - burn
    draws = {
        'mu': np.empty((keep, n)),
        'beta': np.empty((keep, k)),
        'gamma': np.empty((keep, k), dtype=bool),
        'sigma_obs2': np.empty(keep),
        'sigma_level2': np.empty(keep),
    }

    for it in range(niter):
        z = y - (X @ beta if k else 0.0)
        mu = _ffbs(z, sigma_obs2, sigma_level2, rng)
        sigma_level2 = _sample_level_var(mu, prior_level_sd, rng)
        e = y - mu
        if k:
            for j in range(k):
                gamma[j] = True
                log_in = _log_marginal(e, X, gamma, prior_prec)
                gamma[j] = False
                log_out = _log_marginal(e, X, gamma, prior_prec)
                p_in = 1.0 / (1.0 + np.exp(log_out - log_in))
                gamma[j] = rng.random() < p_in
        sigma_obs2, beta = _sample_regression(e, X, gamma, prior_prec, rng)

        if it >= burn:
            i = it - burn
            draws['mu'][i] = mu
            draws['beta'][i] = beta
            draws['gamma'][i] = gamma
            draws['sigma_obs2'][i] = sigma_obs2
            draws['sigma_level2'][i] = sigma_level2
        if progress is not None and (it + 1) % 50 == 0:
            progress(it + 1, niter)

    return draws


def posterior_predict(draws, X_post, n_post, seed):
    """Simulate the posterior predictive for the post period: (keep, n_post)."""
    rng = np.random.default_rng(seed + 1 if seed is not None else None)
    keep = draws['mu'].shape[0]
    level_sd = np.sqrt(draws['sigma_level2'])[:, None]
    obs_sd = np.sqrt(draws['sigma_obs2'])[:, None]
    steps = rng.standard_normal((keep, n_post)) * level_sd
    mu_paths = draws['mu'][:, -1:] + np.cumsum(steps, axis=1)
    reg = draws['beta'] @ X_post.T if X_post is not None and X_post.shape[1] else 0.0
    return mu_paths + reg + rng.standard_normal((keep, n_post)) * obs_sd


def fitted_pre(draws, X_pre, seed):
    """Posterior predictive for the pre period (in-sample): (keep, n_pre)."""
    rng = np.random.default_rng(seed + 2 if seed is not None else None)
    reg = draws['beta'] @ X_pre.T if X_pre is not None and X_pre.shape[1] else 0.0
    obs_sd = np.sqrt(draws['sigma_obs2'])[:, None]
    return draws['mu'] + reg + rng.standard_normal(draws['mu'].shape) * obs_sd
