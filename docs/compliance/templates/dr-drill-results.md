# DR Drill Results Template

<!-- Copy this file for each quarterly drill: YYYY-MM-dr-drill.md -->

## Metadata
- **Drill date**: YYYY-MM-DD 02:00 UTC
- **Quarter**: Q{N} 20{YY}
- **Scenario**: {e.g., "Simulated us-central1 Cloud SQL primary failure"}
- **Participants**: @names
- **Script run**: `scripts/compliance/dr-drill-verify.sh`

## Targets vs Actuals
| Metric | Target | Actual | Status |
|---|---|---|---|
| RTO (Cloud SQL) | 30 min | {actual} | ⬜ PASS / 🔴 FAIL |
| RPO (Cloud SQL) | < 1 min | {actual} | ⬜ PASS / 🔴 FAIL |
| RTO (GKE) | 20 min | {actual} | ⬜ PASS / 🔴 FAIL |
| EU replica lag | < 5 min | {actual} | ⬜ PASS / 🔴 FAIL |

## Procedure log

### Phase 1 — Simulated failure
- [ ] PagerDuty incident created: PD-{id}
- [ ] Stakeholders notified in #ops
- [ ] Maintenance window active

### Phase 2 — PITR clone verification
- **Clone name**: `{instance}-drill-{timestamp}`
- **Recovery time**: `YYYY-MM-DDTHH:MM:SSZ`
- **Clone creation time**: `{min} min`
- **Verification query result**:
  ```
  row_count | max_updated
  -----------+---------------------
  {count}   | {timestamp}
  ```
- **Primary comparison**: Row count diff = {+/-N}, timestamp diff = {N sec}
- **Status**: ⬜ PASS / 🔴 FAIL

### Phase 3 — Failover validation
- [ ] EU replica lag: {N} seconds
- [ ] Ingress health checks: {200 / non-200}
- [ ] External Secrets Operator: ⬜ OK / 🔴 FAIL

### Phase 4 — Cleanup
- [ ] Temp clone deleted
- [ ] PagerDuty incident resolved
- [ ] Slack #ops post published

## Issues found
1. **{Severity}**: {Description}
   - Ticket: {Linear/GitHub issue}
   - Owner: @name

## Remediation actions
| # | Action | Owner | Due date | Status |
|---|---|---|---|---|
| 1 | ... | @name | YYYY-MM-DD | OPEN |

## Sign-off
- [ ] Security Lead: ____________________ Date: ___________
- [ ] Infrastructure Lead (h2h-ops): ____ Date: ___________
