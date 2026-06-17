/**
 * SelfCareMen Regression Test Harness
 *
 * This package consolidates all critical regression tests for the SCM bridge.
 *
 * Run via:
 *   npm run test:harness        (from repo root)
 *   npx vitest run              (from this package)
 *
 * Test coverage:
 * - state-transitions.test.ts   : every edge in the SCM state machine
 * - validators.test.ts          : all input validators
 * - non-text-messages.test.ts   : system events, malformed payloads, images
 * - production-bugs.test.ts     : race conditions, webhook security, recovery
 * - style-and-held-language.test.ts : message style rules across models
 * - payment-url.test.ts            : payment URL injection and stripping
 *
 * Additional coverage exists in sibling packages:
 * - clients/scm/flow/src/flow.test.ts            : flow happy path & failures
 * - clients/scm/flow/src/validators.test.ts      : validator unit tests
 * - clients/scm/flow/src/escalation-guard.test.ts : escalation logic
 * - clients/scm/flow/src/extract.test.ts         : AI extraction accuracy
 * - clients/scm/flow/src/generate.test.ts        : style lint, cache billing
 * - clients/scm/service/src/conversation-service.test.ts : E2E, dedup, holding
 * - clients/scm/payment-service/src/payment-service.test.ts : paid path, webhook
 * - core/state-machine/src/engine.test.ts        : generic engine behaviour
 * - core/clients-base/ghl/src/ghl-client.test.ts : downgrade guard
 */

export const HARNESS_VERSION = "1.0.0";
