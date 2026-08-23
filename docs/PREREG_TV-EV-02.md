# Pre-registration: TV-EV-02 — replay-consistency of the SMA100 gate, corrected scoping

Registered BEFORE the walk executes. Karim's GO recorded via the chief
(structured choice: "Run the fixed check once more"). Supersedes nothing:
TV-EV-01 stands as FAIL-by-its-own-bar in the registry; the quarantine on the
~19–21%/yr corroboration lifts ONLY on this study's own pass.

## Changes from TV-EV-01 — exactly three, all defined here up front

1. **Symmetric boundary-state scoping.** The walker initializes its position
   from the pre-window signal state (long iff close[t−2] > SMA100 at the first
   window bar). A position open AT window start is OUT OF SCOPE on both sides:
   tester trades are already scoped by entry; the walker's initial position is
   excluded identically. (TV-EV-01 evidence: both such positions exited on
   exactly the tester's exit day — the state was right, only the pairing rule
   was asymmetric.)
2. **Dust-trade handling.** Tester trades with entry and exit on the same UTC
   day AND profit_pct equal to −0.20% within 1e-6 (same-open round trips:
   pure double commission) are excluded from the matching population and
   reported as a separate `dust_trades` count. The registered rule text cannot
   express them by construction; they hurt the tester's numbers, the opposite
   direction from lookahead.
3. **FWRY Feb-2025 investigation item.** Regardless of verdict, the walk
   reports the full walker-vs-tester trade timeline for FWRY 2025-02-01 →
   2025-03-15, so the one unexplained TV-EV-01 cluster is examined rather
   than absorbed.

## Everything else FROZEN as at TV-EV-01

Symbols COMI, TMGH, ORAS, FWRY, ETEL; 1D; window 2024-01-02 → 2026-08-20;
rule = the exact baseline Pine (decision on t−2's close, fill at open[t],
0.10% commission per side); matching one-to-one greedy by entry, ±1 bar
(≤4 calendar days) on entry AND exit, matched per-trade return diff ≤0.5%
absolute, ≤2 unmatched walker trades per symbol; **study PASS iff ≥4/5
symbols pass — decided solely by that count**. FAIL → harness investigated
first, reported at full volume, and we are back where TV-EV-01 left us —
honestly.
