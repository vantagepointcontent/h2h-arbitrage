#!/usr/bin/env bash
# bump-version.sh — Semantic version bump for H2H Arbitrage
# Usage: ./scripts/bump-version.sh [major|minor|patch|<explicit-version>]
#
# Examples:
#   ./scripts/bump-version.sh patch     # 0.1.0 → 0.1.1
#   ./scripts/bump-version.sh minor    # 0.1.0 → 0.2.0
#   ./scripts/bump-version.sh major    # 0.1.0 → 1.0.0
#   ./scripts/bump-version.sh 1.2.3   # sets to 1.2.3 explicitly

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PACKAGE_JSON="$ROOT_DIR/package.json"
CHANGELOG="$ROOT_DIR/CHANGELOG.md"

if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "ERROR: package.json not found at $PACKAGE_JSON" >&2
  exit 1
fi

CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$PACKAGE_JSON'))['version'])")

BUMP_TYPE="${1:-}"

if [[ -z "$BUMP_TYPE" ]]; then
  echo "Usage: $0 [major|minor|patch|<version>]" >&2
  exit 1
fi

# Parse bump type or explicit version
if [[ "$BUMP_TYPE" == "major" || "$BUMP_TYPE" == "minor" || "$BUMP_TYPE" == "patch" ]]; then
  # Split version into parts
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  
  case "$BUMP_TYPE" in
    major)
      MAJOR=$((MAJOR + 1))
      MINOR=0
      PATCH=0
      ;;
    minor)
      MINOR=$((MINOR + 1))
      PATCH=0
      ;;
    patch)
      PATCH=$((PATCH + 1))
      ;;
  esac
  
  NEW_VERSION="$MAJOR.$MINOR.$PATCH"
else
  # Validate explicit version format
  if [[ ! "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: Invalid version '$BUMP_TYPE'. Expected MAJOR.MINOR.PATCH (e.g., 1.2.3)" >&2
    exit 1
  fi
  NEW_VERSION="$BUMP_TYPE"
fi

echo "Bumping version: $CURRENT_VERSION → $NEW_VERSION"

# Update package.json atomically (temp file + mv)
TMP_PKG=$(mktemp)
python3 -c "
import json, sys
pkg = json.load(open('$PACKAGE_JSON'))
pkg['version'] = '$NEW_VERSION'
json.dump(pkg, sys.stdout, indent=2)
print()
" > "$TMP_PKG"
mv "$TMP_PKG" "$PACKAGE_JSON"

# Append to CHANGELOG.md
TODAY=$(date +%Y-%m-%d)
UNRELEASED="## [$NEW_VERSION] (unreleased)"

# Check if unreleased section already exists
if grep -qF "$UNRELEASED" "$CHANGELOG"; then
  # Replace unreleased header with dated version
  sed -i "s|$UNRELEASED|## [$NEW_VERSION] - $TODAY|" "$CHANGELOG"
else
  # Insert new entry after the header section (after the semver line)
  sed -i "/\[0/a\\\\n$UNRELEASED" "$CHANGELOG"
fi

# Add version link at bottom if not present
LINK_LINE="[${NEW_VERSION}]: https://github.com/vantagepointcontent/arbitrage-radar/releases/tag/v${NEW_VERSION}"
if ! grep -qF "$LINK_LINE" "$CHANGELOG"; then
  echo "" >> "$CHANGELOG"
  echo "$LINK_LINE" >> "$CHANGELOG"
fi

echo "✓ Version bumped to $NEW_VERSION"
echo "✓ CHANGELOG.md updated"
echo ""
echo "Next steps:"
echo "  git add package.json CHANGELOG.md"
echo "  git commit -m 'chore: bump version to $NEW_VERSION'"
echo "  git tag -a v$NEW_VERSION -m 'Release v$NEW_VERSION'"
