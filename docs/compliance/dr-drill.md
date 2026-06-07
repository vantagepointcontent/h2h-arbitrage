# Disaster Recovery Drill Schedule — SOC 2 Type II

## Objective
Validate that H2H Arbitrage can recover from a regional outage or data corruption event within the defined RTO/RPO targets.

## RTO / RPO
| System | RTO | RPO |
|---|---|---|
| Cloud SQL (primary) | 30 min | < 1 min (PITR) |
| Cloud SQL (EU replica) | 1 hour | < 5 min (async replication) |
| GKE workloads | 20 min | N/A (stateless, GitOps) |
| GCS buckets | 15 min | N/A (multi-region) |

## Schedule
**Quarterly** — second Tuesday of each quarter at 02:00 UTC (low-traffic window).

| Quarter | Date | Lead | Status |
|---|---|---|---|
| Q2 2026 | 2026-04-14 | h2h-ops | Completed |
| Q3 2026 | 2026-07-14 | h2h-ops | Scheduled |
| Q4 2026 | 2026-10-13 | h2h-ops | TBD |
| Q1 2027 | 2027-01-12 | h2h-ops | TBD |

## Pre-drill checklist (24h before)
- [ ] Verify PagerDuty maintenance window is created (suppresses non-critical alerts)
- [ ] Notify stakeholders via Slack #ops (maintenance window start/end)
- [ ] Confirm Terraform state backend is accessible
- [ ] Verify `scripts/compliance/dr-drill-verify.sh` is on latest `main`

## Drill procedure

### Phase 1 — Simulated primary region failure (15 min)
1. Create a PagerDuty incident: `DR Drill Q{N} — simulated us-central1 outage`
2. Confirm ArgoCD begins resyncing workloads to standby nodes
3. Do NOT actually stop the primary DB or cluster in production; use a staging cluster for destructive tests

### Phase 2 — Database point-in-time recovery (30 min)
Run the automated verification script:
```bash
./scripts/compliance/dr-drill-verify.sh \
  --project h2h-arbitrage-prod \
  --instance h2h-arbitrage-db \
  --recovery-time "$(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%SZ)" \
  --verify-table saved_markets
```

What the script does:
1. Clones the Cloud SQL instance from PITR to a temporary instance `h2h-arbitrage-db-drill-{timestamp}`
2. Connects and runs `SELECT COUNT(*), MAX(updated_at) FROM saved_markets`
3. Compares row count and timestamp against the primary (read replica or direct query)
4. Prints PASS/FAIL
5. Deletes the temporary clone (unless `--keep-clone` is passed)

### Phase 3 — Failover validation (15 min)
- [ ] Verify EU read replica is caught up (`SHOW SLAVE STATUS` / Cloud SQL replica lag metric)
- [ ] Verify ingress-nginx health checks return 200 on standby region
- [ ] Verify External Secrets Operator can still read from GCP Secret Manager

### Phase 4 — Cleanup (10 min)
- [ ] Delete temporary Cloud SQL clone
- [ ] Resolve PagerDuty incident
- [ ] Post Slack #ops: "DR drill complete — results in docs/compliance/dr-drill-results/YYYY-MM.md"

## Post-drill report template
See `docs/compliance/templates/dr-drill-results.md`.

Required contents:
- Drill date and participants
- Scenario description
- Actual RTO / RPO achieved vs target
- Issues found (with severity)
- Remediation tickets created
- Sign-off by Security Lead

## Automation
- Calendar invite: `ops@h2h-arbitrage.com` invites `h2h-ops` + `on-call`
- PagerDuty maintenance window: created automatically 24h before drill via `scripts/compliance/create-dr-window.py`
- DR verification script: `scripts/compliance/dr-drill-verify.sh`

## Related documents
- `docs/runbooks/disaster-recovery.md` — full DR runbook
- `docs/compliance/audit-logs.md` — audit log retention
