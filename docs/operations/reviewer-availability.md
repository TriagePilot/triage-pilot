# Reviewer Availability

Reviewer availability is centralized operational state for the current workspace and provider connection. In self-hosted OSS, that is the deployment's deterministic local workspace for the configured GitHub organization. It is not a `.triagepilot.yml` or `.github/triagepilot.yml` setting: repository ownership rules, fallback reviewers, risk scoring, reviewer caps, and branch exclusions continue to define who can be selected. TriagePilot never edits or commits repository configuration from this screen.

## Schedule an absence

Sign in as the administrator and use the **Reviewer availability** area of the operations dashboard. Set the workspace timezone to a valid canonical IANA timezone, such as `Europe/Bratislava`, then record an individual GitHub handle and local start and end date-times. The same area lets the administrator edit an upcoming or active absence, or explicitly cancel it. Actor identifiers are trimmed, normalized to lowercase, and scoped to the active GitHub connection.

TriagePilot stores every absence boundary as an absolute UTC instant. The saved workspace timezone controls local input and display only: changing it changes how an existing absence is presented, never when that absence starts or ends. An end time must be strictly after its start time, and overlapping non-cancelled absences for the same normalized actor in the same workspace and provider connection are rejected.

Local times follow the timezone's real daylight-saving rules:

- A wall time skipped by a spring-forward transition is rejected as nonexistent.
- A wall time repeated by a fall-back transition is rejected until its matching UTC offset, such as `+02:00` or `+01:00`, is supplied explicitly.
- An offset that is valid syntax but does not match that wall time is rejected.

The form retains the entered values after a validation error. While an absence is being edited, the timezone cannot change; the edit carries the original exact offsets so saving it cannot silently move either UTC instant.

An absence is active precisely when `start <= now < end`. It is upcoming before its start, ended at its end, and cancelled only after an administrator cancels it. Create, edit, and cancel operations are serialized in the UI and use an expected revision, so a stale response cannot overwrite newer state. Each create or edit transaction saves the new revision together with a revision-specific delayed activation job; cancellation invalidates older queued revisions. When an absence ends, the reviewer becomes eligible for future routing naturally; no administrator action, cohort-restoration write, or end-of-absence job is performed.

## Effect on routing and policy

New routing decisions exclude active absences before the normal load-aware reviewer selection. Availability does not make anyone eligible outside the configured ownership rules and fallback pool, change risk, or otherwise alter repository configuration semantics. When active absences leave too few matching ownership reviewers, configured fallback reviewers may fill the remaining quota without displacing another available matching owner.

At an absence start, TriagePilot evaluates only the latest open routed head whose human-review policy remains unsatisfied. It uses the decision's originally stored ownership-eligible pool, not later repository configuration. A configuration change after the decision therefore cannot expand replacement eligibility. It does not replace an absent reviewer who already has an effective GitHub approval. An outstanding review request or a changes-requested review may be replaced.

Replacement selection excludes the pull-request author, people with effective approvals, people already in the current reviewer cohort, and people who are currently absent. It prefers another available reviewer from the original matching ownership rules, then uses the deterministic, load-aware choice within that preferred pool; configured fallbacks are considered only when the preferred pool is exhausted. If no eligible replacement remains after those exclusions within the original pool, TriagePilot records `no_replacement_available`, leaves the required approval count unchanged, and—in enforce mode—fails the human-review policy check with that reason. It never lowers the required count or selects someone outside the original eligible pool.

## Outcomes, enforce mode, and retries

Availability activation is a delayed PostgreSQL job. Before any enforce-mode mutation, the processor confirms that the pull request is still open and on the routed head, then reads the current GitHub reviews. The GitHub adapter separately inspects requested-reviewer state immediately before removing or requesting a reviewer. For a valid replacement, it performs this idempotent sequence:

1. Confirm the current pull-request and effective-review state.
2. Inspect requested-reviewer state and remove the absent reviewer's outstanding request when present.
3. Inspect requested-reviewer state and request the replacement only when absent.
4. Persist the replacement outcome and update the decision's active selected cohort.
5. Re-evaluate `triagepilot/human-review-policy`.

The recorded outcomes are `replaced`, `simulated_replacement`, `no_replacement_available`, `skipped_approved`, `skipped_closed`, `skipped_changed_head`, `skipped_policy_satisfied`, and `permanent_failure`. Stale revisions and cancelled absences are successful job no-ops rather than replacement records.

Before persistence, the worker locks and revalidates the job lease, absence revision and actor, live connection authority, current head, approvals, cohort membership, policy status, and candidate availability. Provider mutation intent is stored durably before dispatch. Retries derive the next safe action from current GitHub state, so a partial request-removal or request-addition can be retried. If GitHub was changed but result persistence or policy finalization failed, the durable recovery path finishes only the mapped persistence/finalizer phases; it never repeats selection or an already-authorized provider mutation. Transient failures use the ordinary durable-job retry flow. Permanent provider or finalizer failures are recorded with their error and keep the policy blocked; they do not weaken the requirement.

Shadow mode runs the same eligibility and replacement simulation and records its outcome, but makes zero GitHub writes, including during retries and finalizer replay.

Enforce-mode replacement requires the GitHub App's **Pull requests: Read and write** permission. Policy reevaluation additionally requires **Commit statuses: Read and write** (`statuses:write`). Existing installations must approve changed permissions before enforce mode resumes; see [GitHub App permissions](../github-app/permissions.md).

## Review the history

Each absence displays its replacement history in the operations dashboard, including the replacement, if any, plus the outcome and reason. It explains successful replacements, simulated replacements, unavailable replacements, and skipped cases such as an already-approved reviewer, closed pull request, changed head, or already-satisfied policy. The operations API retains the affected decision identity and durable replacement state. A `permanent_failure` entry retains the sanitized failure detail for investigation without reconstructing worker activity from logs; if troubleshooting SQL shows `finalizer_pending`, provider effects may already exist and recovery still has persistence or policy work to finish. See [job troubleshooting](../troubleshooting/jobs.md) before manually re-running routing.
