# GitHub App Permissions

## Repository Permissions

| Permission | Access | Reason |
| --- | --- | --- |
| Metadata | Read-only | Identify the installation and selected repositories |
| Contents | Read-only | Read `.github/triagepilot.yml` from the pull request's trusted base commit |
| Pull requests | Read and write | Verify the current head, request reviewers, or submit an approval pinned to the signed event head in enforce mode |
| Issues | Read and write | Create and synchronize the managed risk label, and upsert the routing comment in enforce mode |
| Checks | Read and write | Publish or update the routing check in enforce mode |
| Commit statuses | Read and write (`statuses:write`) | Let rulesets require `triagepilot/human-review-policy` from the expected TriagePilot App source |

## Events

- Pull requests
- Pull request review
- Installation
- Installation repositories

## Default Mode

New and missing configurations use shadow mode. Shadow mode computes and stores decisions without writing to GitHub; only `mode: enforce` in `.github/triagepilot.yml` at the trusted pull-request base commit permits writes. Configuration from an unmerged head commit is never used as write policy.

After adding or changing App permissions, approve the requested permission update for the existing organization installation. If GitHub does not offer an approval action, reinstall the App on the configured organization and reselect every repository this deployment should process. Do not enable enforce mode until the installation grants `statuses:write`.
