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
      // Real GHL accepts contactId-only for all channels including Live_Chat;
      // conversationId is optional (system resolves it internally).
      if (!payload.contactId)
        throw new Error(`GHL mock: ${payload.type} requires contactId`);
      // REJECT old channel field
      if ((payload as unknown as Record<string, unknown>).channel !== undefined)
        throw new Error("GHL mock: deprecated 'channel' field rejected — use 'type'");
      return { messageId: `mock-msg-${Date.now()}` };
    }),
    getPipelineOpportunities: vi.fn(async () => []),
    createOpportunity: vi.fn(async () => ({ id: `mock-opp-${Date.now()}` })),
    updateOpportunityStage: vi.fn(async (_locationId: string, _opportunityId: string, stageId: string) => {
      // Enforce real GHL contract: stageId must be a non-empty string (maps to pipelineStageId in body)
      if (!stageId || typeof stageId !== "string") throw new Error("GHL mock: updateOpportunityStage requires stageId string");
      return { id: `mock-opp-${Date.now()}`, pipelineStageId: stageId };
    }),
    updateOpportunityStageSafe: vi.fn(async (_locationId: string, _opportunityId: string, targetStageId: string, _currentStageId?: string, _escalationStageId?: string) => {
      // Enforce real GHL contract: targetStageId must be a non-empty string (maps to pipelineStageId in body)
      if (!targetStageId || typeof targetStageId !== "string") throw new Error("GHL mock: updateOpportunityStageSafe requires targetStageId string");
      return { id: `mock-opp-${Date.now()}`, pipelineStageId: targetStageId };
    }),
  } as unknown as ReturnType<typeof createGhlClient>;
}
