# TriagePilot repository setup prompt

Use this prompt with a coding assistant that can inspect your local repositories. It helps onboard repositories to an existing self-hosted TriagePilot deployment; to install TriagePilot first, follow the [quickstart](docs/self-hosting/quickstart.md).

Copy the entire text block into a new assistant conversation. Supply the local repository paths and deployed TriagePilot version when asked. Review the proposed YAML and example outcomes before accepting local edits. GitHub App selection, rulesets, merging configuration, and enforce activation remain manual steps.

```text
Help me onboard one or more local repositories to self-hosted TriagePilot. Inspect them, recommend repository-specific policy, and create or update local .triagepilot.yml files only after I accept the exact proposal. Start every proposed configuration in explicit mode: shadow.

Scope: repository onboarding for an existing deployment. Do not commit, push, open pull requests, change GitHub settings, deploy services, or activate enforce mode. Use read-only GitHub access if available. Keep credentials, private keys, tokens, and .env contents out of this conversation and configuration files.

1. Establish scope and documentation

Ask for any missing local repository paths, their GitHub owner/name and target branches, the deployment's configured GitHub organization, and its TriagePilot version (release tag, image version, or source commit; no credentials). Accept a single repository or multiple paths. Confirm each path is a repository and note its current branch and uncommitted changes. Keep a separate inventory and proposal per repository; do not assume they share policy or reviewers.

Fetch and read official documentation from https://github.com/TriagePilot/triage-pilot. Begin with https://github.com/TriagePilot/triage-pilot/blob/main/docs/README.md to locate the guides. When the deployed version is known, read the corresponding release tag or source commit instead of assuming main matches it; verify that the ref exists. Read these paths at that ref:
- docs/self-hosting/quickstart.md
- docs/github-app/repository-configuration.md
- docs/github-app/setup.md
- docs/github-app/permissions.md
- docs/github-app/required-human-review-policy.md
- docs/operations/shadow-to-enforce.md
- docs/operations/reviewer-availability.md

Report the documentation ref and links used. If the version is unknown, label main-based advice provisional and ask me to confirm compatibility before applying files. If fetching is unavailable or the matching ref cannot be found, ask me for the relevant documentation contents or a matching local TriagePilot source checkout. Continue independent repository inspection, but wait for authoritative configuration documentation before proposing executable YAML or writing files. Separate documented facts from assumptions and unavailable evidence.

One self-hosted deployment serves one configured GitHub organization and its selected repositories. Identify repositories from other organizations or personal accounts and explain that they are outside this deployment's supported boundary; do not silently include them. Separate supported organization groups and their deployment prerequisites.

2. Inspect each repository

Read repository guidance, directory structure, manifests, CI workflows, CODEOWNERS (including its location and matching semantics), and existing TriagePilot configuration. Inspect both root .triagepilot.yml and compatibility .github/triagepilot.yml, including relevant local changes. Consult available trusted-base versions and branch/ruleset information through read-only access. If GitHub access is unavailable, ask for sanitized policy details and mark installation, branch protection, reviewer eligibility, and remote configuration as unverified; local inspection can continue.

Summarize languages and services, generated files, tests, documentation, deployment and CI code, dependency files, migrations, authentication, authorization, billing, and other potentially sensitive paths that actually exist. Treat CODEOWNERS as evidence to discuss, not a configuration to translate blindly: its patterns, teams, and precedence need not match TriagePilot's ownership rules.

Explain configuration precedence and inheritance for the deployed version. In the current contract the root file wins over the compatibility fallback, and execution reads the trusted PR base revision. A new root file can therefore replace an existing compatibility policy. A repository document replaces organization/workspace policy unless inheritance: true is explicit. Obtain any applicable parent configuration or flag its contents as unknown. Inherited arrays merge by documented keys; empty arrays and null do not delete inherited entries. Explain the effective policy, including omissions that revert to defaults, before recommending a migration or inheritance change.

3. Resolve policy choices with me

Ask a concise set of repository-specific questions based on the inspection:
- Which paths or change types must receive human review, and which need two reviewers? Confirm the sensitive paths you found and ask about missing ones.
- Who owns those areas, and who can serve as fallback? Request confirmed individual GitHub handles and repository access. Teams and email addresses cannot be used as reviewer targets; ask for individual mappings rather than inventing identities or expanding teams silently. Keep unresolved identities as questions outside executable YAML.
- Which concrete changes, if any, are acceptable without human review? Discuss documentation-only, test-only, dependency, generated-file, and AI-authored changes separately, with examples relevant to this repository.
- Which target/source branches and drafts should be processed? Explain that exclusions skip routing and decision recording entirely; they are not a no-human approval policy.
- Is parent-policy inheritance intended, and are there existing ruleset requirements, owner-only approvals, fresh-review requirements, or reviewer availability constraints?

Recommend settings from those answers and the deployed schema, not a universal risk template. Explain that low risk means no human reviewer and a policy approval in enforce mode; shadow records projections without GitHub writes. Medium risk requires one human approval; high risk requires the configured one or two. Reviewer requests favor eligible owners and then fallbacks, exclude the author, and can fall short when people are unavailable. Availability is centrally administered, not repository YAML.

Distinguish routing from merge enforcement: selected reviewers are advisory targets, while any active individual human approval can satisfy the required human-review count. Do not promise owner-only approval, more than two reviewers, automatic fresh approval after every commit, or mandatory human review for every possible change through risk settings alone. Existing active approvals can count across new heads, and new commits do not automatically re-request reviewers. Explain unsupported requirements and leave activation blocked until I decide how another policy control will cover them.

4. Present a concrete proposal before editing

For each repository, show the complete proposed .triagepilot.yml, the intended diff or compatibility migration, the inheritance choice, and the significant defaults and tradeoffs. Use only fields supported by the versioned documentation. Explicit mode: shadow must override any inherited enforce value. Preserve existing intentional settings unless I accept changing them. Never write a partially resolved reviewer list or made-up placeholder handle as usable configuration.

Show a table of representative PRs with changed paths, file/line counts, relevant authorship assumptions, expected risk tier, proposed reviewer count, eligible ownership pool, and enforce-mode effect. Include an accepted no-human example if one exists, an ordinary code change, a sensitive-path change, a large change, and mixed documentation/code. Check path weights, threshold boundaries, size escalation, test-file treatment, and suppressor interactions against the deployed behavior; a weight alone does not guarantee a tier. Identify any no-human outcome outside my accepted cases and revise the proposal or explain the policy limitation.

Validate YAML and effective inheritance with the matching TriagePilot configuration resolver when a matching source checkout/tool is available. Check example outcomes with its risk scorer where available. Otherwise label them documentation-derived expectations and give manual validation steps; do not claim tests were run. Do not install arbitrary validators or present synchronized packages as a supported standalone setup CLI.

Stop here and ask me to accept the exact per-repository proposal, including any existing enforce-to-shadow change, before writing. Resolve missing required information first. Acceptance for one repository does not authorize edits to the others.

5. Apply accepted local configuration

Recheck local changes before editing. Create or update only the accepted canonical root .triagepilot.yml files with explicit mode: shadow. Preserve unrelated changes, comments where practical, and existing compatibility files unless their migration/removal was explicitly accepted. If both paths remain, explain which file is active and flag divergence. If files changed since the proposal, show the revised diff and obtain acceptance again.

Validate the final files with available version-matched tooling and report diagnostics, effective configuration, and validation limitations. Show the final diff and list exactly which repositories/files changed, which remain unresolved, and why. Leave the edits uncommitted.

6. Give a manual rollout and rollback checklist per repository

Tailor the checklist to the actual organization, repository, target branches, and existing checks:
- Select the repository in the organization's GitHub App installation, confirm documented permissions/events, and approve any installation permission update. Explain any missing deployment prerequisites without changing the deployment.
- Merge the shadow configuration through normal review. Confirm subsequent PR events use the trusted base containing it, then evaluate dashboard decisions against the proposed examples, reviewer eligibility/shortfalls, and actual team expectations. Shadow mode creates no GitHub writes or enforce policy check; do not require its check yet and block activation on unresolved mismatches.
- Explain the proposed GitHub ruleset changes for later enforcement. Where supported, require triagepilot/human-review-policy pinned to the TriagePilot App source; retain CI, CodeRabbit if used, and other independent checks. Conditional TriagePilot approval counts require native numeric approvals set to zero. Explain how that changes the existing protection and identify incompatible owner/freshness requirements before recommending it. The informational triagepilot/routing check is distinct. Arrange the manual transition so the enforce check is observed before making it required, with protection for the transition agreed by the administrator.
- After successful shadow evaluation and manual permission/policy checks, describe a separate reviewed change to mode: enforce in the active canonical file. Explain reviewer requests, policy approval, risk labels, routing comments/checks, and required-human-review evaluation as documented for that version. The activation PR uses its old base policy; confirm enforce behavior on a subsequent event whose base includes the merge.
- For rollback, describe a reviewed change back to explicit mode: shadow in the active root file. New events whose base includes that merge stop GitHub writes. Existing GitHub artifacts are not undone; a required enforce-only check can block merges in shadow. Tell the administrator how to restore the agreed native human-review protection and adjust the required TriagePilot check manually in a coordinated rollback. Removing the root file can reactivate a compatibility fallback or parent/default policy, so do not use deletion as a shortcut.

Finish with completed local work, unresolved questions, validation evidence, and the remaining manual GitHub steps. Do not perform those steps for me.
```
