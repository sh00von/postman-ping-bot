import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createOAuth2Client, watchInbox } from "../../lib/gmail.js";
import { verifyState } from "../../lib/crypto.js";
import {
  saveOAuthTokens,
  setHistoryId,
  updateWatchStatus,
  lockOAuth,
  isOAuthLocked,
  getOAuthTokens,
} from "../../lib/store.js";
import { sendHealthAlert } from "../../lib/telegram.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>❌ Google Authorization Denied</h2>
        <p>Error from Google: <code>${String(error)}</code></p>
      </body></html>`
    );
  }

  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>❌ Missing Parameters</h2>
        <p>Expected <code>code</code> and <code>state</code> query parameters.</p>
      </body></html>`
    );
  }

  try {
    // 1. Verify CSRF state token
    const verifiedPayload = verifyState(state);
    if (!verifiedPayload) {
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h2>❌ Invalid or Expired State</h2>
          <p>The state parameter is invalid or has expired. Please restart the authorization flow.</p>
        </body></html>`
      );
    }

    // 2. Prevent replay if already locked
    const locked = await isOAuthLocked();
    if (locked) {
      return res.status(403).send(
        `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
          <h2>🔒 OAuth Setup is Locked</h2>
          <p>Authorization has already completed previously.</p>
        </body></html>`
      );
    }

    // 3. Exchange authorization code for tokens
    const oauth2Client = createOAuth2Client();
    const tokenResponse = await oauth2Client.getToken(code);
    const tokens = tokenResponse.tokens;

    let refreshToken = tokens.refresh_token;

    // If refresh token wasn't returned, check if we already have one stored
    if (!refreshToken) {
      const existing = await getOAuthTokens();
      if (existing?.refresh_token) {
        refreshToken = existing.refresh_token;
      } else {
        return res.status(400).send(
          `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
            <h2>⚠️ No Refresh Token Received</h2>
            <p>Google did not return a refresh token. Please go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Account Permissions</a>, revoke access for this app, and try again with prompt=consent.</p>
          </body></html>`
        );
      }
    }

    // 4. Save encrypted tokens to Upstash Redis
    await saveOAuthTokens({
      refresh_token: refreshToken,
      access_token: tokens.access_token || undefined,
      expiry_date: tokens.expiry_date || undefined,
      scope: tokens.scope || undefined,
      updated_at: Date.now(),
    });

    // 5. Initialize Gmail watch on the Pub/Sub topic
    const watchResult = await watchInbox();
    if (watchResult.historyId) {
      await setHistoryId(watchResult.historyId);
    }
    if (watchResult.expiration) {
      await updateWatchStatus(watchResult.expiration);
    }

    // 6. Lock OAuth route to prevent unauthorized re-linking
    await lockOAuth();

    // 7. Notify owner on Telegram
    await sendHealthAlert(
      "Gmail Linked Successfully",
      `PostmanPingBot is now monitoring your Gmail inbox!\nInitial History ID: ${watchResult.historyId}\nWatch Expiration: ${new Date(
        watchResult.expiration
      ).toISOString()}`
    );

    return res.status(200).send(
      `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PostmanPingBot Authorization</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 480px; text-align: center; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
          .badge { display: inline-block; background: #059669; color: #fff; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 0.85rem; margin-bottom: 16px; }
          h1 { margin: 0 0 12px; font-size: 1.5rem; }
          p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 20px; }
          .code-box { background: #0f172a; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 0.85rem; color: #38bdf8; word-break: break-all; margin-bottom: 24px; text-align: left; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">Connected</div>
          <h1>Google Account Linked!</h1>
          <p>Gmail push notifications have been activated. The setup route is now locked for security.</p>
          <div class="code-box">
            History ID: ${watchResult.historyId}<br>
            Expiry: ${new Date(watchResult.expiration).toLocaleString()}
          </div>
          <p>You can now close this tab and return to Telegram. Try running <code>/test</code> or <code>/list</code> in your bot chat.</p>
        </div>
      </body>
      </html>`
    );
  } catch (err: unknown) {
    console.error("Error during OAuth callback processing:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>❌ Authorization Error</h2>
        <p>${msg}</p>
      </body></html>`
    );
  }
}
