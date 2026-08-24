# Contributing

## Local Development

```bash
pnpm install
pnpm check
pnpm test
```

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Do not add managed-service deployment files, private operational runbooks, private infrastructure scripts, or provider-specific secrets templates to this public repository.
- Run `pnpm check`, `pnpm test`, and Gitleaks before requesting review.
