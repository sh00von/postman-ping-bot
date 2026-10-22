import { describe, it, expect } from "vitest";
import { verifyPubSubToken } from "../lib/verify-pubsub.js";

describe("lib/verify-pubsub", () => {
  it("should reject when Authorization header is missing or empty", async () => {
    const res = await verifyPubSubToken(undefined);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Missing");

    const resEmpty = await verifyPubSubToken("");
    expect(resEmpty.valid).toBe(false);
  });

  it("should reject when Authorization header does not use Bearer scheme", async () => {
    const res = await verifyPubSubToken("Basic dXNlcjpwYXNz");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Bearer");
  });

  it("should reject an invalid or garbage JWT token", async () => {
    const res = await verifyPubSubToken("Bearer not.a.valid.jwt");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("JWT verification failed");
  });
});
