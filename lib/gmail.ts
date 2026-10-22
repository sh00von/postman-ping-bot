import { google, gmail_v1 } from "googleapis";
import { getOAuthTokens, saveOAuthTokens } from "./store.js";
import { parseFromHeader, type ParsedEmailHeader } from "./match.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.metadata"];

/**
 * Creates a base OAuth2 client from environment configuration.
 */
export function createOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing Google OAuth environment variables (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)."
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Returns an authenticated Gmail API client using stored refresh tokens.
 */
export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  const oauth2Client = createOAuth2Client();
  const tokens = await getOAuthTokens();

  if (!tokens || !tokens.refresh_token) {
    throw new Error("Gmail is not authorized. No refresh token found.");
  }

  oauth2Client.setCredentials({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
  });

  // Automatically persist refreshed access token
  oauth2Client.on("tokens", async (newTokens) => {
    try {
      await saveOAuthTokens({
        refresh_token: newTokens.refresh_token || tokens.refresh_token,
        access_token: newTokens.access_token || tokens.access_token,
        expiry_date: newTokens.expiry_date || tokens.expiry_date,
        scope: newTokens.scope || tokens.scope,
        updated_at: Date.now(),
      });
    } catch (err) {
      console.error("Failed to persist refreshed OAuth tokens:", err);
    }
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/**
 * Calls gmail.users.watch to register Google Cloud Pub/Sub topic for push notifications.
 * Topic format: projects/{project_id}/topics/{topic_name}
 */
export async function watchInbox(topicName?: string): Promise<{
  historyId: string;
  expiration: number;
}> {
  const targetTopic = (topicName || process.env.PUBSUB_TOPIC_NAME)?.trim();
  if (!targetTopic) {
    throw new Error("PUBSUB_TOPIC_NAME is not configured.");
  }

  const gmail = await getGmailClient();
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: targetTopic,
      labelIds: ["INBOX"],
    },
  });

  const historyId = res.data.historyId || "";
  const expiration = res.data.expiration ? parseInt(res.data.expiration, 10) : 0;

  return { historyId, expiration };
}

/**
 * Calls gmail.users.stop to cancel push notifications.
 */
export async function stopInboxWatch(): Promise<void> {
  const gmail = await getGmailClient();
  await gmail.users.stop({ userId: "me" });
}

/**
 * Retrieves history records since startHistoryId.
 */
export async function listGmailHistory(startHistoryId: string): Promise<{
  historyRecords: gmail_v1.Schema$History[];
  latestHistoryId: string;
}> {
  const gmail = await getGmailClient();
  const res = await gmail.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
  });

  return {
    historyRecords: res.data.history || [],
    latestHistoryId: res.data.historyId || startHistoryId,
  };
}

/**
 * Fetches metadata (headers) for a single message without reading email body.
 */
export async function getMessageMetadata(
  messageId: string
): Promise<ParsedEmailHeader | null> {
  const gmail = await getGmailClient();

  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = res.data.payload?.headers || [];
    let rawFrom = "";
    let subject = "";
    let date = "";

    for (const h of headers) {
      const name = h.name?.toLowerCase();
      if (name === "from") rawFrom = h.value || "";
      else if (name === "subject") subject = h.value || "";
      else if (name === "date") date = h.value || "";
    }

    const { senderName, senderEmail } = parseFromHeader(rawFrom);

    return {
      rawFrom,
      senderName,
      senderEmail,
      subject,
      date,
    };
  } catch (err: unknown) {
    // If message was deleted or cannot be found
    const status = (err as { status?: number }).status;
    if (status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Catch-up fallback scan for messages in the last 24 hours.
 */
export async function getRecentMessageIds(
  query = "newer_than:1d"
): Promise<string[]> {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 50,
  });

  return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
}
