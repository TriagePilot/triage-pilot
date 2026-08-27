# Reviewer Availability

Reviewer availability is a central operations setting for the configured GitHub organization. It is not a `.github/triagepilot.yml` setting: repository ownership rules, fallback reviewers, risk scoring, reviewer caps, and branch exclusions continue to define who can be selected.

## Schedule an absence

Sign in as the administrator and use the **Reviewer availability** area of the operations dashboard. Set the one organization timezone to a valid IANA timezone, such as `Europe/Bratislava`, then record an individual GitHub handle and local start and end date-times. The same area lets the administrator edit an upcoming or active absence, or explicitly cancel it.

TriagePilot stores every absence boundary as an absolute UTC instant. The saved organization timezone controls local input and display only: changing it changes how an existing absence is presented, never when that absence starts or ends. An end time must be strictly after its start time, and overlapping scheduled absences for the same normalized handle are rejected.

An absence is active precisely when `start <= now < end`. It is upcoming before its start, ended at its end, and cancelled only after an administrator cancels it. When an absence ends, the reviewer becomes available naturally; no administrator action or end-of-absence job is needed.

## Effect on routing and policy

New routing decisions exclude active absences before the normal load-aware reviewer selection. Availability does not make anyone eligible, expand an ownership rule to its fallback, change risk, or otherwise alter repository configuration semantics.

At an absence start, TriagePilot evaluates only the latest open routed head whose human-review policy remains unsatisfied. It uses the decision's originally stored ownership-eligible pool, not later repository configuration. It does not replace an absent reviewer who already has an effective GitHub approval. An outstanding review request or a changes-requested review may be replaced.

Replacement selection excludes the pull-request author, people with effective approvals, people already in the current reviewer cohort, and people who are currently absent, then applies the existing deterministic, load-aware choice. If no eligible replacement remains after those exclusions within the original pool, TriagePilot records `no_replacement_available`, leaves the required approval count unchanged, and—in enforce mode—fails the human-review policy check with that reason. It never lowers the required count or selects someone outside the original eligible pool.

## Enforce mode and retries

Availability activation is a delayed PostgreSQL job. Before any enforce-mode mutation, the processor confirms that the pull request is still open and on the routed head, then reads the current GitHub reviews. The GitHub adapter separately inspects requested-reviewer state immediately before removing or requesting a reviewer. For a valid replacement, it performs this idempotent sequence:

1. Confirm the current pull-request and effective-review state.
2. Inspect requested-reviewer state and remove the absent reviewer's outstanding request when present.
3. Inspect requested-reviewer state and request the replacement only when absent.
4. Persist the replacement outcome and update the decision's active selected cohort.
5. Re-evaluate `triagepilot/human-review-policy`.

Retries derive the next safe action from current GitHub state, so a partial request-removal or request-addition can be retried. Transient failures use the ordinary durable-job retry flow. Permanent failures are recorded and keep the policy blocked; they do not weaken the requirement.

Shadow mode runs the same eligibility and replacement simulation and records its outcome, but makes zero GitHub writes.

## Review the history

Each absence displays its replacement history in the operations dashboard. The history links affected pull requests and records the replacement, if any, plus the outcome and reason. It explains successful replacements, simulated replacements, unavailable replacements, and skipped cases such as an already-approved reviewer, closed pull request, changed head, or already-satisfied policy. It also records permanent failures, so operators can investigate without reconstructing worker activity from logs.
