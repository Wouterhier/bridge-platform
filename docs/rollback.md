# Rollback Procedure

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
