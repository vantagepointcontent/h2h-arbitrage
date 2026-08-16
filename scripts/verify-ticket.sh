#!/usr/bin/env bash
# verify-ticket.sh — Mandatory pre-completion verification for EdgeFinder tickets.
# Usage: scripts/verify-ticket.sh [--skip-tests] [--endpoint URL] [--commit HASH]
#
# Exits 0 only if ALL checks pass:
#   1. Vitest test suite passes (no failures, no skips)
#   2. Commit-scoped isolated candidate build succeeds
#   3. PM2 process is online and serving HTTP 200
#   4. Specified endpoint returns expected data (if --endpoint given)
#   5. Git commit exists and changed files are in it (if --commit given)
#   6. Deployed build matches commit (BUILD_ID vs commit timestamp)
#
# This script is the enforcement mechanism for the verification protocol.
# No ticket should be marked done without running this script (or equivalent manual checks).

set -euo pipefail

cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
SKIP_TESTS=false
ENDPOINT_URL=""
ENDPOINT_CHECK=""
COMMIT_HASH=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)   SKIP_TESTS=true; shift ;;
    --endpoint)     ENDPOINT_URL="$2"; shift 2 ;;
    --endpoint-check) ENDPOINT_CHECK="$2"; shift 2 ;;
    --commit)       COMMIT_HASH="$2"; shift 2 ;;
    *)              echo "Unknown arg: $1"; exit 1 ;;
  esac
done

check() {
  local name="$1"
  local result="$2"
  local detail="${3:-}"
  if [[ "$result" == "PASS" ]]; then
    echo -e "${GREEN}✅ $name${NC} $detail"
    PASS=$((PASS + 1))
  elif [[ "$result" == "SKIP" ]]; then
    echo -e "${YELLOW}⏭  $name${NC} (skipped) $detail"
  else
    echo -e "${RED}❌ $name${NC} $detail"
    FAIL=$((FAIL + 1))
  fi
}

echo "═══════════════════════════════════════════════════════════════"
echo "  EdgeFinder Ticket Verification Protocol"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ────────────────────────────────────────────────────────────────
# 1. VITEST TEST SUITE
# ────────────────────────────────────────────────────────────────
if [[ "$SKIP_TESTS" == "true" ]]; then
  check "Vitest test suite" "SKIP" "(--skip-tests flag)"
else
  echo -e "${YELLOW}Running vitest...${NC}"
  TEST_OUTPUT=$(npx vitest run --reporter=verbose 2>&1) || true
  # grep exits 1 when there are no matches; with pipefail that must mean
  # "zero", not abort the verifier before it can report its result.
  TEST_FAILS=$({ echo "$TEST_OUTPUT" | grep -E '^\s+×' || true; } | wc -l)
  TEST_PASSES=$({ echo "$TEST_OUTPUT" | grep -E '^\s+✓' || true; } | wc -l)
  TEST_SKIPS=$({ echo "$TEST_OUTPUT" | grep -E '^\s+↓' || true; } | wc -l)

  if [[ "$TEST_FAILS" -eq 0 && "$TEST_SKIPS" -eq 0 ]]; then
    check "Vitest test suite" "PASS" "($TEST_PASSES tests passed, 0 failed, 0 skipped)"
  elif [[ "$TEST_FAILS" -eq 0 && "$TEST_SKIPS" -gt 0 ]]; then
    check "Vitest test suite" "FAIL" "($TEST_PASSES passed, $TEST_SKIPS SKIPPED — skipped tests are not allowed)"
  else
    check "Vitest test suite" "FAIL" "($TEST_PASSES passed, $TEST_FAILS FAILED, ${TEST_SKIPS} skipped)"
    # Show failing test names
    echo "$TEST_OUTPUT" | grep -E '^\s+×' | head -10 | sed 's/^/    /'
  fi
fi

# ────────────────────────────────────────────────────────────────
# 2. BUILD SUCCEEDS
# ────────────────────────────────────────────────────────────────
echo -e "${YELLOW}Building an isolated commit-scoped candidate...${NC}"
if BUILD_OUTPUT=$(node scripts/release-manager.mjs build --commit "${COMMIT_HASH:-HEAD}" 2>&1); then
  BUILD_EXIT=0
else
  BUILD_EXIT=$?
fi

if [[ $BUILD_EXIT -eq 0 ]]; then
  CANDIDATE_DIR=$(echo "$BUILD_OUTPUT" | tail -n 1)
  BUILD_ID=$(cat "$CANDIDATE_DIR/.next/BUILD_ID" 2>/dev/null || echo "unknown")
  check "Isolated candidate build succeeds" "PASS" "(BUILD_ID: ${BUILD_ID:0:16}...)"
else
  check "Isolated candidate build succeeds" "FAIL"
  echo "$BUILD_OUTPUT" | tail -20 | sed 's/^/    /'
fi

# ────────────────────────────────────────────────────────────────
# 3. PM2 ONLINE + HTTP 200
# ────────────────────────────────────────────────────────────────
PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  procs = json.load(sys.stdin)
  for p in procs:
    if p.get('name') == 'h2h-arbitrage':
      print(p.get('pm2_env', {}).get('status', 'unknown'))
      break
  else:
    print('not-found')
except:
  print('error')
" 2>/dev/null || echo "error")

if [[ "$PM2_STATUS" == "online" ]]; then
  check "PM2 h2h-arbitrage online" "PASS"
else
  check "PM2 h2h-arbitrage online" "FAIL" "(status: $PM2_STATUS)"
fi

# HTTP check — use Tailscale IP or localhost
HTTP_IP="${H2H_HOST:-localhost}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://${HTTP_IP}:3000/" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "200" ]]; then
  check "HTTP 200 on :3000" "PASS"
else
  check "HTTP 200 on :3000" "FAIL" "(got: $HTTP_CODE)"
fi

# ────────────────────────────────────────────────────────────────
# 4. ENDPOINT VERIFICATION (optional, if --endpoint given)
# ────────────────────────────────────────────────────────────────
if [[ -n "$ENDPOINT_URL" ]]; then
  echo -e "${YELLOW}Curling endpoint: $ENDPOINT_URL${NC}"
  ENDPOINT_RESPONSE=$(curl -s --max-time 30 "$ENDPOINT_URL" 2>/dev/null || echo "CURL_FAILED")
  if [[ "$ENDPOINT_RESPONSE" == "CURL_FAILED" ]]; then
    check "Endpoint $ENDPOINT_URL" "FAIL" "(curl failed)"
  elif [[ -n "$ENDPOINT_CHECK" ]]; then
    if echo "$ENDPOINT_RESPONSE" | grep -q "$ENDPOINT_CHECK"; then
      check "Endpoint $ENDPOINT_URL" "PASS" "(contains: $ENDPOINT_CHECK)"
    else
      check "Endpoint $ENDPOINT_URL" "FAIL" "(expected: $ENDPOINT_CHECK)"
      echo "$ENDPOINT_RESPONSE" | head -5 | sed 's/^/    /'
    fi
  else
    # Just check it returned something non-empty
    if [[ ${#ENDPOINT_RESPONSE} -gt 0 ]]; then
      check "Endpoint $ENDPOINT_URL" "PASS" "(${#ENDPOINT_RESPONSE} bytes)"
    else
      check "Endpoint $ENDPOINT_URL" "FAIL" "(empty response)"
    fi
  fi
else
  check "Endpoint verification" "SKIP" "(no --endpoint specified)"
fi

# ────────────────────────────────────────────────────────────────
# 5. GIT COMMIT VERIFICATION (if --commit given)
# ────────────────────────────────────────────────────────────────
if [[ -n "$COMMIT_HASH" ]]; then
  if git log --oneline "$COMMIT_HASH" -1 >/dev/null 2>&1; then
    COMMIT_MSG=$(git log --oneline "$COMMIT_HASH" -1)
    check "Git commit exists" "PASS" "($COMMIT_MSG)"

    # Show changed files in commit
    COMMIT_FILES=$(git show --stat "$COMMIT_HASH" --oneline | tail -n +2)
    if [[ -n "$COMMIT_FILES" ]]; then
      echo "    Changed files in commit:"
      echo "$COMMIT_FILES" | head -10 | sed 's/^/      /'
    fi
  else
    check "Git commit exists" "FAIL" "(commit $COMMIT_HASH not found)"
  fi
else
  check "Git commit verification" "SKIP" "(no --commit specified)"
fi

# ────────────────────────────────────────────────────────────────
# 6. ACTIVE RELEASE IDENTITY + INTEGRITY
# ────────────────────────────────────────────────────────────────
if ACTIVE_JSON=$(node scripts/release-manager.mjs verify-active 2>/dev/null); then
  ACTIVE_COMMIT=$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.commit)' <<<"$ACTIVE_JSON")
  ACTIVE_BUILD_ID=$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.buildId)' <<<"$ACTIVE_JSON")
  EXPECTED_COMMIT="${COMMIT_HASH:-$(git rev-parse HEAD)}"
  EXPECTED_COMMIT=$(git rev-parse "$EXPECTED_COMMIT^{commit}")
  if [[ "$ACTIVE_COMMIT" == "$EXPECTED_COMMIT" ]]; then
    check "Active release integrity and commit identity" "PASS" "(commit: ${ACTIVE_COMMIT:0:12}, BUILD_ID: ${ACTIVE_BUILD_ID:0:16})"
  else
    check "Active release integrity and commit identity" "FAIL" "(active: ${ACTIVE_COMMIT:0:12}, expected: ${EXPECTED_COMMIT:0:12})"
  fi
else
  check "Active release integrity and commit identity" "FAIL" "(active release missing or drifted)"
fi

# ────────────────────────────────────────────────────────────────
# SUMMARY
# ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}  ALL CHECKS PASSED ($PASS passed, 0 failed)${NC}"
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo -e "${RED}  VERIFICATION FAILED ($PASS passed, $FAIL failed)${NC}"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "Do NOT mark this ticket as done. Fix the failures above first."
  exit 1
fi