# @romea/bridge-platform

SelfCareMen bridge rebuild monorepo.

## Install

```bash
npm install
```

## Environment

Copy the example environment file and fill in values:

```bash
cp clients/scm/.env.example clients/scm/.env
```

Do not commit `.env` files.

## Swapping a model

Models are configured per role via env vars in `clients/<name>/.env`:
- `EXTRACT_MODEL` / `EXTRACT_FALLBACK_MODEL`
- `GENERATE_MODEL` / `GENERATE_FALLBACK_MODEL`

Format: `<provider>/<model-id>` (e.g. `google/gemini-3-flash-preview`, `dash_intl/glm-5.1`, `anth_api/claude-sonnet-4-6`).

1. Edit `clients/<name>/.env`
2. Run `npm run build` in the affected service
3. `systemctl restart selfcaremen-conversation selfcaremen-payment`

## Rollback

See `docs/rollback.md`. One-command summary:

```bash
cd /opt/bridge-platform
git fetch --tags
git checkout <previous-tag>
npm run build
systemctl restart selfcaremen-conversation selfcaremen-payment
```

## Adding a new client

1. Create a dedicated Postgres DB and non-owner app role.
2. Run `core/db` migrations against the new DB.
3. Create `clients/<name>/` with:
   - `.env` (gitignored)
   - `.env.example`
   - `kb/knowledge-base.md` (or set `KB_MODE=pgvector` for large KBs)
   - `flow/src/{states,validators,services,escalation-guard}.ts`
   - `service/` and `payment-service/` if needed
4. Reuse `core/{state-machine,model-router,providers,db,clients-base,cache}`.
5. Add Caddy routes on the droplet.
6. Add systemd units.

## Production builds

Production runs the **compiled `dist/` output from a tagged GitHub release**, not `tsx` from source.

Deployment steps:
1. Tag release: `git tag vX.Y.Z-<client>` && `git push --tags`
2. On SGP1: `git fetch --tags && git checkout vX.Y.Z-<client>`
3. `npm install && npm run build`
4. `systemctl restart selfcaremen-conversation selfcaremen-payment`

Never run `tsx src/index.ts` in production.

## Regression test harness

Run the consolidated regression suite:

```bash
npm run test:harness
```

Harness location: `clients/scm/harness/src/`
- `state-transitions.test.ts` — every edge in the SCM state machine
- `validators.test.ts` — all input validators
- `non-text-messages.test.ts` — system events, malformed payloads, images
- `production-bugs.test.ts` — race conditions, webhook security, recovery
- `style-and-held-language.test.ts` — message style rules across models

Additional coverage in sibling packages:
- `clients/scm/flow/src/{flow,validators,escalation-guard,extract,generate}.test.ts`
- `clients/scm/service/src/conversation-service.test.ts`
- `clients/scm/payment-service/src/payment-service.test.ts`
- `core/state-machine/src/engine.test.ts`
- `core/clients-base/ghl/src/ghl-client.test.ts`
