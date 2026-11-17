# Changelog

Notable features and fixes are recorded here by release. Dates reflect the tagged commits. Entries for the initial release summarize changes made before its tag.

## Unreleased

### Changed

- Clarified first-run self-hosting, GitHub App installation delivery, and verification of the first persisted shadow decision.

## 1.2.0 - 2026-11-15

### Added

- Added a shared pull request queue.
- Added review analytics and backlog-aware reviewer routing.
- Added author-based risk rules.
- Added a repository setup prompt for coding assistants.

### Changed

- Redesigned the administrator operations UI.
- Approve pull requests that match branch exclusions.
- Made reviewer assignment shortages recoverable.

### Fixed

- Restored pull request links and routing recovery controls in the administrator UI.

## 1.1.1 - 2026-09-23

### Changed

- Hardened the production Docker image on Node 24.
- Added instructions for installing the public container image.
- Prepared tokenless npm publishing.

## 1.1.0 - 2026-09-22

### Changed

- Redesigned the self-hosted administrator UI and login.
- Added npm publication support.

### Fixed

- Fixed Docker builds from a clean source checkout.
- Preserved annotated tag checkout in the release workflow.

## 1.0.0 - 2026-09-11

The first tagged release established the self-hosted GitHub pull request routing application and completed Phase 0 feature parity.

### Added

- Added risk-tier labels and explanations of risk scores in pull request comments.
- Added source branch exclusions and configurable draft pull request triage.
- Added reviewer availability routing and routing recovery controls.
- Added credit for existing approvals on the current pull request head.

### Fixed

- Excluded pull request authors from reviewer quotas.
- Distinguished draft and ready pull request routing jobs.
- Preserved active approvals across pull request updates, counted active approvals for review policy, and refreshed policy state after routing.
