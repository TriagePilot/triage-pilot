# Deployment Overlays

The public repository is complete for Docker Compose self-hosting.

Provider-specific managed deployments should live in a separate repository. An overlay may contain infrastructure code, provider adapters, deployment scripts, monitoring configuration, and private runbooks while consuming the public TriagePilot packages and container image.

Do not add provider credentials, private infrastructure, hosted-service runbooks, or environment-specific secrets templates to this repository.
