# Required Human Review Policy Design

Date: 2026-08-21

Status: Approved for planning

## Summary

TriagePilot will publish a GitHub App check named `triagepilot/human-review-policy` that organizations can make a required status check in a GitHub branch ruleset. The check implements the routing decision's human-review requirement:

- a pull request routed to the no-human policy path is immediately successful;
- a pull request assigned one or two human reviewers remains blocked until every selected reviewer has approved its current head commit.

This is an OSS feature of the existing self-hosted TriagePilot deployment. It uses the user's existing GitHub App and PostgreSQL-backed web and worker processes; it adds no GitHub Actions workflow, user token, hosted service, scheduler, or provider-specific component.

## Goals

- Make TriagePilot's dynamically selected individual reviewers enforceable by a GitHub ruleset.
- Permit low-risk pull requests with zero selected human reviewers to merge after their other required checks pass.
- Require approvals from every individual TriagePilot selected for medium- and high-risk pull requests.
- Require approvals to correspond to the pull request's current head SHA.
- Preserve shadow mode: no GitHub check or other write occurs unless the trusted base configuration explicitly sets `mode: enforce`.
- Retain a durable, inspectable routing decision and policy-check outcome.

## Non-Goals

- Replacing GitHub's native numeric approval requirement, CODEOWNERS, merge queue, or conversation-resolution rules.
- Making CodeRabbit, CI, or any third-party check part of TriagePilot's evaluation. Those remain independently required by the repository's ruleset.
- Supporting team review requests for this policy.
- Maintaining a scheduler, polling loop, reviewer reminders, escalation, or hosted service.
- Automatically creating, editing, or managing GitHub rulesets.

## Repository Configuration Contract

For the policy feature, reviewer candidates and selected reviewers must be individual GitHub user handles. A handle containing a team form such as `@organization/team` is invalid configuration. TriagePilot records the configuration failure and performs no GitHub writes, consistent with the existing invalid-configuration behavior.

The existing routing counts remain unchanged:

| Risk route | Required individual approvals |
| --- | --- |
| No-human route | 0 |
| Medium-risk route | 1 |
| High-risk route | 1, or 2 when `routing.high_risk_reviewers: 2` |

The definitive policy cohort is the distinct individual reviewer list stored in the routing decision, not GitHub's current requested-reviewer list. GitHub can remove a requested-reviewer entry after that person submits a review, so the latter cannot enforce this contract.

## GitHub App Setup

The GitHub App permissions must include:

- `Pull requests: read and write` reads reviews and requests individual reviewers.
- `Checks: read and write` creates and updates the required policy check.
- `Commit statuses: read and write` (`statuses:write`) lets rulesets require `triagepilot/human-review-policy` from the expected TriagePilot App source.

The GitHub App setup must additionally subscribe to the `Pull request review` webhook event. The existing `Pull requests`, `Installation`, and `Installation repositories` subscriptions remain.

Existing GitHub App installations must approve GitHub's updated permission and event request. If no approval action is available, users must reinstall the App and reselect the intended repositories before selecting the resulting check in their repository or organization ruleset.

## Ruleset Guidance

For a protected target branch, users configure a branch ruleset with:

- **Require a pull request before merging**, with GitHub's native required-approval count set to `0`.
- **Require status checks to pass**, including `triagepilot/human-review-policy` restricted to the TriagePilot GitHub App, plus CodeRabbit's check restricted to CodeRabbit and the repository's normal CI checks.
- **Require conversation resolution**, if the organization wants unresolved discussions to block merge.

TriagePilot does not configure this ruleset itself. A numeric GitHub approval count must remain zero because it is global and cannot express TriagePilot's conditional, per-pull-request cohort.

## Components And Data Flow

### Routing Event

1. A supported `pull_request` event creates the existing idempotent routing job with its base and head SHAs.
2. The worker calculates and persists the routing decision from trusted base configuration.
3. In enforce mode, after the existing fresh-head guard succeeds, the worker requests the selected individual reviewers.
4. It creates a policy check on that head SHA:
   - no-human policy route: `completed` with conclusion `success`;
   - one or two selected reviewers: `in_progress` with no conclusion and a summary naming the reviewers still required.

A medium- or high-risk route with no eligible individual reviewer is not a no-human policy route. It publishes a completed `failure` check that identifies the reviewer shortfall, so the required ruleset blocks the pull request.

The policy check is distinct from the existing informational `triagepilot/routing` check. It uses a stable name so a ruleset can require it.

### Review Event

1. GitHub delivers a signed `pull_request_review` webhook to `web` for an approval, request-for-changes, dismissal, or edit event in the configured organization.
2. `web` verifies and durably records the delivery, then inserts an idempotent policy-evaluation job. It does not perform GitHub API work in the webhook request.
3. The worker loads the most recent enforce-mode routing decision for the open pull request and its selected individual reviewer cohort.
4. The worker reads the current pull request and its reviews using the installation token.
5. It evaluates the cohort against the current head SHA and updates the matching policy check.

Events for unconfigured organizations, unknown repositories, closed pull requests, shadow-mode decisions, and pull requests with no enforce-mode routing decision are acknowledged without GitHub writes.

### New Commits

A new `pull_request` synchronization event produces a routing decision for the new head SHA. The worker creates a new policy check for that SHA and evaluates approvals only on that SHA. An approval attached to an earlier SHA never satisfies the new check.

The current routing rules use a pull-request-specific selection key, so a stable eligible set produces the same selected reviewers. The new decision is still authoritative: it captures any configuration, eligibility, or routing change at the new trusted base and head.

## Evaluation Rules

For every selected reviewer, TriagePilot considers that reviewer's latest review on the current head SHA:

- `APPROVED` satisfies that reviewer's requirement.
- `CHANGES_REQUESTED`, `COMMENTED`, `PENDING`, a dismissed review, no review, or a review on an older SHA does not satisfy the requirement.

The policy check state is:

| Condition | Check state |
| --- | --- |
| No-human policy route | `completed` / `success` |
| Every selected reviewer approved current head | `completed` / `success` |
| Any required approval is missing or changes were requested | `in_progress` / no conclusion |
| A human-review route has no eligible individual reviewer | `completed` / `failure` |
| TriagePilot cannot evaluate because of a permanent configuration, authorization, or GitHub API failure | `completed` / `failure` |

`in_progress` is used while the pull request is waiting for people. It blocks a required check without incorrectly representing an outstanding review as a failed build. GitHub App-created checks cannot use the GitHub Actions-only `pending` status.

Before completing a check as successful, the worker re-reads the pull request and verifies that it remains open and has the evaluated head SHA. If the head changed, it does not mark the old check successful; the new-head routing event owns the next check.

## Persistence And Idempotency

The implementation adds a new migration and persists enough policy state to locate and update one policy check per routing decision and head SHA. At minimum, this includes the routing-decision identity, repository identity, pull number, evaluated head SHA, selected individual reviewers, GitHub check-run identifier, and last evaluation state.

Webhook receipts and jobs retain their existing idempotency semantics. Repeated review events and worker retries update the same check run rather than creating duplicates. The adapter identifies the run by a stable external identifier derived from the routing decision.

Routing decisions remain the primary audit record. The dashboard should expose the policy-check state and the selected reviewers, including a concise reason when the check is waiting or failed.

## Error Handling

- A transient GitHub or database error retries through the existing worker retry policy.
- An exhausted retry, authorization failure, or invalid reviewer configuration records a permanent action failure and completes the policy check as `failure` when a check was created.
- If TriagePilot is unavailable, an in-progress required check naturally blocks merging rather than allowing a merge without evaluation.
- A check run must not be left incomplete indefinitely: the existing recovery path re-evaluates interrupted policy jobs. GitHub's check-run staleness behavior remains visible to users and is not masked by a scheduler.

## Testing And Documentation

Tests must cover:

- zero, one, and two selected individual reviewers;
- every selected reviewer approving the current head;
- an approval missing for one selected reviewer;
- a request-for-changes, dismissed review, comment-only review, and prior-head approval;
- a new head SHA resetting the policy requirement;
- duplicate review webhooks and worker retry idempotency;
- shadow mode and invalid team-handle configuration producing no GitHub writes;
- current-head races before a success update;
- organization filtering and webhook signature validation for `pull_request_review`.

Update the GitHub App setup and permissions documentation, repository-configuration reference, architecture documentation, and operations UI documentation. The user documentation must show the required ruleset configuration and explain that CodeRabbit and CI are separate required checks.

## Acceptance Criteria

- An enforce-mode low-risk pull request on the no-human policy route receives a successful `triagepilot/human-review-policy` check.
- An enforce-mode pull request with one or two selected individual reviewers cannot satisfy the check until every selected reviewer approves its current head SHA.
- A new head SHA cannot inherit policy approval from an earlier head SHA.
- Team handles are rejected as invalid policy configuration before any GitHub write.
- Reprocessing any delivery or job does not create duplicate reviewer requests or duplicate policy checks.
- A repository ruleset requiring this check blocks a pull request whenever the policy check is in progress or failed.
- Shadow mode continues to make no GitHub writes.
