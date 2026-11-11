# Fork notes

Fork of [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) v3.0.4 (+ `fix/consolidation-stale-ctx`, commit `d040d29`).

## Branches

- `master` — tracks upstream, no local changes
- `fix/consolidation-stale-ctx` — cancel in-flight consolidation on session_shutdown (upstreamable, `d040d29`)
- `feat/memory-lifecycle` — this branch; the fix for unbounded memory growth that caused OOM on long-lived sessions

## What feat/memory-lifecycle changes

Root cause being fixed: reflections had no decay path, so compaction summaries grew monotonically and each append-only compaction record embedded the full snapshot — quadratic session-file growth (475MB / 93% compaction records observed) and eventual OOM on resume.

- **F5 — script-aware token estimation** (`src/tokens.ts`): `estimateStringTokens` = `ceil(ascii/4) + ceil(nonAscii/2)` instead of `len/4`; Cyrillic was undercounted up to 4x, breaking every token budget. All char-to-token arithmetic replaced with binary search against the estimator (`serialize.ts` `buildSourceExcerpt`).
- **F2 — summary render budget** (`src/session-ledger/render-summary.ts`): `renderSummaryWithinBudget` greedily drops oldest observations, then oldest reflections, adds a truncation marker; budget = explicit `summaryMaxTokens` > `floor(contextWindow*0.15)` > 24K fallback. `details` keep untruncated content — recall is unaffected.
- **F3 — emergency trim in compaction-hook**: a one-time `summaryBudgetNotified` warning; summary can never exceed the context window, killing the compaction re-trigger thrash loop (63 compactions / ~110MB in one day observed).
- **F1 — reflection lifecycle**: `reflectionsPoolMaxTokens` (default 24K) / target (max/2) config; reflection-dropper agent (stage after observation dropper, LLM-proposed drops with a strict preservation floor); `om.reflections.dropped` ledger tombstones; recall reports reflection `status: active|dropped`; reflection-pool overflow forces the next full fold so drops take effect in rendered summaries.
- **F4 — `/om:vacuum`** (`src/commands/vacuum.ts`, `src/session-ledger/vacuum.ts`): rewrites the session file keeping only the leaf path, stubs superseded on-path compactions (empty summary/details), drops off-path branches; `.bak` backup + atomic rename, refuses when no size reduction.
- **Model chain** (`observational-memory.models` config): per-stage fallback chain with thinking levels for observer/reflector/dropper.

All upstream tests kept green plus new suites: `tokens-script-aware`, `render-summary-budget`, `reflection-dropper`, `vacuum` (300 total).

## Installing this fork in pi

```
pi install git:github.com/leevroko/pi-observational-memory@<tag-or-sha>
```

Refs are pinned; `pi update --extensions` reconciles the checkout but never moves the ref. The `observational-memory` settings namespace is unchanged, so existing config keeps working.
