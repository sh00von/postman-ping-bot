import { describe, it, expect } from "vitest";
import { encrypt, decrypt, signState, verifyState, safeCompare } from "../lib/crypto.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("lib/crypto", () => {
  it("should encrypt and decrypt plaintext using AES-256-GCM", () => {
    const secretMessage = "1//04AbCdEfGhIjKlMnOpQrStUvWxYz-SecretRefreshToken";
    const encrypted = encrypt(secretMessage, TEST_KEY);

    expect(encrypted).not.toBe(secretMessage);
    expect(encrypted.split(":").length).toBe(3);

    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(secretMessage);
  });

  it("should fail decryption if ciphertext or auth tag is tampered with", () => {
    const encrypted = encrypt("hello world", TEST_KEY);
    const [iv, tag, cipher] = encrypted.split(":");
    // Tamper with ciphertext
    const tamperedCipher = cipher.slice(0, -2) + (cipher.endsWith("00") ? "11" : "00");
    const tampered = `${iv}:${tag}:${tamperedCipher}`;

    expect(() => decrypt(tampered, TEST_KEY)).toThrow();
  });

  it("should sign and verify state with HMAC-SHA256", () => {
    const payload = { userId: "12345", nonce: "abc", createdAt: Date.now() };
    const signed = signState(payload, TEST_KEY);

    const verified = verifyState<typeof payload>(signed, TEST_KEY);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe("12345");
  });

  it("should reject tampered or expired states", () => {
    const payload = { userId: "12345", nonce: "abc", createdAt: Date.now() - 100000 };
    const signed = signState(payload, TEST_KEY);

    // Tampered
    expect(verifyState(signed + "x", TEST_KEY)).toBeNull();

    // Expired (maxAge 1000ms)
    expect(verifyState(signed, TEST_KEY, 1000)).toBeNull();
  });

  it("should perform safe constant-time string comparison", () => {
    expect(safeCompare("secret-token", "secret-token")).toBe(true);
    expect(safeCompare("secret-token", "wrong-token")).toBe(false);
    expect(safeCompare("secret-token", "secret")).toBe(false);
    expect(safeCompare(null, "secret")).toBe(false);
    expect(safeCompare(undefined, undefined)).toBe(false);
  });
});
