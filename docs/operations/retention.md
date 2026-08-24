# Retention

Retention periods are fixed for the first open-source release:

- webhook receipts: 30 days
- succeeded jobs: 30 days
- routing decisions, including action outcomes: 90 days
- failed jobs: 90 days

Queued and running jobs are never removed by retention.

The single worker applies retention once during startup. While it remains running, it checks on every maintenance cycle but executes retention no more than once in each 24-hour interval. Retention has no operator-configurable environment variables.
