import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { createOAuth2Client, GMAIL_SCOPES } from "../../lib/gmail.js";
import { signState, safeCompare } from "../../lib/crypto.js";
import { isOAuthLocked } from "../../lib/store.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Check if OAuth setup is already locked
    const locked = await isOAuthLocked();
    if (locked) {
      return res.status(403).send(
        `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h2>🔒 OAuth Setup is Locked</h2>
          <p>PostmanPingBot is already authorized and locked for security.</p>
          <p>To re-authorize, delete the <code>postman:oauth_locked</code> key in Upstash Redis.</p>
        </body></html>`
      );
    }

    // 2. Validate setup password if configured
    const requiredPassword = process.env.OAUTH_SETUP_PASSWORD?.trim();
    if (requiredPassword) {
      const providedSecret = (req.query.secret as string | undefined)?.trim();
      if (!providedSecret || !safeCompare(providedSecret, requiredPassword)) {
        return res.status(401).send(
          `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
            <h2>🚫 Unauthorized</h2>
            <p>A valid setup password is required to initiate OAuth.</p>
            <p>Access this URL with <code>?secret=YOUR_SETUP_PASSWORD</code></p>
          </body></html>`
        );
      }
    }

    // 3. Generate signed state to prevent CSRF
    const statePayload = {
      nonce: crypto.randomBytes(16).toString("hex"),
      createdAt: Date.now(),
    };
    const signedState = signState(statePayload);

    // 4. Generate Google authorization URL
    const oauth2Client = createOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline", // Required to receive a refresh token
      prompt: "consent", // Force consent so Google always issues a refresh token
      scope: GMAIL_SCOPES,
      state: signedState,
    });

    return res.redirect(authUrl);
  } catch (err: unknown) {
    console.error("Error initiating OAuth flow:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "Failed to initiate OAuth", details: msg });
  }
}
