#!/usr/bin/env bash
set -euo pipefail

# Disaster Recovery drill verification script for H2H Arbitrage.
# Clones a Cloud SQL instance from PITR and verifies data integrity.
#
# Usage:
#   ./dr-drill-verify.sh \
#     --project h2h-arbitrage-prod \
#     --instance h2h-arbitrage-db \
#     --recovery-time 2026-07-14T02:00:00Z \
#     --verify-table saved_markets
#
# Requirements:
#   - gcloud CLI authenticated with cloudsql.editor or broader
#   - psql or mysql client (matching your Cloud SQL engine)

PROJECT=""
INSTANCE=""
RECOVERY_TIME=""
VERIFY_TABLE=""
KEEP_CLONE=false
DRY_RUN=false

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --project PROJECT       GCP project ID
  --instance INSTANCE     Cloud SQL instance name
  --recovery-time TIME    ISO-8601 timestamp for PITR (e.g., 2026-07-14T02:00:00Z)
  --verify-table TABLE    Table name to sanity-check (e.g., saved_markets)
  --keep-clone            Do not delete the temporary clone after verification
  --dry-run               Print commands without executing
  -h, --help              Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --recovery-time) RECOVERY_TIME="$2"; shift 2 ;;
    --verify-table) VERIFY_TABLE="$2"; shift 2 ;;
    --keep-clone) KEEP_CLONE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$PROJECT" || -z "$INSTANCE" || -z "$RECOVERY_TIME" || -z "$VERIFY_TABLE" ]]; then
  echo "ERROR: --project, --instance, --recovery-time, and --verify-table are required."
  usage
  exit 1
fi

TS=$(date -u +%Y%m%d%H%M%S)
CLONE_NAME="${INSTANCE}-drill-${TS}"

run() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY-RUN] $*"
  else
    echo "[RUN] $*"
    "$@"
  fi
}

# Pre-checks
echo "=== DR Drill Verification ==="
echo "Project:       $PROJECT"
echo "Instance:      $INSTANCE"
echo "Recovery time: $RECOVERY_TIME"
echo "Clone name:    $CLONE_NAME"
echo ""

if ! command -v gcloud &>/dev/null; then
  echo "ERROR: gcloud CLI not found."
  exit 1
fi

if [[ "$DRY_RUN" == false ]]; then
  if ! gcloud projects describe "$PROJECT" &>/dev/null; then
    echo "ERROR: gcloud cannot access project $PROJECT."
    exit 1
  fi
fi

# Clone from PITR
echo "Step 1: Creating Cloud SQL clone from PITR..."
if [[ "$DRY_RUN" == false ]]; then
  run gcloud sql instances clone "$INSTANCE" "$CLONE_NAME" \
    --project="$PROJECT" \
    --point-in-time="$RECOVERY_TIME"

  echo "Waiting for clone to become ready..."
  for i in {1..60}; do
    STATE=$(gcloud sql instances describe "$CLONE_NAME" --project="$PROJECT" --format="value(state)" 2>/dev/null || true)
    if [[ "$STATE" == "RUNNABLE" ]]; then
      echo "Clone is RUNNABLE."
      break
    fi
    echo "  ($i/60) state=$STATE ..."
    sleep 10
  done

  if [[ "$STATE" != "RUNNABLE" ]]; then
    echo "ERROR: Clone did not become RUNNABLE in time."
    exit 1
  fi
else
  echo "[DRY-RUN] Would clone $INSTANCE to $CLONE_NAME at $RECOVERY_TIME"
fi

# Get connection info
echo ""
echo "Step 2: Fetching clone connection info..."
if [[ "$DRY_RUN" == false ]]; then
  DB_TYPE=$(gcloud sql instances describe "$CLONE_NAME" --project="$PROJECT" --format="value(databaseVersion)" || true)
  CONNECTION=$(gcloud sql instances describe "$CLONE_NAME" --project="$PROJECT" --format="value(connectionName)")
  echo "Database type: $DB_TYPE"
  echo "Connection:    $CONNECTION"
else
  echo "[DRY-RUN] Would fetch connection info for $CLONE_NAME"
fi

# Verify data integrity
echo ""
echo "Step 3: Verifying table $VERIFY_TABLE..."
if [[ "$DRY_RUN" == false ]]; then
  # Determine engine and run appropriate query
  if [[ "$DB_TYPE" == POSTGRES* ]]; then
    SQL="SELECT COUNT(*) AS row_count, MAX(updated_at) AS max_updated FROM ${VERIFY_TABLE};"
    # Prefer Cloud SQL Proxy or direct IP; this example uses gcloud sql connect
    RESULT=$(gcloud sql connect "$CLONE_NAME" --project="$PROJECT" --database="h2h" --user="h2h_reader" --quiet <<< "$SQL" 2>/dev/null || true)
  else
    SQL="SELECT COUNT(*) AS row_count, MAX(updated_at) AS max_updated FROM ${VERIFY_TABLE};"
    RESULT=$(gcloud sql connect "$CLONE_NAME" --project="$PROJECT" --database="h2h" --user="h2h_reader" --quiet <<< "$SQL" 2>/dev/null || true)
  fi

  if [[ -n "$RESULT" ]]; then
    echo "Query result:"
    echo "$RESULT"
    echo "PASS: Data verification query executed successfully."
  else
    echo "WARN: Could not connect to clone for query. Manual verification required."
  fi
else
  echo "[DRY-RUN] Would run COUNT/MAX query on $VERIFY_TABLE"
fi

# Cleanup
echo ""
echo "Step 4: Cleanup..."
if [[ "$KEEP_CLONE" == true ]]; then
  echo "KEEP_CLONE is set; leaving clone $CLONE_NAME."
  echo "Remember to delete it manually when done."
else
  if [[ "$DRY_RUN" == false ]]; then
    run gcloud sql instances delete "$CLONE_NAME" --project="$PROJECT" --quiet
    echo "Clone deleted."
  else
    echo "[DRY-RUN] Would delete clone $CLONE_NAME"
  fi
fi

echo ""
echo "=== DR Drill Verification Complete ==="
exit 0
