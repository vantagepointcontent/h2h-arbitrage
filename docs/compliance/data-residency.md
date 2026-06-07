# Data Residency Policy — SOC 2 Type II / GDPR

## Objective
Ensure that EU user data is stored and processed exclusively within European Union regions, and that cross-border data flows are documented and justified.

## Data classification

| Category | Examples | Residency requirement |
|---|---|---|
| Personal data (EU users) | Email, IP, prediction history, wallet addresses | EU only |
| Financial records | Trade history, P&L, settlement data | EU + US (primary), EU replica mandatory |
| System logs | Audit trails, error logs | US primary with EU access |
| ML training data | Anonymized feature vectors | US only; must be anonymized |

## Architecture

### Primary production (US)
- **GKE cluster**: `us-central1`
- **Cloud SQL**: `us-central1` primary instance
- **GCS buckets**: `us-central1` or dual-region `nam4`
- **Redis**: Memorystore Redis `us-central1`

### EU replica
- **Cloud SQL read replica**: `europe-west1`
  - Async replication from primary
  - Used for EU user queries and GDPR data portability requests
  - Promotion to primary tested quarterly via DR drill
- **GCS bucket**: `gs://h2h-arbitrage-eu-data` (single-region `europe-west1`, WORM)
  - Stores EU user backup snapshots
  - Lifecycle: 7-year retention (locked)

### Data flow diagram

```
User (EU) → Cloud CDN / Cloud Load Balancer (anycast)
    → GKE Ingress (us-central1)
        → Backend Pod (us-central1)
            → Cloud SQL Primary (us-central1) ←── async replication ──→ Cloud SQL Replica (europe-west1)
            → Redis (us-central1)
            → GCS Standard (us-central1)
                → GCS WORM EU Backup (europe-west1) ─ daily sync
```

## Controls

### 1. Region tagging
All Kubernetes resources that process EU user data carry the label:
```yaml
labels:
  data-residency: eu
```
Network policies in `k8s/network-policies/data-residency-policies.yaml` restrict pods without this label from accessing the Cloud SQL replica.

### 2. Database routing
Application code routes EU users (`request.geo == "EU"`) to the `europe-west1` Cloud SQL replica for reads. Writes still go to the primary (latency trade-off), but user data is replicated to EU within seconds.

### 3. Backup placement
- Daily Cloud SQL backups: stored in `us-central1` and copied to `europe-west1`
- GCS bucket `gs://h2h-arbitrage-eu-data` receives daily logical exports (`pg_dump`)
- Cross-region replication is encrypted in transit (TLS 1.3) and at rest (CMEK)

### 4. Data deletion
GDPR Art. 17 (right to erasure) requests are handled by:
1. Hard-delete from primary Cloud SQL (cascades to EU replica)
2. Append "deleted" tombstone to `data_deletion_log` table (retained 7 years for audit)
3. Remove from GCS EU backup at next lifecycle rotation (max 30 days)

## Verification

Quarterly, run:
```bash
gcloud sql instances list --project=h2h-arbitrage-prod --format="table(name, region, databaseVersion, replication)"
gsutil ls -L gs://h2h-arbitrage-eu-data | grep "Location:"
```

Expected results:
- Primary Cloud SQL: `us-central1`
- Replica Cloud SQL: `europe-west1` with `REPLICA` status
- EU bucket: `Location: EU` (or `europe-west1`)

## Cross-border transfer mechanism
For any data that must leave the EU (e.g., US-based support staff accessing logs):
- Standard Contractual Clauses (SCCs) in place with GCP
- Data minimization: support staff can only view anonymized logs
- Annual Transfer Impact Assessment (TIA) documented in `docs/compliance/scc-tia-2026.pdf`

## Related documents
- `docs/compliance/audit-logs.md` — audit log retention and WORM buckets
- `docs/runbooks/disaster-recovery.md` — EU replica promotion procedure
- `k8s/network-policies/data-residency-policies.yaml` — network enforcement
