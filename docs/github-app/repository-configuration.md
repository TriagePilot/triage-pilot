# Repository Configuration

The canonical repository configuration path is `.triagepilot.yml` at the repository root. GitHub repositories may retain `.github/triagepilot.yml` as a compatibility fallback. When both files exist, the root file takes precedence. TriagePilot always reads repository configuration from the trusted base revision, never from an unmerged pull-request head.

Missing configuration uses built-in safe defaults in shadow mode. Platforms may also supply workspace or organization configuration. A repository file replaces that configuration unless it opts into inheritance:

| Organization configuration | Repository configuration | Effective configuration |
| --- | --- | --- |
| absent | absent | built-in defaults (`mode: shadow`) |
| present | absent | organization configuration over built-in defaults |
| absent | present, `inheritance` omitted or `false` | repository configuration over built-in defaults |
| present | present, `inheritance` omitted or `false` | repository configuration over built-in defaults; organization values are ignored |
| absent | present, `inheritance: true` | repository configuration over built-in defaults |
| present | present, `inheritance: true` | repository configuration merged over organization configuration, then built-in defaults |

Organization documents use the same field names but may be partial and cannot declare `inheritance`. Repository documents in replacement mode may omit fields that have built-in defaults. `inheritance: true` additionally allows a repository to inherit omitted values from organization configuration. The `inheritance` control is removed before the effective configuration is validated for execution.

```yaml
version: 1
mode: shadow
routing:
  high_risk_reviewers: 2
  exclude_target_branches: ["main", "master"]
  exclude_source_branch_patterns: ["dependabot/**"]
  include_draft_pull_requests: false
risk:
  size:
    high_changed_files: 120
    high_changed_lines: 6000
  thresholds:
    low: 25
    high: 70
  paths:
    - pattern: "src/auth/**"
      weight: 30
      tag: auth
  suppressors:
    - if_all_match: ["docs/**", "*.md", "*.mdx"]
      ceiling: 25
  ai_authorship:
    enabled: true
    modifier: 10
ownership:
  rules:
    - paths: ["src/auth/**"]
      reviewers: ["@sasha"]
  fallback_reviewers: ["@sasha"]
```

## Inheritance and merge rules

Objects merge recursively. Repository scalar values replace organization values. Arrays place repository entries first, followed by organization entries whose normalized keys do not collide:

- `risk.paths` entries are keyed by normalized `pattern`;
- `risk.suppressors` entries are keyed by the sorted, normalized `if_all_match` set;
- `ownership.rules` entries are keyed by the sorted, normalized `paths` set;
- scalar arrays are keyed by their trimmed, lowercase value.

Duplicate keyed entries and normalized duplicate values within one scalar array are invalid and reported at the duplicate entry. Version 1 has no deletion marker: `null` does not remove an inherited value, and empty arrays or objects do not clear inherited entries. Use replacement mode when organization values must be discarded.

Every resolved configuration includes a SHA-256 hash of canonical JSON and leaf-level source attribution (`default`, `organization`, or `repository`). Hashing sorts object keys recursively while retaining effective array order. The dashboard and execution path consume this same resolved result, so the displayed source cannot drift from the value that is executed.

Reviewer values must be individual GitHub user handles such as `@sasha`; organization team handles are not supported. Path patterns use glob syntax.

Reaching either `risk.size.high_changed_files` or `risk.size.high_changed_lines` marks a pull request high risk after test files are excluded. The defaults are 100 changed files and 5,000 changed lines.

Routing is intentionally bounded by risk tier:

- low risk receives a policy approval and requests no human reviewer;
- medium risk requests one human reviewer;
- high risk requests one human reviewer by default, or up to two when `routing.high_risk_reviewers: 2` is set.

`high_risk_reviewers` accepts only `1` or `2`. When equally loaded candidates are available, TriagePilot uses a stable pull-request-specific ordering instead of always favoring the alphabetically first handle. If fewer reviewers are eligible than requested, it records the shortfall and requests only the available reviewers. TriagePilot never requests more than two human reviewers for one decision.

In enforce mode, TriagePilot also synchronizes one risk label on each routed pull request: `triagepilot:risk-low`, `triagepilot:risk-medium`, or `triagepilot:risk-high`. It creates these labels with green, amber, and red colors when needed. On a later routing decision it replaces only an older `triagepilot:risk-*` label; labels managed by the repository team are left unchanged. Shadow mode never creates or changes labels.

`exclude_target_branches` accepts exact target branch names and defaults to an empty list. `exclude_source_branch_patterns` accepts source branch glob patterns and also defaults to an empty list. A pull request matching either exclusion is silently skipped: TriagePilot does not score it, select reviewers, store a decision, or make a GitHub write. For example, set `exclude_target_branches: ["main"]` to skip release pull requests from `develop` into `main`, or set `exclude_source_branch_patterns: ["dependabot/**"]` to skip Dependabot pull requests. Source exclusions are opt-in for each repository.

Draft pull requests are silently skipped by default: TriagePilot does not score them, select reviewers, store a decision, or make a GitHub write. Set `routing.include_draft_pull_requests: true` to route drafts normally. When the default is retained, GitHub's `ready_for_review` event routes the pull request using the trusted base configuration at that time.

The only accepted mode values are `shadow` and `enforce`. In the OSS self-hosted composition, only a trusted repository document can authorize writes. Organization-only `mode: enforce` is forced to shadow; a repository using `inheritance: true` may deliberately inherit organization enforce because the trusted repository document opted into that policy. TriagePilot never reads this policy from the unmerged head commit, so a pull request cannot enable writes for itself. Missing configuration stays in shadow mode; invalid effective configuration records a configuration-failure decision and performs no write. Follow the [rollout guide](../operations/shadow-to-enforce.md) before enabling enforce mode.

## Required human-review policy

In enforce mode, `triagepilot/human-review-policy` requires the number of individual human approvals determined by the risk tier: one for medium risk and the configured one or two for high risk. TriagePilot may request selected reviewers, but they are not an approval cohort. Any active individual approval on the pull request counts, including approval that predates TriagePilot; a later request for changes or dismissal from that reviewer removes it. New commits preserve active approvals and do not trigger automatic reviewer re-requests; developers request a fresh review manually in GitHub when needed. The check succeeds for a no-human route and when the required count is met. It remains in progress while more approvals are needed, and fails when a human-review route has no eligible individual reviewer or TriagePilot reaches a permanent evaluation failure. Team reviewer targets are invalid and result in no GitHub writes.

Use the [required human-review policy guide](required-human-review-policy.md) to configure this check in a GitHub ruleset. Subscribe the GitHub App to `Pull request review` events as described in the [setup guide](setup.md); those events trigger the policy re-evaluation.
