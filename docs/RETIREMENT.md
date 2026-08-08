# Watchtower Retirement Record

Retired on 2026-08-08.

## What was retired

- The promise-classifier Watchtower website and its automatic Vercel deployments.
- The Mac mini repair worker and GitHub polling fallback.
- The Checkout GitHub webhook used for repair issue intake.
- Backend repair sweeps, runner claims, approval commands, and GitHub issue sync.

## What was preserved

- Existing product-local GitHub issues and their comments.
- Existing telemetry, repair cases, and historical evidence in the backend database.
- This repository and its repair-orchestrator documentation as read-only history.
- Mac mini launch configuration files with retirement timestamps for audit and recovery.

## Replacement direction

The replacement is a separate, read-only operational website focused on exact
backend API request outcomes. It should make non-2xx responses immediately
visible and searchable without exposing credentials or customer request bodies.

This archived application must not be used as the codebase for the replacement.
