# Generates reference outputs from the real R CausalImpact package for the
# fixture datasets. Run from py/tests/fixtures/:
#   Rscript generate_r_reference.R
# Writes r_reference.json, consumed by tests/test_r_parity.py.

library(CausalImpact)
library(zoo)
library(jsonlite)

extract <- function(impact) {
  s <- impact$summary
  scope <- function(i) list(
    actual = s$Actual[i],
    predicted = s$Pred[i],
    predicted_lower = s$Pred.lower[i],
    predicted_upper = s$Pred.upper[i],
    abs_effect = s$AbsEffect[i],
    abs_effect_lower = s$AbsEffect.lower[i],
    abs_effect_upper = s$AbsEffect.upper[i],
    rel_effect = s$RelEffect[i],
    rel_effect_lower = s$RelEffect.lower[i],
    rel_effect_upper = s$RelEffect.upper[i]
  )
  list(average = scope(1), cumulative = scope(2), p_value = s$p[1])
}

run_case <- function(name, df, ycol, xcols, t0) {
  data <- zoo(as.matrix(df[, c(ycol, xcols)]))
  n <- nrow(df)
  set.seed(1)
  impact <- CausalImpact(data, c(1, t0), c(t0 + 1, n), alpha = 0.05)
  res <- extract(impact)
  res$name <- name
  res$pre_period <- c(0, t0 - 1)   # 0-based, for the Python side
  res$post_period <- c(t0, n - 1)
  res$n <- n
  res
}

cases <- list(
  run_case("arma_data", read.csv("arma_data.csv"), "y", c("X"), 70),
  run_case("google_data", read.csv("google_data.csv"), "y", c("x1", "x2"), 70),
  run_case("comparison_data", read.csv("comparison_data.csv"), "CHANGED",
           c("NOT_CHANGED_1", "NOT_CHANGED_2", "NOT_CHANGED_3"), 80),
  run_case("volks_data", read.csv("volks_data.csv"), "volkswagen",
           c("bmw", "allianz"), 246)
)

meta <- list(
  causalimpact_version = as.character(packageVersion("CausalImpact")),
  bsts_version = as.character(packageVersion("bsts")),
  r_version = R.version.string,
  niter = "CausalImpact default (1000)"
)

write(toJSON(list(meta = meta, cases = cases), auto_unbox = TRUE, digits = 10),
      "r_reference.json")
cat("Wrote r_reference.json\n")
