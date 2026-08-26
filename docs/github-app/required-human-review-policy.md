# Required Human-Review Policy

TriagePilot can publish the `triagepilot/human-review-policy` GitHub App check for an enforce-mode pull request. The check makes TriagePilot's selected individual reviewer cohort enforceable by a GitHub branch ruleset. It does not replace the repository's other merge policy.

## Prerequisites

Use individual GitHub user handles in `.github/triagepilot.yml`; team handles such as `@organization/team` are not supported. Configure **Commit statuses: Read and write** (`statuses:write`) and the other App permissions, then subscribe to **Pull request review** events as described in the [GitHub App setup guide](setup.md). Existing installations must approve the permission update or be reinstalled before enforce mode is resumed. The policy check is created only when the trusted base configuration explicitly uses `mode: enforce`.

## Ruleset configuration

For the protected target branch, create or update your GitHub branch ruleset with these settings:

| Ruleset setting | Value |
| --- | --- |
| Require pull request before merging | Required approvals = `0` |
| Require status checks | `triagepilot/human-review-policy` (expected source: **TriagePilot**), CodeRabbit, and CI |
| Require conversation resolution | Optional organization policy |

Set native required approvals to `0`. GitHub's numeric approval requirement is global and cannot represent TriagePilot's conditional, per-pull-request reviewer cohort. CodeRabbit and CI remain separate required checks; TriagePilot never evaluates, replaces, or satisfies them.

TriagePilot never creates, edits, or manages this ruleset. Self-hosters choose the protected branches and required checks in GitHub.

## Check lifecycle

- A no-human route completes the check successfully.
- Existing active approvals by individual users count toward the required approval total, including approvals that predate TriagePilot or the current head. Bot reviews do not count.
- TriagePilot requests reviewers to guide human attention, but any individual reviewers can satisfy the required approval count.
- A human-review route immediately evaluates GitHub's active review state, then re-evaluates after each later review event. A later request for changes or dismissal from an approving reviewer removes that approval from the total.
- A new pull-request head receives a new policy check and preserves the pull request's active approval total.
- TriagePilot does not re-request reviewers when a pull request receives a new head. A developer must explicitly request another review in GitHub when a follow-up change needs one.
- A human-review route with no eligible individual reviewer completes as a failure. Because the check is required by the ruleset, that failure blocks merge.
- A permanent configuration, authorization, or GitHub API evaluation failure also completes the check as a failure and blocks merge while it remains required.

The policy check is distinct from the informational `triagepilot/routing` check and from TriagePilot's routing action outcome. The dashboard exposes its state and the selected reviewers without exposing raw review bodies or credentials.
