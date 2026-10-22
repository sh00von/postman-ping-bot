import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyPubSubToken } from "../lib/verify-pubsub.js";
import {
  getHistoryId,
  setHistoryId,
  getWatchlist,
  isPaused,
  markMessageSeen,
  recordLastEventTime,
  getHealthStatus,
  updateWatchStatus,
} from "../lib/store.js";
import {
  listGmailHistory,
  getMessageMetadata,
  getRecentMessageIds,
  watchInbox,
} from "../lib/gmail.js";
import { findMatchingRule } from "../lib/match.js";
import { sendEmailAlert, sendHealthAlert } from "../lib/telegram.js";

interface PubSubMessageBody {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailPushData {
  emailAddress?: string;
  historyId?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Verify Google Cloud Pub/Sub OIDC JWT
  const authHeader = req.headers.authorization;
  const verification = await verifyPubSubToken(authHeader);
  if (!verification.valid) {
    console.warn("Unauthorized Pub/Sub request rejected:", verification.error);
    return res.status(401).json({ error: "Unauthorized", details: verification.error });
  }

  // Record that we received a verified event from Pub/Sub
  await recordLastEventTime();

  // Passive self-healing: if watch expiration is within 48h, auto-renew during normal email activity
  try {
    const health = await getHealthStatus();
    if (health.watchExpiration && health.watchExpiration - Date.now() < 48 * 60 * 60 * 1000) {
      const renewed = await watchInbox();
      if (renewed.expiration) {
        await updateWatchStatus(renewed.expiration);
      }
    }
  } catch (renewErr) {
    console.warn("Passive watch renewal non-fatal notice:", renewErr);
  }

  // 2. Parse Pub/Sub payload
  const body = req.body as PubSubMessageBody;
  if (!body?.message?.data) {
    // Ack empty payload so Pub/Sub does not retry infinitely
    return res.status(200).send("No data in message");
  }

  let pushData: GmailPushData;
  try {
    const decoded = Buffer.from(body.message.data, "base64").toString("utf8");
    pushData = JSON.parse(decoded);
  } catch (err) {
    console.error("Failed to decode Pub/Sub data base64:", err);
    return res.status(200).send("Malformed data");
  }

  const incomingHistoryId = pushData.historyId;

  // 3. If notifications are paused, record historyId and acknowledge
  const paused = await isPaused();
  if (paused) {
    if (incomingHistoryId) {
      await setHistoryId(incomingHistoryId);
    }
    return res.status(200).send("Notifications currently paused");
  }

  // 4. Fetch watchlist
  const watchlist = await getWatchlist();
  if (watchlist.length === 0) {
    // No senders configured, acknowledge and store historyId
    if (incomingHistoryId) {
      await setHistoryId(incomingHistoryId);
    }
    return res.status(200).send("Watchlist is empty");
  }

  const storedHistoryId = await getHistoryId();

  // If we don't have a stored historyId yet, initialize it and exit
  if (!storedHistoryId) {
    if (incomingHistoryId) {
      await setHistoryId(incomingHistoryId);
    }
    return res.status(200).send("Initialized baseline historyId");
  }

  // 5. Query Gmail history
  const messageIdsToInspect = new Set<string>();
  let latestHistoryId = incomingHistoryId || storedHistoryId;

  try {
    const historyResult = await listGmailHistory(storedHistoryId);
    latestHistoryId = historyResult.latestHistoryId;

    for (const record of historyResult.historyRecords) {
      if (record.messagesAdded) {
        for (const item of record.messagesAdded) {
          if (item.message?.id) {
            messageIdsToInspect.add(item.message.id);
          }
        }
      }
    }
  } catch (err: unknown) {
    // If Gmail historyId is expired/out of date (HTTP 404), fall back to recent messages scan
    const status = (err as { status?: number }).status;
    if (status === 404) {
      console.warn("Gmail historyId expired, falling back to recent messages scan (last 24h)");
      try {
        const recentIds = await getRecentMessageIds("newer_than:1d");
        for (const id of recentIds) {
          messageIdsToInspect.add(id);
        }
      } catch (scanErr) {
        console.error("Fallback recent messages scan failed:", scanErr);
      }
    } else {
      console.error("Error fetching Gmail history:", err);
      // Notify owner if auth error
      if (status === 401 || status === 403) {
        await sendHealthAlert(
          "Gmail Authentication Error",
          "Failed to access Gmail API. Your refresh token may have been revoked or expired."
        );
      }
      return res.status(200).send("Handled with error");
    }
  }

  // 6. Process messages
  for (const messageId of messageIdsToInspect) {
    // Deduplication check via Redis SET NX (7-day TTL)
    const isNew = await markMessageSeen(messageId);
    if (!isNew) {
      continue;
    }

    try {
      const metadata = await getMessageMetadata(messageId);
      if (!metadata || !metadata.senderEmail) {
        continue;
      }

      // Check against watchlist
      const match = findMatchingRule(metadata.senderEmail, watchlist);
      if (match) {
        await sendEmailAlert({
          senderName: metadata.senderName,
          senderEmail: metadata.senderEmail,
          subject: metadata.subject,
          dateStr: metadata.date,
          messageId,
          priority: (match.priority as "normal" | "urgent" | "quiet") || "normal",
        });
      }
    } catch (msgErr) {
      console.error(`Error processing message ${messageId}:`, msgErr);
    }
  }

  // 7. Update stored historyId
  if (latestHistoryId) {
    await setHistoryId(latestHistoryId);
  }

  return res.status(200).json({ ok: true, processed: messageIdsToInspect.size });
}
