# Change Management Policy — SOC 2 Type II

## Scope
All changes to production infrastructure, CI/CD pipelines, and application deployments for H2H Arbitrage.

## Principles
1. **All changes via PR** — No direct pushes to `main`. No manual edits in GCP Console or `kubectl` without a follow-up PR.
2. **CODEOWNERS enforcement** — Infrastructure directories (`terraform/`, `k8s/`, `helm/`) require approval from `h2h-ops`.
3. **Two approvals for prod terraform** — GitHub branch protection requires **two approving reviews** before merge for `.github/workflows/terraform-apply.yaml` and all files under `terraform/environments/prod/`.
4. **Immutable history** — Force-push to `main` is disabled. All merges use "Create a merge commit" or "Squash and merge" (repo setting).

## Workflow

### 1. Proposal
- Open a PR from a feature branch.
- PR title must follow conventional commits: `feat:`, `fix:`, `chore:`, `security:`.
- Include:
  - Description of the change
  - Risk assessment (LOW / MEDIUM / HIGH)
  - Rollback plan
  - Link to Linear ticket (if applicable)

### 2. Automated checks
Every PR triggers:
- `lint-and-test` — unit tests, Terraform validate, `helm lint`, `tflint`
- `security-scan` — Trivy container scan, Checkov IaC scan, TruffleHog secrets scan
- `plan` (for terraform PRs) — `terraform plan` output posted as PR comment

### 3. Review
| Change type | Required reviewers |
|---|---|
| Application code (`src/`) | 1 domain lead (backend or frontend) |
| Infrastructure (`terraform/`, `k8s/`, `helm/`) | 1 h2h-ops + 1 additional h2h-ops (2 total) |
| CI/CD workflows (`.github/workflows/`) | 2 h2h-ops |
| Compliance scripts (`scripts/compliance/`) | 1 h2h-ops + 1 security |

### 4. Merge
- Only after all checks pass and required approvals are present.
- Post-merge, ArgoCD (or GitHub Actions deploy workflow) applies the change automatically.

### 5. Emergency changes (break-glass)
If production is down and PR latency is unacceptable:
1. Announce in Slack #incidents
2. Apply the minimal fix directly (e.g., `kubectl patch`, GCP console)
3. Open a retroactive PR within 1 hour documenting the exact change
4. Security Lead reviews and approves the retroactive PR within 24 hours

## Evidence for auditors
- GitHub branch protection settings screenshot (stored in `docs/compliance/evidence/branch-protection.png`)
- PR history: all merges to `main` are in Git history
- CODEOWNERS file: `CODEOWNERS` (repo root)

## Related documents
- `docs/compliance/access-review.md` — quarterly access review
- `docs/runbooks/oncall.md` — incident response and break-glass procedures
