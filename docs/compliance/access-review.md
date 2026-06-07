# Quarterly Access Review Runbook — SOC 2 Type II

## Purpose
Verify that all access to H2H Arbitrage production infrastructure follows the principle of least privilege. Remove unused identities, excessive roles, and stale credentials.

## Frequency
**Quarterly** — scheduled for the first Monday of each quarter (Jan, Apr, Jul, Oct).

## Roles
| Role | Responsibility |
|---|---|
| Security Lead | Schedules review, validates findings, approves exceptions |
| Engineering Manager | Reviews team member access, confirms business justification |
| Infrastructure Engineer (h2h-ops) | Runs scripts, executes revocations, documents evidence |

## Procedure

### 1. Pre-review (1 week before)
- [ ] Create calendar invite: "Q{N} Access Review — H2H Arbitrage"
- [ ] Notify team via Slack #compliance
- [ ] Verify `scripts/compliance/access-review.py` is on latest `main`

### 2. Automated enumeration (Day 1)
Run the access review script:
```bash
python3 scripts/compliance/access-review.py --project h2h-arbitrage-prod --out-dir /tmp/access-review-$(date +%Y-%m)
```

This produces:
- `iam_bindings.csv` — all GCP IAM bindings
- `k8s_rbac.csv` — all K8s Roles, ClusterRoles, and bindings
- `service_accounts.csv` — all SAs with last-key-use timestamps
- `report.md` — flagged findings (excessive roles, unused accounts, etc.)

### 3. Manual review (Day 2–3)
- [ ] Engineering Manager reviews each flagged user/SA
- [ ] For each finding, decide: `REVOKE`, `KEEP_WITH_JUSTIFICATION`, or `FALSE_POSITIVE`
- [ ] Document justifications in `report.md`

### 4. Remediation (Day 4–5)
- [ ] Remove unused IAM bindings
- [ ] Rotate service account keys older than 90 days
- [ ] Disable (do not delete) SAs with no use in 60 days
- [ ] Update Terraform `iam.tf` to reflect changes

### 5. Sign-off (Day 5)
- [ ] Security Lead signs `report.md`
- [ ] Upload signed report to `gs://h2h-arbitrage-compliance-reports/access-reviews/`
- [ ] Close review ticket in Linear

## Least-Privilege Checklist

### GCP IAM
- [ ] No project-level `roles/owner` except break-glass accounts (max 2)
- [ ] No `roles/editor` on production projects
- [ ] `roles/compute.admin` restricted to h2h-ops service account
- [ ] GKE cluster access via `roles/container.developer`, never `roles/container.admin`
- [ ] Cloud SQL access via IAM DB Auth, not shared passwords

### Kubernetes RBAC
- [ ] No `cluster-admin` bindings for human users
- [ ] Namespace-scoped roles only (`Role`, not `ClusterRole`) for app teams
- [ ] Service accounts in `default` namespace have zero permissions
- [ ] `system:masters` group contains only break-glass accounts

### Service Accounts
- [ ] All SAs have a documented owner in `docs/compliance/service-account-registry.md`
- [ ] No user-managed keys on SAs unless external integration requires it
- [ ] Keys rotated every 90 days (automated via Terraform + Cloud Scheduler)

## Exception process
If a finding requires an exception:
1. File a ticket in Linear with label `compliance-exception`
2. Document business justification and compensating controls
3. Security Lead + CTO must approve
4. Exception expires automatically in 90 days; renewal requires re-approval

## Artifacts
- Latest script: `scripts/compliance/access-review.py`
- Report template: `docs/compliance/templates/access-review-report.md`
