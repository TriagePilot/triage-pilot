# Shadow-To-Enforce Rollout

Every repository starts in shadow mode. Review recent decisions before enabling writes and confirm that ownership rules, risk thresholds, and GitHub App permissions match the repository.

## Preconditions

- Shadow decisions follow the expected zero/one/two reviewer distribution, never exceed two people, and reserve two-reviewer decisions for the intended high-risk cases.
- `.github/triagepilot.yml` parses without diagnostics.
- The GitHub App has the permissions documented in [GitHub App permissions](../github-app/permissions.md).
- Branch protection and repository policy allow the intended actions.

## Enable Enforce Mode

Change the repository's `.github/triagepilot.yml` to:

```yaml
version: 1
mode: enforce
routing:
  high_risk_reviewers: 2
```

Merge the change through the repository's normal review process. The pull request containing this change remains governed by its base commit, so it cannot enable writes for itself. The repository file is the complete mode change; no second mode control exists. Confirm a subsequent pull-request event, whose base includes the merged configuration, records `enforce` and the intended action outcome. If that queued event's head is no longer current when the worker begins its action sequence, TriagePilot records a permanent action failure and performs no writes for that job; a later GitHub event can create work for the new head.

## Roll Back

Change the repository file back to `mode: shadow` and merge it. Pull-request events whose trusted base includes that merge calculate and store decisions without GitHub writes.
