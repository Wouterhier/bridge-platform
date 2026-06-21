# Rollback Procedure

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

## One-command summary

```bash
cd /opt/bridge-platform
git fetch --tags
git checkout <previous-tag>
npm run build
systemctl restart selfcaremen-conversation selfcaremen-payment
```

## Detailed steps

1. **Identify the last known good tag:**
   ```bash
   git tag -l 'v*' --sort=-v:refname | head -5
   ```

2. **Checkout the tag:**
   ```bash
   git fetch --tags
   git checkout vX.Y.Z-scm
   ```

3. **Rebuild:**
   ```bash
   npm install
   npm run build
   ```

4. **Restart services:**
   ```bash
   systemctl restart selfcaremen-conversation selfcaremen-payment
   ```

5. **Verify health:**
   ```bash
   curl -s http://localhost:3000/health | jq .
   curl -s http://localhost:3001/health | jq .
   ```

## Emergency brake

If the deployment is completely broken and you need to stop traffic immediately:

```bash
systemctl stop selfcaremen-conversation selfcaremen-payment
```

The GHL webhook will queue messages and retry. Restart when ready.
