# TriagePilot

TriagePilot is self-hosted GitHub pull request reviewer routing based on change risk, code ownership, and reviewer availability.

It is for GitHub teams whose ownership rules, reviewer absences, or reviewer-selection decisions have become difficult to manage manually.

Your first outcome is an inspectable routing decision in the operations dashboard, recorded in **shadow mode without GitHub writes**. Review the decision before choosing whether to enable enforce mode.

**[Run TriagePilot in shadow mode](docs/self-hosting/quickstart.md)**

You need Docker Engine with Docker Compose v2 and permission to create and install an organization GitHub App with the [required permissions](docs/github-app/permissions.md). The supported stack runs `web`, exactly one `worker`, and PostgreSQL; one deployment serves one GitHub organization and its selected repositories.

## Get help

- [Setup help](https://github.com/TriagePilot/triage-pilot/issues/new?template=setup-help.yml) for installation and configuration problems.
- [Report a bug](https://github.com/TriagePilot/triage-pilot/issues/new?template=bug-report.yml) for product behavior, routing, or documentation problems.
- [Request a feature](https://github.com/TriagePilot/triage-pilot/issues/new?template=feature-request.yml) to describe a workflow need.
- [Private security reporting](SECURITY.md): follow the security policy; do not post suspected vulnerabilities in public issues.

Sanitize diagnostics before sharing. Exclude credentials, private keys, tokens, webhook payloads, and confidential pull request contents. Reports and feedback are welcome; external code and documentation contributions remain [closed](CONTRIBUTING.md).

## Why this exists / alternatives

Manual assignment can be sufficient when a team can readily identify an available reviewer. CODEOWNERS can be sufficient when file ownership is the main input to reviewer requests.

Evaluate TriagePilot when reviewer selection needs to combine changed-file ownership, reviewer availability, and change risk. Shadow mode lets you inspect its decisions against your team's expectations before enabling supported GitHub writes. It does not replace your team's review judgment or branch protection.

## Deployment Model

The supported public deployment is Docker Compose with `web`, exactly one `worker`, and PostgreSQL. One deployment manages one configured GitHub organization and multiple selected repositories in that organization. The administrator operates the deployment's deterministic local workspace; repository policy remains file-managed, while reviewer availability is centralized operational state.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Repository configuration](docs/github-app/repository-configuration.md)
- [Reviewer availability](docs/operations/reviewer-availability.md)
- [Job troubleshooting and routing recovery](docs/troubleshooting/jobs.md)
- [Required human-review policy](docs/github-app/required-human-review-policy.md)
- [Shadow-to-enforce rollout](docs/operations/shadow-to-enforce.md)
- [Release checklist](docs/self-hosting/release-checklist.md)

## License

Original TriagePilot code is released under the Functional Source License, Version 1.1, Apache 2.0 Future License (`FSL-1.1-Apache-2.0`). Current public versions are Fair Source and source-available, not OSI-approved open source.

Organizations may use, modify, and self-host TriagePilot for their own internal use and access. During a version's FSL period, licensees may not make that version available to others in a competing commercial product or service as defined by the complete [license](LICENSE). This is not a blanket prohibition on commercial use.

Each public version becomes available under Apache License 2.0 on the second anniversary of the date that version is made available. Public Git commits, packages, images, and releases can each establish availability; release manifests record artifact publication dates for provenance and do not delay a source-availability date already recorded in Git history.

The public repository's product is the self-hosted application. Synchronized registry packages are public release artifacts required by the private SaaS dependency boundary; they are not a separately supported SDK, plugin platform, or community extension surface. The separate private SaaS repository remains proprietary and does not convert to Apache 2.0 under this policy.
