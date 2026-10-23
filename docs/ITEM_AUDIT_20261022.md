# Full 100-item post-hoc math audit (2026-10-22)

This is the fresh per-item audit required by `HANDOFF.md` §10.3 (batch B). It
replaces the old `86/13/1` (single-round) and `91/8/1` (targeted-repair)
figures for the corresponding run, but it does **not** replace the concurrent
independent batch-A review (`77/20/3`, `docs/ITEM_REVIEW_V3_20261021.md`);
both methods are kept side by side in HANDOFF §10.3. This is a local
human-style audit, not a platform score.

## Scope and artifacts

- Audited run: `/tmp/astra-full100-c9` (the stability-closure full run:
  97/100 candidates, 0 `FIELD_VALUE`, 1546 model calls, strict 23/100).
- Input: `/home/ma-user/work/input/test0.txt`, sha256
  `d98995104bbedbca845a1af05a5629eb1b1c184642e28da2b23416e8a5611d0c`.
- Full artifact: `/tmp/astra-item-audit-20261022/review.jsonl` (100 rows;
  sha256 `de2a91be1d06e0227b45ecfd6ae824e687ec365f342a1cd7b411e4ad118a2494`).
- Report: `/tmp/astra-item-audit-20261022/AUDIT.md`
  (sha256 `33829c1598f5bd1ea7814280a8afbfb67b33aab37a526401f20c8623cbf8424c`).
- Summary: `/tmp/astra-item-audit-20261022/summary.json`
  (sha256 `87f6374c73e1b57b596625ea3e77c3c320fe81898664ef743e4d509fb8fe9e12`).
- Adjudication decisions:
  `/tmp/astra-item-audit-20261022/adjudication/decisions.jsonl`
  (sha256 `f6c795e1cbf85e18851785324ec4c2c3c603fb0e99d87099f2849e77873f4ab1`).

Method: two independent passes over ten disjoint batches (<=10 items each),
then a third adjudication pass for five status disagreements and a targeted
recheck of low/medium-confidence rows. The two passes agreed on 95/100
statuses.

## Counts

| Verdict | Count |
| --- | ---: |
| correct | **73** |
| wrong | **19** |
| disputed | **5** |
| unsolved | **3** |
| total | **100** |

The strict `ReferenceJudge` score for this run is 23/100; the gap is mostly
format sensitivity plus the two defective references below. The audit is not a
claim of 73% platform accuracy.

## Wrong items

`1, 6, 12, 16, 18, 20, 22, 26, 29, 34, 36, 43, 45, 47, 52, 69, 76, 96, 98`.

The 19 corrections cover: splitting-field generator/degree, modular inverse,
two-tail binomial cutoff, invariant-measure general solution, Brownian maximum
CDF, missing requested contour, sign of a radial PDE series, circle
Laplace–Beltrami value, option-set representation, degree-6 Alexander
polynomial, missing option D, false transitivity, missing relation graph,
missing option A, formal-adjoint indices/domain, false extra confidence
intervals, wrong seasonal-adjustment method, missing multicollinearity
consequence, and a false heteroskedasticity claim.

## Disputed items

`56, 82, 83, 94, 95` — duplicate correct Lagrange options; a frequency table
whose classes exclude the sample minimum; histogram vs boxplot as “most
suitable”; ambiguous referent in a stepwise-regression removal rule; and
NLS/MLE/Newton–Raphson semantics under “通常采用”.

## Unsolved items

`11, 15, 48` — no usable candidate in the audited run. Items 11 and 15 are
transport-loss cases in the no-retry run; item 48 is also transport-loss in the
same run. They are not counted as correct.

## Reference corrections

- **Item 1:** the candidate `Q(∜5, i)` is wrong (it is the splitting field of
  `x^4 - 5`), but the reference `Q(5^{1/4}, ζ8), 16` is also wrong: the
  splitting field of `x^4 + 5` has degree 8, and the degree-16 field
  `Q(5^{1/4}, ζ8)` is a nonminimal overfield. This corrects HANDOFF §10.1's
  earlier statement that the candidate was correct.
- **Item 64:** the candidate `假` is mathematically correct; the reference
  `正确` is wrong. A ratio of two total-indicator time series can be an
  average-indicator series (e.g. total wage / total employees = average wage),
  so it is not necessarily a relative-indicator series.

## Supported claims

This audit supports only the c9 run and the listed artifact. The later §10.3
retry/no-retry arms have their own candidate sets; their strict and candidate
rates must be read from their own reports, not by reusing this 73-item list.
