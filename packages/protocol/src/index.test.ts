import { describe, expect, it } from "vitest";

import {
  encodeInboxCursor,
  parseInboxCursor,
  ROUTE_CATALOGUE,
  DISCOVERY_DOCUMENT,
  OPENAPI_DOCUMENT,
  parseJoinRoomWithInviteRequest,
  presenceFor,
  PUBLIC_ID_PATTERN,
  SAFE_ERROR_MESSAGES,
  SNI_SECRET_PATTERN,
  SNK_SECRET_PATTERN,
  ProtocolValidationError,
  createErrorEnvelope,
  digestSecret,
  generatePublicId,
  generateRequestId,
  generateSecret,
  isPublicId,
  parseCreateRoomRequest,
  parsePostMessageRequest,
  parseStartInstanceRequest,
  verifySecretDigest,
} from "./index";

describe("public IDs and credentials", () => {
  it.each(["p", "key", "a", "i", "rom", "msg", "dec"] as const)(
    "generates an opaque %s ID with the normative format",
    (prefix) => {
      const id = generatePublicId(prefix);

      expect(id).toMatch(PUBLIC_ID_PATTERN);
      expect(isPublicId(id, prefix)).toBe(true);
      expect(isPublicId(id, prefix === "p" ? "a" : "p")).toBe(false);
    },
  );

  it("generates a request ID and both 256-bit secret formats", () => {
    expect(generateRequestId()).toMatch(/^req_[0-9A-Za-z]{10}$/);
    expect(generateSecret("snk")).toMatch(SNK_SECRET_PATTERN);
    expect(generateSecret("sni")).toMatch(SNI_SECRET_PATTERN);
  });

  it("digests and compares a secret without retaining the raw value", () => {
    const secret = generateSecret("sni");
    const digest = digestSecret(secret);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(secret);
    expect(verifySecretDigest(secret, digest)).toBe(true);
    expect(verifySecretDigest(generateSecret("sni"), digest)).toBe(false);
  });
});

describe("strict request parsing", () => {
  it("accepts only the bounded Instance registration payload", () => {
    expect(
      parseStartInstanceRequest({ runtime_kind: "codex", cli_version: "1.0.0" }),
    ).toEqual({ runtime_kind: "codex", cli_version: "1.0.0" });

    expect(() =>
      parseStartInstanceRequest({
        runtime_kind: "codex",
        cli_version: "1.0.0",
        provider_session_id: "must-not-be-uploaded",
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("rejects unknown Room fields and normalizes only the Room name", () => {
    expect(parseCreateRoomRequest({ name: "  Team\u212A  ", description: " keep " })).toEqual({
      name: "TeamK",
      description: " keep ",
    });

    expect(() => parseCreateRoomRequest({ name: "room", visibility: "public" })).toThrow(
      ProtocolValidationError,
    );
  });

  it("preserves Message content while enforcing whitespace and UTF-8 byte limits", () => {
    const content = "  hello, agents  \n";
    expect(parsePostMessageRequest({ content })).toEqual({ content });
    expect(() => parsePostMessageRequest({ content: "\u2003\n\t" })).toThrow(
      ProtocolValidationError,
    );
    expect(() => parsePostMessageRequest({ content: "😀".repeat(8_193) })).toThrow(
      ProtocolValidationError,
    );
    expect(parsePostMessageRequest({ content: "😀".repeat(8_192) }).content).toHaveLength(
      16_384,
    );
  });
});

describe("safe errors and public documentation", () => {
  it("uses static messages and never reflects credential fragments", () => {
    const secret = generateSecret("snk");
    const requestId = generateRequestId();
    const envelope = createErrorEnvelope("invalid_credentials", requestId);
    const serialized = JSON.stringify(envelope);

    expect(envelope.error.message).toBe(SAFE_ERROR_MESSAGES.invalid_credentials);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(0, 8));

    let validationError: unknown;
    try {
      parseStartInstanceRequest({
        runtime_kind: "codex",
        cli_version: "1.0.0",
        leaked_token: secret,
      });
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeInstanceOf(ProtocolValidationError);
    expect(String(validationError)).not.toContain(secret);
    expect(String(validationError)).not.toContain(secret.slice(0, 8));
  });

  it("publishes version-aligned discovery and OpenAPI documents", () => {
    expect(DISCOVERY_DOCUMENT.service).toBe("sharednet");
    expect(DISCOVERY_DOCUMENT.capabilities).toEqual([
      "identity.principal",
      "agents",
      "instances.lease",
      "rooms",
      "rooms.messages",
      "rooms.invites",
      "rooms.wait",
      "rooms.inbox",
      "decisions.approval",
      "decisions.text",
      "network",
    ]);
    expect(DISCOVERY_DOCUMENT.limits.wait_max_seconds).toBe(25);
    expect(DISCOVERY_DOCUMENT.limits.invite_default_seconds).toBe(0);
    expect(OPENAPI_DOCUMENT.info.version).toBe(DISCOVERY_DOCUMENT.protocol_version);
    expect(OPENAPI_DOCUMENT["x-sharednet-capabilities"]).toEqual(
      DISCOVERY_DOCUMENT.capabilities,
    );
    expect(OPENAPI_DOCUMENT.paths[DISCOVERY_DOCUMENT.openapi_url]).toBeDefined();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/messages"]).toBeDefined();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/wait"].get.security).toEqual([
      { instanceToken: [] },
      { roomMemberToken: [] },
    ]);
  });

  it("round-trips an inbox cursor and rejects anything that is not one", () => {
    const position = {
      created_at: "2026-09-05T12:00:00.000Z",
      room_id: "rom_AbCdEfGhIj",
      sequence: 7,
    } as const;
    const cursor = encodeInboxCursor(position);
    expect(cursor).toMatch(/^ibx_[A-Za-z0-9_-]+$/);
    expect(parseInboxCursor(cursor)).toEqual(position);
    expect(parseInboxCursor("7")).toBeNull();
    expect(parseInboxCursor("ibx_")).toBeNull();
    expect(parseInboxCursor(`ibx_${Buffer.from("not-a-date\nrom_AbCdEfGhIj\n1").toString("base64url")}`)).toBeNull();
    expect(parseInboxCursor(`ibx_${Buffer.from("2026-09-05T12:00:00.000Z\nmsg_x\n1").toString("base64url")}`)).toBeNull();
    expect(parseInboxCursor(`ibx_${Buffer.from("2026-09-05T12:00:00.000Z\nrom_AbCdEfGhIj\n0").toString("base64url")}`)).toBeNull();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/inbox"].get.security).toEqual([
      { instanceToken: [] },
      { roomMemberToken: [] },
    ]);
    expect(ROUTE_CATALOGUE.some((route) => route.operationId === "listInbox")).toBe(true);
  });

  it("derives presence from the last authenticated request, not a heartbeat", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    expect(presenceFor(null, now)).toBe("offline");
    expect(presenceFor("2026-09-05T11:59:30Z", now)).toBe("online");
    expect(presenceFor("2026-09-05T11:55:00Z", now)).toBe("away");
    expect(presenceFor("2026-09-05T11:00:00Z", now)).toBe("offline");
  });

  it("accepts a guest name as display text only: trimmed, bounded, no control characters", () => {
    expect(parseJoinRoomWithInviteRequest({ name: "  claude-code  " })).toEqual({ name: "claude-code" });
    expect(() => parseJoinRoomWithInviteRequest({ name: "" })).toThrow();
    expect(() => parseJoinRoomWithInviteRequest({ name: "a".repeat(65) })).toThrow();
    expect(() => parseJoinRoomWithInviteRequest({ name: "bad\u0000name" })).toThrow();
    expect(() => parseJoinRoomWithInviteRequest({ name: "x", extra: 1 })).toThrow();
  });
});
