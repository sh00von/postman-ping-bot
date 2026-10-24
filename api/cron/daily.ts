import type { VercelRequest, VercelResponse } from "@vercel/node";
import { safeCompare } from "../../lib/crypto.js";
import { watchInbox, getRecentMessageIds, getMessageMetadata } from "../../lib/gmail.js";
import {
  setHistoryId,
  updateWatchStatus,
  getHealthStatus,
  getWatchlist,
  getRecipientWatchlist,
  markMessageSeen,
} from "../../lib/store.js";
import { findMatchingRule, findMatchingRecipientRule } from "../../lib/match.js";
import { sendHealthAlert, sendEmailAlert } from "../../lib/telegram.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 1. Verify Vercel Cron Secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    const expected = `Bearer ${cronSecret}`;
    if (!authHeader || !safeCompare(authHeader, expected)) {
      return res.status(401).json({ error: "Unauthorized: Invalid CRON_SECRET" });
    }
  }

  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    watchRenewed: false,
    healthAlerts: [] as string[],
    missedMessagesFound: 0,
  };

  // 2. Renew Gmail Watch (7-day duration, renewed daily)
  try {
    const watchRes = await watchInbox();
    if (watchRes.historyId) {
      await setHistoryId(watchRes.historyId);
    }
    if (watchRes.expiration) {
      await updateWatchStatus(watchRes.expiration);
    }
    results.watchRenewed = true;
    results.expiration = new Date(watchRes.expiration).toISOString();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Daily cron watch renewal error:", err);
    await sendHealthAlert(
      "Daily Gmail Watch Renewal Failed",
      `Failed to renew Gmail push notifications:\n${msg}\n\nPlease check your Google Cloud credentials.`
    );
    (results.healthAlerts as string[]).push(`Renewal failed: ${msg}`);
  }

  // 3. Health check: No Pub/Sub events in 48 hours
  try {
    const health = await getHealthStatus();
    const now = Date.now();
    const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

    if (health.lastEventTime && now - health.lastEventTime > TWO_DAYS_MS) {
      const hoursAgo = Math.round((now - health.lastEventTime) / (60 * 60 * 1000));
      await sendHealthAlert(
        "Silent Pub/Sub Warning",
        `No push events received from Google Cloud Pub/Sub in the past ${hoursAgo} hours.\nIf you received emails during this time, verify your Pub/Sub subscription and push endpoint.`
      );
      (results.healthAlerts as string[]).push(`No events in ${hoursAgo} hours`);
    }
  } catch (err) {
    console.error("Health check inspection error:", err);
  }

  // 4. Daily Catch-up Scan (Last 24 hours)
  try {
    const [watchlist, recipientWatchlist] = await Promise.all([
      getWatchlist(),
      getRecipientWatchlist(),
    ]);
    if (watchlist.length > 0 || recipientWatchlist.length > 0) {
      const recentIds = await getRecentMessageIds("newer_than:1d");
      let missedCount = 0;

      for (const msgId of recentIds) {
        // If not already seen, this was missed by Pub/Sub
        const isNew = await markMessageSeen(msgId);
        if (!isNew) continue;

        const meta = await getMessageMetadata(msgId);
        if (!meta) continue;

        const match = meta.senderEmail
          ? findMatchingRule(meta.senderEmail, watchlist)
          : null;
        const recipientMatch = findMatchingRecipientRule(
          meta.recipientEmails,
          recipientWatchlist
        );
        if (match || recipientMatch) {
          missedCount++;
          await sendEmailAlert({
            senderName: meta.senderName,
            senderEmail: meta.senderEmail,
            subject: `[Catch-up] ${meta.subject}`,
            dateStr: meta.date,
            messageId: msgId,
            priority: (match?.priority as "normal" | "urgent" | "quiet") || "normal",
            matchedRecipient: recipientMatch?.recipientEmail,
          });
        }
      }

      results.missedMessagesFound = missedCount;
      if (missedCount > 0) {
        await sendHealthAlert(
          "Catch-up Scan Alert",
          `Daily catch-up scan found and delivered ${missedCount} missed message(s) that were not delivered in real-time by Pub/Sub.`
        );
      }
    }
  } catch (err: unknown) {
    console.error("Catch-up scan error:", err);
  }

  return res.status(200).json(results);
}
