# GitHub App Setup

Create a GitHub App that can be installed in the organization named by `GITHUB_ORGANIZATION`.

Set these URLs to your public TriagePilot origin:

- Homepage URL: `https://triage.example.com`
- Webhook URL: `https://triage.example.com/webhooks/github`

Generate a private key and choose a strong webhook secret.

Configure the permissions in [GitHub App permissions](permissions.md), including **Commit statuses: Read and write** (`statuses:write`). Subscribe the App to **Pull requests**, **Pull request review**, **Installation**, and **Installation repositories** events. The `Pull request review` subscription lets TriagePilot update its required human-review policy check after an individual reviewer approves, requests changes, or updates a review.

Set the App ID as `GITHUB_APP_ID`. Supply the generated private key through `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_FILE`, and the webhook secret through `GITHUB_WEBHOOK_SECRET` or `GITHUB_WEBHOOK_SECRET_FILE`. These values are read-only runtime configuration and are not stored in PostgreSQL.

Install the App in the one configured organization and choose **Only select repositories**. Select every repository this deployment should process. Events from a personal account or another organization are acknowledged without creating routing work.

For an existing installation, changing the App permissions is not sufficient on its own. Approve GitHub's requested permission update for the configured organization installation. If no approval action is available, reinstall the App and reselect the intended repositories. Confirm the installation grants `statuses:write` before enabling or resuming enforce mode.

Add `.github/triagepilot.yml` using the [repository configuration reference](repository-configuration.md). Repositories remain in shadow mode by default.

For enforce-mode repositories that use required human review, follow the [required human-review policy guide](required-human-review-policy.md) to configure the repository or organization ruleset. The status permission lets the ruleset pin `triagepilot/human-review-policy` to the expected **TriagePilot** source. TriagePilot does not create or edit GitHub rulesets.
