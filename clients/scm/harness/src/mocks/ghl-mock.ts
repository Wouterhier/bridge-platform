import { vi } from "vitest";
import type { GhlMessagePayload } from "@romea/ghl-client";
import type { createGhlClient } from "@romea/ghl-client";

export function createMockGhlClient(): ReturnType<typeof createGhlClient> {
  return {
    getContact: vi.fn(async (_locationId: string, contactId: string) => ({
      id: contactId,
      firstName: "Test",
    })),
    searchContacts: vi.fn(async () => []),
    createContact: vi.fn(async (_locationId: string, payload: Record<string, unknown>) => ({
      id: `mock-contact-${Date.now()}`,
      ...payload,
    })),
    updateContact: vi.fn(async () => ({})),
    addContactTags: vi.fn(async () => ({})),
    removeContactTags: vi.fn(async () => ({})),
    sendMessage: vi.fn(async (_locationId: string, _contactId: string, payload: GhlMessagePayload) => {
      // Enforce real GHL contract
      if (!payload.type) throw new Error("GHL mock: type is required");
      if (!["SMS", "Live_Chat", "WhatsApp", "Email"].includes(payload.type))
        throw new Error(`GHL mock: invalid type "${payload.type}"`);
      if (payload.type === "Live_Chat" && !payload.conversationId)
        throw new Error("GHL mock: Live_Chat requires conversationId");
      if (payload.type !== "Live_Chat" && !payload.contactId)
        throw new Error(`GHL mock: ${payload.type} requires contactId`);
      // REJECT old channel field
      if ((payload as unknown as Record<string, unknown>).channel !== undefined)
        throw new Error("GHL mock: deprecated 'channel' field rejected — use 'type'");
      return { messageId: `mock-msg-${Date.now()}` };
    }),
    getPipelineOpportunities: vi.fn(async () => []),
    createOpportunity: vi.fn(async () => ({ id: `mock-opp-${Date.now()}` })),
    updateOpportunityStage: vi.fn(async () => ({ id: `mock-opp-${Date.now()}` })),
    updateOpportunityStageSafe: vi.fn(async () => ({ id: `mock-opp-${Date.now()}` })),
  } as unknown as ReturnType<typeof createGhlClient>;
}
