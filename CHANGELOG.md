# Changelog

All notable changes to H2H Arbitrage will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-06-07

### Added
- Cross-platform arbitrage scanning between Kalshi and Polymarket
- Real-time price monitoring with configurable polling
- Saved markets list with sidebar navigation
- Manual market matching interface
- MarketFinder integration with PredictionHunt data
- Overview panel with grid/table layout toggle
- Scan view with per-market detail analysis
- Capital-based profit estimation
- Responsive design with mobile swipe gestures
- Dark/light theme support
- Category tagging and expiry filtering for saved markets
- Sortable market list (by name, ROI, expiry, APY)
- Export functionality for manual matches

### Changed
- Upgraded to Next.js 16 with App Router
- Migrated to React 19
- Adopted Tailwind CSS 4 for styling

### Fixed
- Initial pricing display showing stale cached values
- Browser history sync for SPA navigation (pushState/replaceState)
- Polling cleanup on view transitions to prevent ghost loops

## [0.2.0] - 2025-06-07

### Added
- Version management system with semantic versioning
- Interactive changelog viewer via version badge click
- Version bump CLI script for deployment workflow
- Footer version badge with clickable changelog modal
- Automated version tracking in package.json

### Fixed
- Version display now reflects current build version accurately

[0.1.0]: https://github.com/vantagepointcontent/arbitrage-radar/releases/tag/v0.1.0
[0.2.0]: https://github.com/vantagepointcontent/arbitrage-radar/releases/tag/v0.2.0
