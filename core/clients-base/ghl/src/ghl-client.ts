import { Buffer } from "node:buffer";

export interface GhlClientConfig {
  token: string;
  baseUrl?: string;
  version?: string;
  stageRank?: string[];
  confirmedBookingStageIds?: string[];
  humanTouchStageIds?: string[];
}

export interface GhlContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  [key: string]: unknown;
}

export interface GhlContactPayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  [key: string]: unknown;
}

export interface GhlOpportunity {
  id: string;
  pipelineId?: string;
  pipelineStageId?: string;
  contactId?: string;
  locationId?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export interface GhlMessagePayload {
  message: string;
  channel: "sms" | "email" | "live_chat" | "whatsapp";
}

export interface GhlOpportunityPayload {
  pipelineId: string;
  pipelineStageId: string;
  locationId: string;
  contactId: string;
  name?: string;
  status?: "open" | "won" | "lost" | "abandoned";
  [key: string]: unknown;
}

export interface GhlStageUpdateResult extends GhlOpportunity {
  skipped?: boolean;
  reason?: string;
  escalatedAt?: string;
}

const DEFAULT_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_VERSION = "2021-07-28";

// Default SelfCareMen stage ordering: earlier = lower rank.
const DEFAULT_STAGE_RANK: string[] = [
  "26763fc3-9013-42f6-a3cd-b254bf61f467", // NEW_LEAD
  "6459bbb1-4517-4383-b4cb-dffe867f4c54", // AI_REPLIED / PROSPECT_REPLIED
  "474fb4f1-1d8e-4926-8fa9-aca013589f73", // NATURAL_ENDING
  "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4", // HUMAN_TOUCH
  "a694f7ba-9c07-4cb5-9eca-f540bc99d5f1", // DND / UNQUALIFIED
  "b000d5c7-de71-4997-b263-74162c416736", // BOOKED / ELIGIBILITY_BOOKED
  "750a6c84-d60f-424a-ac88-876d06fa362d", // PAID_BOOKED
];

const DEFAULT_CONFIRMED_BOOKING_STAGE_IDS: string[] = [
  "b000d5c7-de71-4997-b263-74162c416736", // Eligibility Appointment Scheduled (AI)
  "750a6c84-d60f-424a-ac88-876d06fa362d", // Initial Consultation Scheduled
];

const DEFAULT_HUMAN_TOUCH_STAGE_IDS: string[] = [
  "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4", // HUMAN_TOUCH
];

export function createGhlClient(config: GhlClientConfig) {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const token = config.token;
  const version = config.version ?? DEFAULT_VERSION;
  const stageRank = config.stageRank ?? DEFAULT_STAGE_RANK;
  const confirmedBookingStageIds =
    config.confirmedBookingStageIds ?? DEFAULT_CONFIRMED_BOOKING_STAGE_IDS;
  const humanTouchStageIds =
    config.humanTouchStageIds ?? DEFAULT_HUMAN_TOUCH_STAGE_IDS;

  if (!token) {
    throw new Error("GHL_PIT (Private Integration Token) is required");
  }

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Version: version,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(path, baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }

    const init: RequestInit = {
      method,
      headers: headers(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), init);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new GhlApiError(
        `GHL API error: ${response.status} ${response.statusText}`,
        response.status,
        data,
      );
    }
    return data as T;
  }

  function stageRankOf(stageId: string | undefined): number {
    if (!stageId) return -1;
    const idx = stageRank.indexOf(stageId);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  }

  function isConfirmedBooking(stageId: string | undefined): boolean {
    return !!stageId && confirmedBookingStageIds.includes(stageId);
  }

  function isHumanTouch(stageId: string | undefined): boolean {
    return !!stageId && humanTouchStageIds.includes(stageId);
  }

  return {
    async getContact(
      locationId: string,
      contactId: string,
    ): Promise<GhlContact> {
      return request<GhlContact>("GET", `/contacts/${contactId}`, undefined, {
        location_id: locationId,
      });
    },

    async searchContacts(
      locationId: string,
      options: { email?: string; phone?: string } = {},
    ): Promise<GhlContact[]> {
      const body: Record<string, unknown> = { locationId };
      if (options.email) body.email = options.email;
      if (options.phone) body.phone = options.phone;

      const result = await request<{ contacts?: GhlContact[] }>(
        "POST",
        "/contacts/search",
        body,
      );
      return result.contacts ?? [];
    },

    async createContact(
      locationId: string,
      payload: GhlContactPayload,
    ): Promise<GhlContact> {
      const search = await this.searchContacts(locationId, {
        email: payload.email,
        phone: payload.phone,
      });
      const existing = search[0];
      if (existing) return existing;

      return request<GhlContact>("POST", "/contacts/", {
        ...payload,
        locationId,
      });
    },

    async updateContact(
      locationId: string,
      contactId: string,
      payload: GhlContactPayload,
    ): Promise<GhlContact> {
      return request<GhlContact>("PUT", `/contacts/${contactId}`, payload, {
        location_id: locationId,
      });
    },

    async addContactTags(
      locationId: string,
      contactId: string,
      tags: string[],
    ): Promise<GhlContact> {
      return request<GhlContact>("PUT", `/contacts/${contactId}`, { tags }, {
        location_id: locationId,
      });
    },

    async removeContactTags(
      locationId: string,
      contactId: string,
      tags: string[],
    ): Promise<GhlContact> {
      return request<GhlContact>("DELETE", `/contacts/${contactId}/tags`, { tags }, {
        location_id: locationId,
      });
    },

    async sendMessage(
      locationId: string,
      contactId: string,
      { message, channel }: GhlMessagePayload,
    ): Promise<unknown> {
      return request<unknown>("POST", "/conversations/messages", {
        locationId,
        contactId,
        message,
        channel,
      });
    },

    async getPipelineOpportunities(
      locationId: string,
      contactId: string,
      pipelineId?: string,
    ): Promise<GhlOpportunity[]> {
      const query: Record<string, string | undefined> = {
        location_id: locationId,
        contact_id: contactId,
      };
      if (pipelineId) query.pipeline_id = pipelineId;

      const result = await request<{ opportunities?: GhlOpportunity[] }>(
        "GET",
        "/opportunities/search",
        undefined,
        query,
      );
      return result.opportunities ?? [];
    },

    async createOpportunity(
      locationId: string,
      payload: GhlOpportunityPayload,
    ): Promise<GhlOpportunity> {
      return request<GhlOpportunity>("POST", "/opportunities/", {
        ...payload,
        locationId,
      });
    },

    async updateOpportunityStage(
      locationId: string,
      opportunityId: string,
      stageId: string,
    ): Promise<GhlOpportunity> {
      return request<GhlOpportunity>(
        "PUT",
        `/opportunities/${opportunityId}`,
        { pipelineStageId: stageId },
        { location_id: locationId },
      );
    },

    /**
     * Stage update with downgrade guard.
     *
     * - Confirmed-booking stages always apply.
     * - HUMAN_TOUCH escalation always applies and records `escalated_at`.
     * - Otherwise, do not regress from a confirmed-booking stage or HUMAN_TOUCH
     *   to an earlier stage (as defined by `stageRank`).
     */
    async updateOpportunityStageSafe(
      locationId: string,
      opportunityId: string,
      targetStageId: string,
      currentStageId?: string,
      escalationStageId?: string,
    ): Promise<GhlStageUpdateResult> {
      const targetIsBooking = isConfirmedBooking(targetStageId);
      const targetIsHumanTouch = isHumanTouch(targetStageId);

      if (currentStageId) {
        const currentIsBooking = isConfirmedBooking(currentStageId);
        const currentIsHumanTouch = isHumanTouch(currentStageId);
        const targetRank = stageRankOf(targetStageId);
        const currentRank = stageRankOf(currentStageId);

        const isDowngrade =
          !targetIsBooking && !targetIsHumanTouch && targetRank < currentRank;

        if ((currentIsBooking || currentIsHumanTouch) && isDowngrade) {
          return {
            id: opportunityId,
            pipelineStageId: currentStageId,
            skipped: true,
            reason: "stage_downgrade_prevented",
          } as GhlStageUpdateResult;
        }
      }

      const updated = await this.updateOpportunityStage(
        locationId,
        opportunityId,
        targetStageId,
      );

      if (targetIsHumanTouch || targetStageId === escalationStageId) {
        (updated as GhlStageUpdateResult).escalatedAt = new Date().toISOString();
      }

      return updated as GhlStageUpdateResult;
    },
  };
}

export class GhlApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: unknown,
  ) {
    super(message);
    this.name = "GhlApiError";
  }
}

export function ghlClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof createGhlClient> {
  const token = env.GHL_PIT ?? "";
  return createGhlClient({ token });
}
