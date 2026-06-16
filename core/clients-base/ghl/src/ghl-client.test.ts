import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createGhlClient, type GhlContact, type GhlOpportunity } from "./ghl-client.js";

function makeClient() {
  return createGhlClient({ token: "test-pit" });
}

function mockFetch(handler: (input: RequestInfo, init?: RequestInit) => Response | Promise<Response>) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => handler(input, init));
  vi.stubGlobal("fetch", stub);
  return stub;
}

function getUrl(input: RequestInfo): string {
  return typeof input === "string" ? input : input.url;
}

describe("ghl-client", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("getContact returns contact", async () => {
    const client = makeClient();
    mockFetch((input) => {
      const url = getUrl(input);
      expect(url).toContain("/contacts/c1");
      expect(url).toContain("location_id=loc1");
      return new Response(JSON.stringify({ id: "c1", firstName: "John" }), { status: 200 });
    });

    const contact = await client.getContact("loc1", "c1");
    expect(contact.firstName).toBe("John");
  });

  it("searchContacts returns array", async () => {
    const client = makeClient();
    mockFetch((input, init) => {
      expect(getUrl(input)).toContain("/contacts/search");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ contacts: [{ id: "c1", email: "a@b.com" }] }), { status: 200 });
    });

    const contacts = await client.searchContacts("loc1", { email: "a@b.com" });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe("a@b.com");
  });

  it("createContact returns existing when found", async () => {
    const client = makeClient();
    let searchCalled = false;
    mockFetch((input, init) => {
      const url = getUrl(input);
      if (url.includes("/contacts/search")) {
        searchCalled = true;
        return new Response(JSON.stringify({ contacts: [{ id: "c1", email: "a@b.com" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "c-new" }), { status: 201 });
    });

    const contact = await client.createContact("loc1", { email: "a@b.com", firstName: "John" });
    expect(searchCalled).toBe(true);
    expect(contact.id).toBe("c1");
  });

  it("createContact creates new when not found", async () => {
    const client = makeClient();
    mockFetch((input, init) => {
      const url = getUrl(input);
      if (url.includes("/contacts/search")) {
        return new Response(JSON.stringify({ contacts: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "c-new" }), { status: 201 });
    });

    const contact = await client.createContact("loc1", { email: "new@b.com" });
    expect(contact.id).toBe("c-new");
  });

  it("sendMessage sends via correct channel", async () => {
    const client = makeClient();
    mockFetch((input) => {
      expect(getUrl(input)).toContain("/conversations/messages");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await client.sendMessage("loc1", "c1", { message: "hello", channel: "sms" });
    expect(result).toEqual({ success: true });
  });

  it("getPipelineOpportunities returns opportunities", async () => {
    const client = makeClient();
    mockFetch((input) => {
      expect(getUrl(input)).toContain("/opportunities/search");
      return new Response(JSON.stringify({ opportunities: [{ id: "o1", pipelineStageId: "s1" }] }), { status: 200 });
    });

    const opps = await client.getPipelineOpportunities("loc1", "c1", "pipe1");
    expect(opps).toHaveLength(1);
  });

  it("updateOpportunityStage updates stage", async () => {
    const client = makeClient();
    mockFetch((input) => {
      expect(getUrl(input)).toContain("/opportunities/o1");
      return new Response(JSON.stringify({ id: "o1", pipelineStageId: "s2" }), { status: 200 });
    });

    const opp = await client.updateOpportunityStage("loc1", "o1", "s2");
    expect(opp.pipelineStageId).toBe("s2");
  });

  describe("updateOpportunityStageSafe downgrade guard", () => {
    const NEW_LEAD = "26763fc3-9013-42f6-a3cd-b254bf61f467";
    const AI_REPLIED = "6459bbb1-4517-4383-b4cb-dffe867f4c54";
    const HUMAN_TOUCH = "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4";
    const ELIGIBILITY_BOOKED = "b000d5c7-de71-4997-b263-74162c416736";

    it("always applies confirmed-booking target", async () => {
      const client = makeClient();
      mockFetch(() => new Response(JSON.stringify({ id: "o1", pipelineStageId: ELIGIBILITY_BOOKED }), { status: 200 }));

      const result = await client.updateOpportunityStageSafe("loc1", "o1", ELIGIBILITY_BOOKED, NEW_LEAD);
      expect(result.pipelineStageId).toBe(ELIGIBILITY_BOOKED);
      expect(result.skipped).toBeUndefined();
    });

    it("always applies HUMAN_TOUCH escalation and records escalatedAt", async () => {
      const client = makeClient();
      mockFetch(() => new Response(JSON.stringify({ id: "o1", pipelineStageId: HUMAN_TOUCH }), { status: 200 }));

      const result = await client.updateOpportunityStageSafe("loc1", "o1", HUMAN_TOUCH, NEW_LEAD);
      expect(result.pipelineStageId).toBe(HUMAN_TOUCH);
      expect(result.escalatedAt).toBe("2026-06-16T12:00:00.000Z");
    });

    it("prevents downgrade from confirmed-booking stage", async () => {
      const client = makeClient();
      mockFetch(() => new Response(JSON.stringify({ id: "o1", pipelineStageId: AI_REPLIED }), { status: 200 }));

      const result = await client.updateOpportunityStageSafe("loc1", "o1", AI_REPLIED, ELIGIBILITY_BOOKED);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("stage_downgrade_prevented");
      expect(result.pipelineStageId).toBe(ELIGIBILITY_BOOKED);
    });

    it("prevents downgrade from HUMAN_TOUCH stage", async () => {
      const client = makeClient();
      mockFetch(() => new Response(JSON.stringify({ id: "o1", pipelineStageId: AI_REPLIED }), { status: 200 }));

      const result = await client.updateOpportunityStageSafe("loc1", "o1", AI_REPLIED, HUMAN_TOUCH);
      expect(result.skipped).toBe(true);
      expect(result.pipelineStageId).toBe(HUMAN_TOUCH);
    });

    it("allows normal forward progression", async () => {
      const client = makeClient();
      mockFetch(() => new Response(JSON.stringify({ id: "o1", pipelineStageId: AI_REPLIED }), { status: 200 }));

      const result = await client.updateOpportunityStageSafe("loc1", "o1", AI_REPLIED, NEW_LEAD);
      expect(result.skipped).toBeUndefined();
      expect(result.pipelineStageId).toBe(AI_REPLIED);
    });

    it("does not regress BOOKED to PROSPECT_REPLIED", async () => {
      const client = makeClient();
      let updateCalled = false;
      mockFetch((input, init) => {
        if (init?.method === "PUT") {
          updateCalled = true;
        }
        return new Response(JSON.stringify({ id: "o1", pipelineStageId: AI_REPLIED }), { status: 200 });
      });

      const result = await client.updateOpportunityStageSafe("loc1", "o1", AI_REPLIED, ELIGIBILITY_BOOKED);
      expect(updateCalled).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("stage_downgrade_prevented");
      expect(result.pipelineStageId).toBe(ELIGIBILITY_BOOKED);
    });

    it("BOOKED contact with emergency still escalates to HUMAN_TOUCH", async () => {
      const client = makeClient();
      let updateCalled = false;
      let updateStageId: string | undefined;
      mockFetch((input, init) => {
        if (init?.method === "PUT") {
          updateCalled = true;
          const body = JSON.parse(init.body as string);
          updateStageId = body.pipelineStageId;
        }
        return new Response(JSON.stringify({ id: "o1", pipelineStageId: HUMAN_TOUCH }), { status: 200 });
      });

      const result = await client.updateOpportunityStageSafe("loc1", "o1", HUMAN_TOUCH, ELIGIBILITY_BOOKED);
      expect(updateCalled).toBe(true);
      expect(updateStageId).toBe(HUMAN_TOUCH);
      expect(result.pipelineStageId).toBe(HUMAN_TOUCH);
      expect(result.escalatedAt).toBe("2026-06-16T12:00:00.000Z");
    });
  });
});
