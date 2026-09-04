import { describe, expect, it } from "vitest";

import {
  DISCOVERY_DOCUMENT,
  OPENAPI_DOCUMENT,
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
      "decisions.approval",
      "decisions.text",
      "network",
    ]);
    expect(OPENAPI_DOCUMENT.info.version).toBe(DISCOVERY_DOCUMENT.protocol_version);
    expect(OPENAPI_DOCUMENT["x-sharednet-capabilities"]).toEqual(
      DISCOVERY_DOCUMENT.capabilities,
    );
    expect(OPENAPI_DOCUMENT.paths[DISCOVERY_DOCUMENT.openapi_url]).toBeDefined();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/messages"]).toBeDefined();
  });
});
