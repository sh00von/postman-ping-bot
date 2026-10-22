import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // Standard 96-bit IV for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

function getKeyBuffer(keyHexOrBase64?: string): Buffer {
  const key = (keyHexOrBase64 || process.env.ENCRYPTION_KEY)?.trim();
  if (!key) {
    throw new Error("ENCRYPTION_KEY is required but not provided in environment variables.");
  }

  // Support 64-char hex string or base64 or raw 32-byte string
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, "hex");
  }
  const buffer = Buffer.from(key, "base64");
  if (buffer.length === 32) {
    return buffer;
  }
  // Fallback hash to 32 bytes if key is an arbitrary passphrase
  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encrypts plaintext string using AES-256-GCM.
 * Output format: iv:authTag:ciphertext (hex encoded)
 */
export function encrypt(plaintext: string, keyHexOrBase64?: string): string {
  const key = getKeyBuffer(keyHexOrBase64);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext}`;
}

/**
 * Decrypts ciphertext formatted as iv:authTag:ciphertext (hex encoded) using AES-256-GCM.
 */
export function decrypt(encryptedText: string, keyHexOrBase64?: string): string {
  const key = getKeyBuffer(keyHexOrBase64);
  const parts = encryptedText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted text format. Expected iv:authTag:ciphertext");
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid AuthTag length: expected ${AUTH_TAG_LENGTH} bytes`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Creates an HMAC-SHA256 signature for OAuth state verification.
 * Format: payload.signature
 */
export function signState(payload: Record<string, unknown>, secretKey?: string): string {
  const secret = secretKey || process.env.ENCRYPTION_KEY || "postman-ping-secret";
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${hmac}`;
}

/**
 * Verifies an HMAC-SHA256 signed OAuth state parameter and checks optional expiry.
 */
export function verifyState<T = Record<string, unknown>>(
  signedState: string,
  secretKey?: string,
  maxAgeMs = 15 * 60 * 1000 // 15 mins default
): T | null {
  try {
    const secret = secretKey || process.env.ENCRYPTION_KEY || "postman-ping-secret";
    const parts = signedState.split(".");
    if (parts.length !== 2) return null;

    const [data, signature] = parts;
    const expectedSig = crypto.createHmac("sha256", secret).update(data).digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const json = Buffer.from(data, "base64url").toString("utf8");
    const payload = JSON.parse(json);

    if (payload.createdAt && Date.now() - payload.createdAt > maxAgeMs) {
      return null;
    }

    return payload as T;
  } catch {
    return null;
  }
}

/**
 * Timing-safe string comparison to protect against timing attacks on secret headers.
 */
export function safeCompare(a?: string | null, b?: string | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
