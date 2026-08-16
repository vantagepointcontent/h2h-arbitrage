# UI-107 BotTrader Logs restoration

## Root cause

The last explicitly reviewed BotTrader clarity change is `9b6f381` (`chore(ui): preserve reviewed BotTrader clarity`) on `preserve/bottrader-clarity-t_82b769fd`. That commit is not an ancestor of current `main`; its merge base with `main` is its parent, `9f89bc0`. Main instead continued through the parallel persisted-scan integration in `a5eb321`.

That branch divergence omitted the reviewed Placement Attempts framing and outcome copy. It also left the original wide event table introduced with the BotTrader action-log UI (`889de40`, carried on main through `77511be`) in place. `a5eb321` then inserted 200 persisted scan-decision cards immediately above the independent market accordions. The result was the production hierarchy in the intake screenshot: scan rows followed by market rows whose expanded content became one wide, flat event table.

UI-107 restores the reviewed framing and card hierarchy without reverting the persisted-scan data added by `a5eb321` or later audit fields.

## Presentation and behavior retained

- Separate Scan runs and Market opportunities sections.
- Independent disclosure state keyed by stable `scanId` and `tradeId`.
- Expanded market actions rendered as an indented stage timeline rather than a wide table.
- Decision source, receive/update timestamps, elapsed duration, attempt/placement counts, reason code, reason, and details retained.
- Action request, response, alert, qualification outcome, timestamp, duration, status, action, and failure reason retained.
- Status, date, market, qualification, auto-refresh, and selection-method controls retained.
- Cursor pagination now has an explicit Load older action logs control; split trade chains merge by stable trade and event IDs without duplication.
- Initial, refresh, empty, load-more, and error states remain visible without replacing the last successful data.
- No scanning, decision, or execution code was changed.

## Preserved reviewed Logs work

Before handoff, this branch also incorporated the exact review-approved, previously uncommitted UI-106 diff from worktree `t_0571dbc0`. It adds `ROI Declined?` immediately after Current ROI, compares full-precision persisted values without missing-to-zero coercion, exposes unavailable-input reasons accessibly, preserves one-500-row lazy loading and exact-market persisted lookup with zero venue calls, and adds CSV parity plus focused tests. A byte-for-byte diff/file comparison against the reviewed UI-106 worktree passed before integration testing.

## Runtime evidence

The production build was run locally against a read-only snapshot of recent production `bot_action_log` and `bot_scan_decisions` rows.

- `logs-dark-desktop.png` — dark desktop scan-run hierarchy.
- `logs-dark-timeline-desktop.png` — dark desktop expanded stage timeline.
- `logs-dark-timeline-mobile.png` — dark 390px expanded stage timeline.
- `logs-mobile.png` — 390px controls and collapsed hierarchy.

CDP measurements:

- Desktop viewport/scroll width: 1440 / 1440.
- Mobile viewport/document/body scroll width: 390 / 390 / 390.
- Real snapshot rendered 200 scan runs, 23 market attempts, and cursor pagination.
- Expanded mobile state retained one scan disclosure and one market disclosure independently.
- No event table remained in the BotTrader Logs view.
