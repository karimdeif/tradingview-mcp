# TV-EV-01 — final verdict: STUDY FAIL (3/5), with findings

Binding pre-registration: docs/PREREG_TV-EV-01.md (4ce8c0a, decidability at
23dfe6c). The bar was ≥4/5 symbols passing; attempt 2 passed 3/5. **By its own
registered arithmetic the study FAILS**, and per the registration the matrix's
gate numbers are formally quarantined pending this investigation's disposition.
No tolerance was bent after the fact.

## Attempt 1 (preserved: tv-ev-01-attempt1-harness-fault/)
0/5 — a proven walker fault: 15/15 matched entries exactly one bar early. The
walker was corrected to the registered rule's own semantics (decision on t−2's
close, fill open[t] — derived from the frozen Pine, not from the tester's
output; the corrected decision bar moved AWAY from the reveal).

## Attempt 2 — the evidence

| symbol | matched | max return diff | verdict |
|---|---|---|---|
| COMI | 16/17 (94%) | **0.012%** | PASS |
| TMGH | 18/19 (95%) | **0.000%** | PASS |
| ORAS | 9/10 (90%) | **0.000%** | PASS |
| FWRY | 15/18 (83%) | 5.018% | FAIL |
| ETEL | 14/19 (74%) | 1.469% | FAIL |

## What the failures actually are (investigated, with receipts)

1. **Window-boundary scoping artifact (walker-side, benign).** Both failing
   symbols were LONG at window start from pre-window tester entries (ETEL since
   2023-07-18, FWRY since 2023-12-06). The walker, starting flat, synthesizes
   an entry at the first bar — and then exits on EXACTLY the tester's exit day
   in both cases (2024-03-24, 2024-02-04). The state and the exit were right;
   the registered entry-scoping cannot pair a synthetic entry, so each counts
   against matched_frac and unmatched_walker.
2. **Tester dust trades.** ETEL's window contains 3 same-day round trips at
   exactly −0.20% each — entry and exit filled at the same open (return =
   pure double commission). The registered rule's plain reading (one decision
   per bar, next-open fills) cannot produce them; they are a Strategy Tester
   fill-mechanics artifact. They slightly HURT the tester's numbers, which is
   the opposite direction from lookahead.
3. **One localized FWRY divergence** (Feb-2025 cluster: one exit 3 bars late,
   one 2-day trade differing −5.19% vs −2.58%, one Jun-2026 entry 3 days off)
   — unexplained; candidate causes are a replay-vs-live bar difference on a
   single day or a halt. Documented, not excused.

## Conclusion

**No evidence of lookahead.** Where trades match — including the +148.89%
(ETEL) and +121.77% (FWRY) positions and everything on the three passing
symbols — returns agree to ≤0.012%. The registered statistic (the ~19–21%/yr
gate corroboration) is SUPPORTED IN SUBSTANCE by this walk, but the study
formally fails its own bar, and that stands. The honest path forward, if the
estate wants the formal pass: register TV-EV-02 fresh, with symmetric
boundary-state scoping and dust-trade handling defined UP FRONT, and the
Feb-2025 FWRY cluster as an explicit investigation item. No re-scoring of
TV-EV-01.
