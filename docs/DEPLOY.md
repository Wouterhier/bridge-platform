# SCM Bridge — Deploy & Rollback

## MANDATORY RULES
1. **Every deploy = a git tag.** Format: `v{major}.{minor}.{patch}-scm-bridge`
2. **Every tag has annotated notes** explaining what changed
3. **Deploy ONLY via systemd.** Never use nohup, never kill PIDs manually.
4. **Test before tagging.** Tag = "this was deployed and verified"

## Deploy a new version
```bash
cd /root/.openclaw/bridge-platform
git tag -a v0.X.Y-scm-bridge -m "v0.X.Y-scm-bridge — what changed"
git push --tags

cd /opt/bridge-platform
git fetch --tags
git checkout v0.X.Y-scm-bridge
cd clients/scm/service && npm run build
cd ../payment-service && npm run build
cd /opt/bridge-platform

systemctl restart selfcaremen-conversation selfcaremen-payment
sleep 3
curl -s http://localhost:3204/health
curl -s http://localhost:3205/health
```

## Rollback to any previous version
```bash
cd /opt/bridge-platform
git checkout v0.X.Y-scm-bridge   # the version to roll back to
cd clients/scm/service && npm run build
cd ../payment-service && npm run build
systemctl restart selfcaremen-conversation selfcaremen-payment
```

## Check what's deployed
```bash
git -C /opt/bridge-platform describe --tags
systemctl status selfcaremen-conversation --no-pager | head -5
systemctl status selfcaremen-payment --no-pager | head -5
```

## Version history
| Tag | Date | Notes |
|-----|------|-------|
| v0.1.15-scm-bridge | 2026-06-21 | Voice rewrite, stable checkpoint |
| v0.2.0-scm-bridge | 2026-06-22 | 8-step flow enforcement spec build |
| v0.2.1-scm-bridge | 2026-06-22 | Defense-in-depth gate + tests |
| v0.2.2-scm-bridge | 2026-06-22 | Paid path gate + channel fix |
| v0.2.3-scm-bridge | 2026-06-22 | Sanitizer, shortener, format fixes |
| v0.3.0-scm-bridge | 2026-06-24 | DOB ambiguity, opp name, systemd fix |

## Services
- `selfcaremen-conversation` — port 3204, systemd managed
- `selfcaremen-payment` — port 3205, systemd managed
- Working dir: `/opt/bridge-platform/clients/scm/{service,payment-service}`
- Env: `/opt/bridge-platform/clients/scm/.env`
- Logs: `/var/log/scm-conversation.log`, `/var/log/scm-payment.log`

## NEVER DO
- `nohup node dist/index.js &` — conflicts with systemd Restart=always
- `kill <pid>` — use `systemctl restart` instead
- Push to main and deploy without tagging
- Deploy untested code to production
