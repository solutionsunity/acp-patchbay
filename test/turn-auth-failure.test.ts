// The turn-auth-failure door is shape-gated: -32603 AND an auth-classified
// `data.errorKind`. Everything else — including the spec's own -32000, which
// pool.ts reads without this module — is null.
import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { turnAuthFailureReasonOf } from "../src/orchestrator/extensions/turn-auth-failure";

const EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

describe("turnAuthFailureReasonOf", () => {
  it("reads an internal error classified authentication_failed as the auth reason, minus the SDK framing", () => {
    const err = RequestError.internalError({ errorKind: "authentication_failed" }, EXPIRED);
    expect(err.message).toBe(`Internal error: ${EXPIRED}`);
    expect(turnAuthFailureReasonOf(err)).toBe(EXPIRED);
  });

  it("reads oauth_org_not_allowed the same way", () => {
    const err = RequestError.internalError({ errorKind: "oauth_org_not_allowed" }, "org disabled OAuth");
    expect(turnAuthFailureReasonOf(err)).toBe("org disabled OAuth");
  });

  it("falls back to the kind when the message carries nothing else", () => {
    const err = RequestError.internalError({ errorKind: "authentication_failed" });
    expect(err.message).toBe("Internal error");
    expect(turnAuthFailureReasonOf(err)).toBe("authentication_failed");
  });

  it("is null for an internal error without an auth-classified kind", () => {
    expect(turnAuthFailureReasonOf(RequestError.internalError(undefined, EXPIRED))).toBeNull();
    expect(turnAuthFailureReasonOf(RequestError.internalError({ errorKind: "rate_limit" }, "429"))).toBeNull();
    expect(turnAuthFailureReasonOf(RequestError.internalError({ errorKind: 42 }, EXPIRED))).toBeNull();
    expect(turnAuthFailureReasonOf(RequestError.internalError("authentication_failed", EXPIRED))).toBeNull();
  });

  it("is null for other codes — the spec's -32000 is pool.ts's own arm — and for non-RPC errors", () => {
    expect(turnAuthFailureReasonOf(RequestError.authRequired())).toBeNull();
    expect(
      turnAuthFailureReasonOf(new RequestError(-32602, "Invalid params", { errorKind: "authentication_failed" })),
    ).toBeNull();
    expect(turnAuthFailureReasonOf(new Error(EXPIRED))).toBeNull();
    expect(turnAuthFailureReasonOf(undefined)).toBeNull();
  });
});
