# Access Review Report Template

<!-- Copy this file for each quarterly review: YYYY-Q{N}-access-review.md -->

## Metadata
- **Quarter**: Q{N} 20{YY}
- **Review date**: YYYY-MM-DD
- **Lead**: Name / @slack
- **Script version**: `scripts/compliance/access-review.py` @ commit `SHA`
- **Output directory**: `gs://h2h-arbitrage-compliance-reports/access-reviews/YYYY-Q{N}/`

## Scope
- [ ] GCP project `h2h-arbitrage-prod`
- [ ] GKE cluster `h2h-arbitrage-prod-gke`
- [ ] All service accounts with keys in project

## Summary
| Metric | Value |
|---|---|
| IAM bindings reviewed | {count} |
| K8s RBAC bindings reviewed | {count} |
| Service accounts reviewed | {count} |
| Findings total | {count} |
| Critical | {count} |
| High | {count} |
| Medium | {count} |
| Low | {count} |

## Findings

### CRITICAL
1. **{Resource}** — {Detail}
   - Remediation: {Action}
   - Owner: @name
   - Due: YYYY-MM-DD

### HIGH
1. **{Resource}** — {Detail}
   - Remediation: {Action}
   - Owner: @name
   - Due: YYYY-MM-DD

### MEDIUM
1. **{Resource}** — {Detail}
   - Remediation: {Action}
   - Owner: @name
   - Due: YYYY-MM-DD

### LOW
1. **{Resource}** — {Detail}
   - Remediation: {Action}
   - Owner: @name
   - Due: YYYY-MM-DD

## Remediation log
| # | Finding | Status | Completed date | Notes |
|---|---|---|---|---|
| 1 | ... | NOT_STARTED / IN_PROGRESS / DONE | YYYY-MM-DD | |

## Exceptions
| # | Resource | Justification | Approver | Expires |
|---|---|---|---|---|
| 1 | ... | Business critical: ... | @security-lead | YYYY-MM-DD |

## Sign-off
- [ ] Security Lead: ____________________ Date: ___________
- [ ] Engineering Manager: ______________ Date: ___________
- [ ] Infrastructure Engineer: __________ Date: ___________
