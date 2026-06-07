# Immutable Audit Logs — SOC 2 Type II

## Overview
H2H Arbitrage maintains immutable, tamper-evident audit logs for all administrative and data-access events across the production infrastructure. This document describes the log sources, retention policies, and verification procedures.

## 1. GCS Audit-Logs Bucket (WORM)

- **Bucket**: `gs://h2h-arbitrage-audit-logs-prod`
- **Region**: `us-central1` (primary), dual-region `nam4` for redundancy
- **Retention policy**: **Locked, 7-year retention** (WORM / compliant with SEC 17a-4)
- **Bucket policy**: Uniform bucket-level access enabled; object ACLs disabled
- **Lifecycle**: No delete or overwrite actions permitted by any principal, including project owners

### Verification command
```bash
gsutil retention get gs://h2h-arbitrage-audit-logs-prod
gsutil iam get gs://h2h-arbitrage-audit-logs-prod
```

Expected output: `Retention Policy (LOCKED): 7 Year(s)`

## 2. Cloud Audit Logs Enabled

All GCP services configured to emit Admin Activity, Data Access, and System Event audit logs:

| Log type | Services covered | Storage target |
|---|---|---|
| Admin Activity | IAM, GKE, Cloud SQL, Cloud Storage, Secret Manager | GCS + BigQuery |
| Data Access | Cloud SQL, Cloud Storage (read/write) | GCS + BigQuery |
| System Event | GKE, Cloud SQL, Compute | GCS + BigQuery |

### Enable / verify
```bash
gcloud logging sinks list --folder=h2h-arbitrage-prod
gcloud projects get-iam-policy h2h-arbitrage-prod --flatten="bindings[].members" --format="table(bindings.role)"
```

## 3. Log Sinks to BigQuery

Long-term analytics and auditor querying via BigQuery dataset `h2h_arbitrage_audit_logs`:

- **Dataset location**: `US`
- **Table expiration**: None (permanent)
- **Partitioning**: By `_PARTITIONDATE` (daily ingestion time)
- **Access**: Read-only granted to `auditors@h2h-arbitrage.com` and `compliance@h2h-arbitrage.com`

### Sink configuration (Terraform)
```hcl
resource "google_logging_project_sink" "bigquery_audit_sink" {
  name        = "audit-logs-to-bigquery"
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/h2h_arbitrage_audit_logs"
  filter      = <<EOF
    protoPayload.serviceName!=""
    AND (logName=~".*cloudaudit.googleapis.com%2Factivity" OR
         logName=~".*cloudaudit.googleapis.com%2Fdata_access" OR
         logName=~".*cloudaudit.googleapis.com%2Fsystem_event")
  EOF

  bigquery_options {
    use_partitioned_tables = true
  }
}
```

## 4. Retention Schedule

| Data category | Retention | Legal basis |
|---|---|---|
| Financial transaction audit trails | 7 years | SEC 17a-4, MiFID II |
| Admin login / IAM change logs | 7 years | SOC 2 CC6.1, CC7.2 |
| Data access logs (API / DB) | 3 years | GDPR Art. 32, SOC 2 CC6.1 |
| System event / uptime logs | 1 year | Operational |

### Quarterly verification
Run `scripts/compliance/access-review.py` which includes a section that validates:
- GCS bucket retention policy is locked
- BigQuery dataset exists and tables are receiving rows
- No unexpected sink deletions in the past 90 days

## 5. Tamper Detection

- **Object versioning**: Enabled on audit-logs bucket; any overwrite creates a new generation
- **VPC Service Controls**: Audit-logs bucket is inside a service perimeter that blocks data exfiltration
- **Alerting**: Prometheus rule `AuditLogSinkDeleted` pages on-call if a log sink is removed

## Related documents
- `docs/compliance/access-review.md` — quarterly access review runbook
- `docs/runbooks/oncall.md` — alerting and incident response
