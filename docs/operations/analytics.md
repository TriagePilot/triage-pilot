# Analytics and reviewer backlog

Open **Analytics** in the administrator UI for two views: historical routing outcomes and current reviewer workload. The reusable UI exposes the same views through its host-supplied `AnalyticsApiClient`.

## Historical outcomes and estimate assumptions

History defaults to the last 30 days; rolling 7, 30, and 90-day periods end at a server-captured instant. The response exposes exact inclusive `start` and exclusive `end` UTC instants and UTC daily assignment buckets. History is bounded by the existing 90-day retention; it is not a lifetime record.

The comparison baseline is **one human reviewer per eligible PR**, regardless of previous customer rules. **Average review minutes** defaults to 30 and accepts whole numbers from 1 to 480. This is an editable estimate assumption in page/request state, not a saved preference or repository policy. It changes effort estimates, not routing or historical records. Hours describe estimated human review effort, not measured duration, elapsed delivery speed, or money saved.

For each PR, history selects its latest decision within the period, ordered by creation time and then decision ID, before filtering by mode or success. **Enforced outcomes** and **Shadow projections** are separate. Automatic mode chooses enforce when an assessed enforce decision exists, otherwise shadow. The UI retains the resolved choice until the user changes mode.

Assessed counts and risk distribution include valid assessments even if their routing action failed. The no-human share uses assessed PRs with known review requirements as its denominator. Savings use a separate eligible cohort: known policy quotas on valid assessments, and, for enforce, only successfully applied GitHub routing actions. Shadow savings are projections. The separate shortage disclosure counts latest assessed PRs in the selected mode with a persisted positive reviewer shortfall and sums their missing reviewers. It includes both zero-eligible and partially filled outcomes, even when they remain eligible for the shadow projection. Missing or malformed historical shortfalls are disclosed as unknown, independently of quota coverage; assignment totals never substitute for this evidence. Shadow mode has not enacted the projected savings or assignments. Configuration failures and unknown requirements are excluded from savings. A `no_eligible_reviewer` outcome still requires human review; selected-reviewer array length never substitutes for the policy quota.

For the eligible cohort:

- Baseline reviews = eligible PRs.
- Required reviews = sum of policy quotas (0, 1, or 2).
- Net fewer reviews = baseline reviews − required reviews.
- Estimated hours saved = net fewer reviews × average review minutes / 60.

For 100 eligible PRs, with 60 requiring zero reviews, 30 requiring one, and 10 requiring two, required reviews are `0 + 30 + 20 = 50`. That is 50 fewer reviews, a 50% reduction, and **25 h** at 30 minutes per review. A high-risk PR requiring two reviews contributes **−1** review against the one-reviewer baseline. Negative net savings remain visible as additional reviews and additional effort.

Assignments count distinct PR–reviewer pairs within the period and mode, including replacements. Repeated assignment of the same person to the same PR counts once, in the earliest qualifying UTC day. Two different reviewers on one PR count twice. Enforce assignments represent successful assignments; shadow assignments are proposed. Assignment totals and the latest-decision savings cohort answer different questions. Legacy decisions may lack identifiable PRs or original assignment snapshots; `coverage.unidentifiedDecisions` and `coverage.unknownOriginalAssignments` report that uncertainty rather than inventing historical coverage.

## Current workload and freshness

**Reviewer workload** counts actual pending GitHub review requests on open PRs tracked by TriagePilot during the last 90 days, within the selected repository scope. Manually added requests on tracked PRs count; never-assessed PRs do not. Current workload is independent of the historical date period and mode. Estimated review effort is pending requests × average review minutes / 60.

The UI shows the UTC observation time, tracked-since boundary, snapshot status, and covered/unavailable repository counts. Complete empty scope data is valid zero. Provider failures are unknown, not zero: partial or unavailable snapshots return null team and per-person totals and display **Unavailable**. Historical data can remain usable while live workload is unavailable.

Complete snapshots may be cached in process for at most 60 seconds. **Refresh current workload** requests a fresh acquisition. Reads use full pagination, at most four concurrent repository reads, and a total 10-second acquisition budget with cancellation. Membership and authority are revalidated even when provider responses are cached. There is no background promise that the page always reflects GitHub immediately.

## Backlog-aware routing

Initial routing and absence replacement compare current pending load within the eligible ownership pool. Matching owners remain preferred; a less-busy fallback never displaces an available preferred owner. Routing excludes the PR being routed or replaced from load comparisons. Use **All repositories** to inspect the load scope used by routing.

Author exclusion, existing approvals, reviewer availability, policy quotas, revision checks, and default shadow mode still apply. A transient load-read failure uses stable selection with explicit fallback provenance; it does not claim zero measured load. When a repository denies a backlog read, routing permits this fallback only after a fresh installation-token check succeeds; an unauthorized token or failed check remains an authorization failure. Authorization failures retain closed/retryable/terminal handling and cannot authorize writes. Recovery replays an already chosen result without fetching a new load or reselecting.

No additional GitHub permission or repository-YAML switch is required. Only trusted repository configuration can permit GitHub writes; changing an estimate or reading analytics never authorizes them.

## Authenticated API

The operations host exposes `GET /api/operations/analytics` for history and `GET /api/operations/analytics/workload` for current workload. Both require an administrator session and matching `x-triagepilot-workspace` header.

History accepts `periodDays=7|30|90` (default 30), `mode=auto|shadow|enforce` (default auto), repeated `repositoryId` values (internal scoped record IDs; omitted means all authorized repositories), and `averageReviewMinutes` (default 30). Current workload accepts the same repository and estimate fields plus `forceRefresh=true|false`; it does not accept historical period or mode.

History returns `query`, resolved `mode`, `start`, `end`, repository options, `counts`, `shortages`, `noHumanSharePercent`, `savings`, `assignments`, and `coverage`. Workload returns `status`, `observedAt`, `trackedSince`, `scope`, repository coverage IDs, `averageReviewMinutes`, `totalPending`, `totalEstimatedHours`, and reviewer `rows`. Unknown workload totals are null. Invalid queries return 400; inactive or inaccessible scope returns 404; other acquisition failures may return 503.

See [repository configuration](../github-app/repository-configuration.md), [reviewer availability](reviewer-availability.md), and [retention](retention.md).
