import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTelegramBot, verifyTelegramWebhook } from "../lib/telegram.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Verify Telegram Secret Token header
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
  if (!verifyTelegramWebhook(secretHeader)) {
    return res.status(401).json({ error: "Unauthorized: Invalid Telegram secret token" });
  }

  // 2. Process incoming Telegram Update
  try {
    const bot = getTelegramBot();
    if (!bot.isInited()) {
      await bot.init();
    }
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    await bot.handleUpdate(update);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error processing Telegram update:", err);
    // Return 200 to Telegram so it doesn't repeatedly retry malformed updates
    return res.status(200).json({ ok: false, error: "Internal processing error" });
  }
}
