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

The server keeps a complete authorized open-PR list in a bounded process-local cache for one minute after acquisition; partial lists are cached for ten seconds. It displays the list first, then checks review status in bounded batches while the page is open. PRs still being checked are marked Checking; unavailable results remain unknown. Cache hits do not extend the list lifetime. Even on a hit, the server checks current workspace and connection authority and installation repository inventory; these metadata checks may contact GitHub. Open the page or select **Refresh** to acquire data; Refresh requests a fresh list and restarts review checks. The page requests successive review batches while statuses are being checked; it does not poll after checking finishes or when the page is closed.

**Last activity** uses GitHub's pull-request `updated_at`, which can reflect activity other than review work. It is not a precise waiting timer. The default order within each group is least recently updated first.

A partial result identifies incomplete repository or classification coverage. An unknown total or approval count is not zero, and missing repositories or review details must not be read as an empty queue. If a request fails, the page clears the snapshot and reports the error; a lost authorization does not leave old rows visible.
