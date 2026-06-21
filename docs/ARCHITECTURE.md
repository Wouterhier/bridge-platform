# Architecture

## Pre-deploy gate (mandatory before tagging any release)

Before pushing a new version tag, run the contract tests against real APIs:

```bash
# Set real credentials in env
export REAL_GHL_TEST=true
export REAL_ACUITY_TEST=true
export REAL_STRIPE_TEST=true

npx vitest run clients/scm/harness/src/contract/ --reporter=verbose
```

All contract tests must pass. If any fail, DO NOT tag or deploy.

These tests are NOT in the fast CI loop (they hit real APIs and take 30-60s).
They run: before every new version tag, after any change to external client code.
