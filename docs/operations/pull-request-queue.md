# Open pull-request queue

After signing in with the shared administrator login, open **Pull requests** to see open pull requests across the GitHub App's currently selected repositories. The queue excludes draft pull requests and those authored by bots, and includes pull requests that have never been assessed, with no 90-day cutoff. Excluded pull requests do not incur assessment or review-detail reads. It is separate from Analytics and reviewer selection workload, which use the tracked 90-day population. The existing GitHub App permissions already include the reads used by the queue; no additional configuration is required.

The person filter matches a human author **or** a currently outstanding individual human review request. A person can match both roles. Completed reviews, issue assignees, bot review targets, and inferred team membership do not match the person filter. Outstanding team requests can still appear in the queue and its details. Repository, search, next-action, sort, and person filters apply to the same acquired snapshot.

## Groups and evidence

Each pull request appears in one group, with additional reasons shown in its details:

- **Waiting for reviewers**: individual human or team review requests are outstanding.
- **Waiting for authors**: a human reviewer requested changes and has not been requested to review again. A plain comment alone does not place the author here.
- **Needs a reviewer**: a current applied policy requires more human approvals and no human review request is outstanding.
- **Review policy met**: the live human approval count meets the current applied requirement. The policy check may still be updating.
- **Checking and unknown status**: pull requests whose review or applied policy status cannot be established, including those currently being checked.

Changes requested take precedence over other outstanding requests; concurrent requests and policy failures are shown as additional evidence. Current policy evidence requires a successful enforce-mode assessment for the current head and base, with lifecycle evidence that it belongs to the current open period. Missing, historical, failed, or incomplete evidence is not treated as a current applied policy. Shadow assessments are projections, not applied requirements. A terminally failed policy check remains unknown even if the live approval count meets the requirement. Review policy status does not establish that GitHub can merge the pull request: other checks, branch rules, and permissions may still apply.

## Freshness and coverage

The queue reads a durable database projection. The worker discovers the selected installation repositories and verifies their open pull requests and review details in the background. Existing pull request, review, and installation events prompt updates; a reconciliation runs every 15 minutes to repair missed events. Initial coverage can take time: until inventory is complete the total is unknown, and incomplete classifications remain unknown. Provider failures preserve previously verified rows and report partial coverage or a refresh error rather than implying an empty queue.

Last updated is the most recent complete inventory and classification verification, not the time the page was opened. Data is stale after 30 minutes without a complete verification or when the worker heartbeat is unavailable for 60 seconds. The page reads stored progress every two seconds during healthy active sync and every 30 seconds otherwise. After 120 seconds it stops the active indicator and reports the last progress; background work may continue. Polling pauses while the tab is hidden, on authority loss, or when the worker is unavailable. Refresh requests a coalesced reconciliation and is limited to one request per minute. It returns stored data immediately; it does not guarantee that GitHub has already been checked.

**Last activity** uses GitHub's pull-request `updated_at`, which can reflect activity other than review work. It is not a precise waiting timer. The default order within each group is least recently updated first.

A partial result identifies incomplete repository or classification coverage. An unknown total or approval count is not zero, and missing repositories or review details must not be read as an empty queue. If a request fails, the page reports the error and stops polling. A lost authorization clears the snapshot; other request failures leave the last displayed data visible with the error.
