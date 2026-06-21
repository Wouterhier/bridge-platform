# GHL Hard-Won Facts — SCM Bridge
_Discovered 2026-06-21. Do not re-discover these._

## Message types
GHL sends `message.type` as a **NUMBER**, not a string.
Map: `{ 1: "Email", 2: "SMS", 3: "GMB", 11: "FB", 12: "Call", 18: "IG", 19: "WhatsApp", 29: "Live_Chat" }`
Handler: `normalizeMessageType(rawType)` in conversation-service.ts.

## Message ID
GHL workflow webhooks carry **no message id**. Synthesize a stable dedup key:
```ts
const bucket = Math.floor(Date.now() / 10000);
messageId = "syn-" + crypto.createHash("sha256").update(`${contactId}|${body}|${bucket}`).digest("hex").slice(0, 32);
```

## Guest Visitor
GHL creates a "Guest Visitor" placeholder contact before the real name is known.
Fix: call `ghl.updateContact()` after the state machine collects the real name/phone/email.

## Messages send endpoint
```
POST /conversations/messages
Version: 2021-04-15   ← NOT 2021-07-28 (that version 404s for messages)
Body: { type: "SMS"|"Live_Chat"|"WhatsApp"|"Email", contactId: "...", message: "..." }
```
- **No `conversationId`** needed. `contactId` works for all channels including Live_Chat.
- The `channel` field does NOT exist on this endpoint — use `type`.

## Opportunity create
`name` field is **required** by GHL for opportunity creation. Omitting it returns 422.
Use patient name if known, fall back to "New Lead".

## ESM bundle rule
The esbuild bundle uses `--packages=external`. Never use `require()` inside async callbacks.
All imports must be **top-level ESM** (`import ... from ...`) before bundling. Dynamic `require()` inside the bundle causes runtime errors.
