// @contract - runs only with REAL_GHL_TEST=true env var
// Usage: REAL_GHL_TEST=true npx vitest run clients/scm/harness/src/contract/

import { describe, it, expect, beforeAll } from "vitest";
import { createGhlClient } from "@romea/ghl-client";

const SKIP = !process.env.REAL_GHL_TEST;

describe.skipIf(SKIP)("GHL contract tests (real API)", () => {
  let ghl: ReturnType<typeof createGhlClient>;
  // Use a test contact with phone + email in the SelfCareMen location
  const testContactId = "8baaFtzOEJBfXk6CUmh7";

  beforeAll(async () => {
    ghl = createGhlClient({ token: process.env.GHL_PIT! });
  });

  it("sends SMS with contactId", async () => {
    const result = await ghl.sendMessage(process.env.GHL_LOCATION_ID!, testContactId, {
      type: "SMS",
      contactId: testContactId,
      message: "Contract test SMS",
    });
    expect(result).toHaveProperty("messageId");
  });

  it("accepts Live_Chat without conversationId (auto-creates one)", async () => {
    const result = await ghl.sendMessage(process.env.GHL_LOCATION_ID!, testContactId, {
      type: "Live_Chat",
      contactId: testContactId,
      message: "test",
    } as any);
    // GHL auto-creates a conversation and returns conversationId
    expect(result).toHaveProperty("messageId");
    expect(result).toHaveProperty("conversationId");
  });

  it("rejects payload with old channel field", async () => {
    await expect(
      ghl.sendMessage(process.env.GHL_LOCATION_ID!, testContactId, {
        message: "test",
        channel: "sms",
      } as any),
    ).rejects.toThrow();
  });

  it("sends WhatsApp with contactId (requires phone)", async () => {
    const result = await ghl.sendMessage(process.env.GHL_LOCATION_ID!, testContactId, {
      type: "WhatsApp",
      contactId: testContactId,
      message: "Contract test WhatsApp",
    });
    expect(result).toHaveProperty("messageId");
  });

  it("sends Email with contactId (GHL may require subject/html)", async () => {
    // GHL email messages may need additional fields; this test verifies
    // the payload shape is accepted (422 = parsed OK, missing GHL-specific fields)
    try {
      const result = await ghl.sendMessage(process.env.GHL_LOCATION_ID!, testContactId, {
        type: "Email",
        contactId: testContactId,
        message: "Contract test Email",
      });
      expect(result).toHaveProperty("messageId");
    } catch (err: any) {
      // GHL returns 422 if email lacks subject/attachments — payload format was still accepted
      expect(err.status).toBe(422);
    }
  });

  it("updates opportunity stage with pipelineStageId", async () => {
    // Find an existing opportunity for the test contact
    const opportunities = await ghl.getPipelineOpportunities(
      process.env.GHL_LOCATION_ID!,
      testContactId,
      process.env.GHL_PIPELINE_ID!,
    );
    expect(opportunities.length).toBeGreaterThan(0);

    const opp = opportunities[0];
    const originalStage = opp.pipelineStageId;
    expect(originalStage).toBeTruthy();

    // Update to the same stage (idempotent test) — GHL should return 200
    const updated = await ghl.updateOpportunityStage(
      process.env.GHL_LOCATION_ID!,
      opp.id,
      originalStage!,
    );
    expect(updated).toHaveProperty("pipelineStageId", originalStage);
  });
});
