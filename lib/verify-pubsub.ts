import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_CERTS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const JWKS = createRemoteJWKSet(GOOGLE_CERTS_URL);

export interface PubSubVerificationResult {
  valid: boolean;
  email?: string;
  error?: string;
}

/**
 * Verifies the Google Cloud Pub/Sub OIDC Bearer token from the HTTP Authorization header.
 * Ensures the token:
 * 1. Is signed by Google's public certificates
 * 2. Has an issuer matching Google Accounts
 * 3. Matches the expected target audience (your Vercel webhook URL)
 * 4. Matches the dedicated service account email configured for Pub/Sub
 */
export async function verifyPubSubToken(
  authHeader: string | undefined | null,
  options?: {
    audience?: string;
    expectedEmail?: string;
  }
): Promise<PubSubVerificationResult> {
  if (!authHeader) {
    return { valid: false, error: "Missing Authorization header" };
  }

  const parts = authHeader.trim().split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return { valid: false, error: "Invalid Authorization header format. Expected 'Bearer <token>'" };
  }

  const token = parts[1];
  const expectedAudience = (options?.audience || process.env.PUBSUB_VERIFICATION_AUDIENCE)?.trim();
  const expectedEmail = (options?.expectedEmail || process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL)?.trim();

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: expectedAudience,
    });

    if (expectedEmail) {
      if (payload.email !== expectedEmail) {
        return {
          valid: false,
          error: `Service account mismatch: expected ${expectedEmail}, received ${payload.email}`,
        };
      }
    }

    if (payload.email_verified !== true) {
      return { valid: false, error: "Service account email is not verified" };
    }

    return { valid: true, email: payload.email as string };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `JWT verification failed: ${errorMsg}` };
  }
}
