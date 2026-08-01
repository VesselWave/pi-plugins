---
'@pi-plugins/speed': patch
---

Mark the rate provisional based on how much the recent requests disagree rather than on how
many tokens have been seen, and drop the decimal place from tok/s.

The `~` cleared once the window held a half-life of tokens, which measures volume of
evidence, not precision: two large responses cleared the bar while saying nothing about the
spread between requests, and an erratic provider cleared it *sooner* than a steady one
because its slow requests filled the window faster. It now tracks the Taylor-linearized
standard error of the ratio estimator and clears at 5%, with Kish's effective sample size
standing in for `n` in the `n/(n-1)` correction — which also stops a window carried by one
heavy request, where the residual is near zero by construction, from reading as a perfect
measurement. Settling is sticky until the error passes 15%, since a single threshold made
the mark flicker ~20 times a session.

tok/s is now whole tokens. The standard error across requests runs to several tokens per
second, so the tenths digit was showing noise at roughly 17x the precision on offer.
