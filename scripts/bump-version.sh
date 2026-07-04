#!/bin/bash
# bump-version.sh - bump package.json version using npm version (native)
# Usage: ./scripts/bump-version.sh [patch|minor|major]
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_TYPE="${1:-patch}"
if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

npm version "$VERSION_TYPE" -m "Bump version to %s"
echo "Version bumped to $(node -p "require('./package.json').version")"
echo "Don't forget to update CHANGELOG.md"
