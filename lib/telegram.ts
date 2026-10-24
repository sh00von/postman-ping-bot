import { Bot, InlineKeyboard } from "grammy";
import { safeCompare } from "./crypto.js";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getRecipientWatchlist,
  addToRecipientWatchlist,
  removeFromRecipientWatchlist,
  isPaused,
  setPaused,
  getHealthStatus,
  getHistoryId,
} from "./store.js";
import {
  normalizePattern,
  parseBulkPatterns,
  findMatchingRule,
} from "./match.js";

let botInstance: Bot | null = null;

export function getTelegramBot(): Bot {
  if (!botInstance) {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable.");
    }
    botInstance = new Bot(token);
    setupBotHandlers(botInstance);
  }
  return botInstance;
}

/**
 * Commands shown in Telegram's "/" menu. Published to Telegram on startup so
 * the menu always matches the commands this deployment actually handles.
 */
const BOT_COMMANDS = [
  { command: "start", description: "Show bot status and commands" },
  { command: "add", description: "Add sender(s) or domain(s) to watch" },
  { command: "remove", description: "Stop monitoring a sender or domain" },
  { command: "addforward", description: "Alert on mail sent to your address(es)" },
  { command: "removeforward", description: "Stop monitoring a recipient rule" },
  { command: "list", description: "View everything you watch" },
  { command: "check", description: "Test if an address matches your rules" },
  { command: "pause", description: "Mute alerts" },
  { command: "resume", description: "Unmute alerts" },
  { command: "status", description: "Gmail watch health & sync info" },
  { command: "test", description: "Send a sample alert" },
  { command: "help", description: "Detailed command guide" },
];

let commandsRegistered = false;

/**
 * Publishes BOT_COMMANDS to Telegram's "/" menu. Runs at most once per
 * serverless instance; the call is idempotent, so re-running it on a cold
 * start is harmless. Non-fatal: if it fails, commands still work when typed
 * manually — they just won't appear in the menu.
 */
export async function ensureBotCommands(): Promise<void> {
  if (commandsRegistered) return;
  try {
    const bot = getTelegramBot();
    await bot.api.setMyCommands(BOT_COMMANDS);
    commandsRegistered = true;
  } catch (err) {
    console.warn("Failed to publish Telegram command menu:", err);
  }
}

/**
 * Checks if the request comes with the correct secret token
 */
export function verifyTelegramWebhook(secretHeader?: string | null): boolean {
  const expectedSecret = process.env.TELEGRAM_SECRET_TOKEN?.trim();
  if (!expectedSecret) {
    return false;
  }
  return safeCompare(secretHeader?.trim(), expectedSecret);
}

/**
 * Ensures only the owner can interact with the bot
 */
function isOwner(userId?: number | string): boolean {
  const ownerId = process.env.TELEGRAM_OWNER_ID?.trim();
  if (!ownerId || !userId) return false;
  return userId.toString() === ownerId.toString();
}

/**
 * Escapes text for Telegram HTML parse mode. HTML mode is far more robust than
 * legacy Markdown for arbitrary content (email subjects, sender names) because
 * only three characters are special and unbalanced markup can't break a message.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Cleans a Gmail snippet for one alert line: collapses all whitespace runs
 * (Gmail snippets can contain newlines) and truncates at a word boundary
 * with an ellipsis. Returns "" when there is nothing worth showing, so
 * callers can simply omit the snippet line.
 */
export function cleanSnippet(snippet = "", maxLength = 140): string {
  const collapsed = snippet.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).replace(
    /[.,;:!?]+$/,
    ""
  );
  return `${trimmed}…`;
}

/** Short visual badge for a rule's alert priority. */
function priorityBadge(priority?: string): string {
  if (priority === "urgent") return "🔴";
  if (priority === "quiet") return "🔕";
  return "";
}

/** Resolves the current timezone used for all human-facing timestamps. */
function appTimezone(): string {
  return process.env.APP_TZ || process.env.TZ || "Asia/Dhaka";
}

function setupBotHandlers(bot: Bot) {
  // Authorization middleware: ignore anyone who isn't the owner
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (!isOwner(ctx.from.id)) {
      console.warn(
        `Unauthorized interaction from user ID: ${ctx.from.id} (configured owner: ${process.env.TELEGRAM_OWNER_ID})`
      );
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const [paused, watchlist, recipientWatchlist] = await Promise.all([
      isPaused(),
      getWatchlist(),
      getRecipientWatchlist(),
    ]);
    const msg = [
      "🤖 <b>PostmanPingBot is active!</b>",
      "",
      `• <b>Status:</b> ${paused ? "⏸️ PAUSED" : "▶️ ACTIVE"}`,
      `• <b>Watched senders/domains:</b> ${watchlist.length}`,
      `• <b>Watched recipient addresses:</b> ${recipientWatchlist.length}`,
      "",
      "<b>Commands</b>",
      "• <code>/add &lt;email|domain&gt;</code> — add sender(s) or domain(s), bulk supported",
      "• <code>/remove &lt;email|domain&gt;</code> — stop monitoring a rule",
      "• <code>/addforward &lt;email|domain&gt;</code> — alert on mail sent TO your address(es)",
      "• <code>/removeforward &lt;email|domain&gt;</code> — stop monitoring a recipient rule",
      "• <code>/list</code> — view everything you watch",
      "• <code>/check &lt;email&gt;</code> — test if an address matches your rules",
      "• <code>/pause</code> — mute alerts",
      "• <code>/resume</code> — unmute alerts",
      "• <code>/status</code> — Gmail watch health &amp; sync info",
      "• <code>/test</code> — send yourself a sample alert",
      "• <code>/help</code> — detailed command guide",
    ].join("\n");

    const keyboard = new InlineKeyboard()
      .text("📋 View watchlist", "cmd_list")
      .text(paused ? "▶️ Resume alerts" : "⏸️ Pause alerts", "toggle_pause");

    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.command("help", async (ctx) => {
    const helpMsg = [
      "📬 <b>PostmanPingBot — command guide</b>",
      "",
      "<b>Add rules</b>",
      "• <code>/add boss@company.com</code> — monitor one exact address",
      "• <code>/add wpscan.com</code> — monitor a whole domain (auto → <code>@wpscan.com</code>)",
      "• <code>/add @bank.com, alerts@a.io</code> — bulk add, comma/space separated",
      "• add the word <code>urgent</code> or <code>quiet</code> to set that priority for the batch",
      "",
      "<b>Recipient alerts (forwarders)</b>",
      "• <code>/addforward hello@shovon.bd</code> — alert on any mail sent TO this address, whoever sends it",
      "• <code>/addforward @shovon.bd</code> — alert on mail sent to ANY address on your domain",
      "• <code>/removeforward hello@shovon.bd</code> — stop monitoring a recipient rule",
      "• Works with forwarded mail: your forwarder preserves the original To address, so the bot sees it. Mail your forwarder blocks never reaches Gmail and cannot alert.",
      "",
      "<b>Manage rules</b>",
      "• <code>/remove boss@company.com</code> — stop monitoring an address",
      "• <code>/remove</code> — list your rules + usage (delete by typing the pattern)",
      "• <code>/list</code> — show all watched entries and their priority",
      "• <code>/check boss@company.com</code> — test if an address matches your rules",
      "",
      "<b>Control &amp; health</b>",
      "• <code>/pause</code> — silence all notifications",
      "• <code>/resume</code> — turn notifications back on",
      "• <code>/status</code> — Gmail watch expiry &amp; health stats",
      "• <code>/test</code> — trigger a sample alert",
      "",
      "Priority: 🔴 urgent · ✉️ normal · 🔕 quiet (silent delivery).",
    ].join("\n");
    await ctx.reply(helpMsg, { parse_mode: "HTML" });
  });

  // /add supports single or bulk items: /add boss@corp.com @bank.com wpscan.com [urgent|quiet]
  bot.command("add", async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        [
          "⚠️ <b>Usage:</b> <code>/add &lt;email|@domain&gt;</code>",
          "",
          "<i>Examples:</i>",
          "• <code>/add boss@company.com</code>",
          "• <code>/add wpscan.com</code> <i>(auto-normalizes to @wpscan.com)</i>",
          "• <code>/add @bank.com, alerts@server.io</code> <i>(bulk add)</i>",
          "• <code>/add @bank.com urgent</code> <i>(set priority)</i>",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    // Detect a standalone priority flag token (not a substring of an address,
    // so `urgent@x.com` is treated as an address, not a priority flag).
    const tokens = text.split(/[\s,;]+/).map((t) => t.trim().toLowerCase());
    let priority: "normal" | "urgent" | "quiet" = "normal";
    if (tokens.includes("urgent")) priority = "urgent";
    else if (tokens.includes("quiet")) priority = "quiet";

    const { valid, invalid } = parseBulkPatterns(text);

    if (valid.length === 0) {
      await ctx.reply(
        [
          "❌ <b>Could not recognize any valid email addresses or domains.</b>",
          "",
          "Valid formats: <code>name@domain.com</code>, <code>@domain.com</code>, or <code>domain.com</code>.",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    // Fetch current watchlist to detect duplicates
    const currentList = await getWatchlist();
    const existingSet = new Set(currentList.map((item) => item.pattern.toLowerCase()));

    const newlyAdded: string[] = [];
    const alreadyPresent: string[] = [];

    for (const pattern of valid) {
      if (existingSet.has(pattern)) {
        alreadyPresent.push(pattern);
      } else {
        await addToWatchlist(pattern, priority);
        newlyAdded.push(pattern);
        existingSet.add(pattern);
      }
    }

    const lines: string[] = [];
    const badge = priorityBadge(priority);

    if (newlyAdded.length > 0) {
      const addedList = newlyAdded.map((p) => `• <code>${escapeHtml(p)}</code>`).join("\n");
      const suffix = priority === "normal" ? "" : ` <i>(${badge} ${priority})</i>`;
      lines.push(`✅ <b>Added ${newlyAdded.length} item(s) to watchlist:</b>${suffix}`, addedList);
    }

    if (alreadyPresent.length > 0) {
      const existingList = alreadyPresent.map((p) => `• <code>${escapeHtml(p)}</code>`).join("\n");
      lines.push("", `ℹ️ <b>Already in watchlist (${alreadyPresent.length}):</b>`, existingList);
    }

    if (invalid.length > 0) {
      const invalidList = invalid.map((p) => `• <code>${escapeHtml(p)}</code>`).join("\n");
      lines.push("", "⚠️ <b>Ignored invalid entries:</b>", invalidList);
    }

    const keyboard = new InlineKeyboard().text("📋 View watchlist", "cmd_list");
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  // /remove requires an argument; a bare /remove shows usage + the current rules
  bot.command("remove", async (ctx) => {
    const rawPattern = ctx.match?.trim();

    // If no argument provided, show usage hint plus a copy-pasteable rule list
    if (!rawPattern) {
      const list = await getWatchlist();
      if (list.length === 0) {
        await ctx.reply("📭 Your watchlist is currently empty.", { parse_mode: "HTML" });
        return;
      }

      const items = list.map((item, idx) => {
        const type = item.pattern.startsWith("@") ? "🌐 Domain" : "✉️ Sender";
        const badge = priorityBadge(item.priority);
        return `${idx + 1}. <code>${escapeHtml(item.pattern)}</code> — ${type}${badge ? " " + badge : ""}`;
      });

      await ctx.reply(
        [
          "🗑️ <b>Usage:</b> <code>/remove &lt;email|@domain&gt;</code>",
          "",
          "<i>Copy a pattern below and send it with</i> <code>/remove</code><i>:</i>",
          "",
          ...items,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    // If argument provided, normalize and remove
    const normalized = normalizePattern(rawPattern) || rawPattern.toLowerCase();
    const removed = await removeFromWatchlist(normalized);

    if (removed) {
      await ctx.reply(`🗑️ Removed <code>${escapeHtml(normalized)}</code> from watchlist.`, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(
        `❓ <code>${escapeHtml(normalized)}</code> was not found in your watchlist.`,
        { parse_mode: "HTML" }
      );
    }
  });

  // /addforward supports single or bulk recipient rules:
  // /addforward hello@shovon.bd @shovon.bd
  // Recipient alerts carry no priority — they always use normal delivery.
  bot.command("addforward", async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        [
          "⚠️ <b>Usage:</b> <code>/addforward &lt;email|@domain&gt;</code>",
          "",
          "<i>Examples:</i>",
          "• <code>/addforward hello@shovon.bd</code> <i>(alert on mail sent TO this address)</i>",
          "• <code>/addforward @shovon.bd</code> <i>(alert on mail sent to ANY address on the domain)</i>",
          "• <code>/addforward hello@shovon.bd, sales@shovon.bd</code> <i>(bulk add)</i>",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    const { valid, invalid } = parseBulkPatterns(text);

    if (valid.length === 0) {
      await ctx.reply(
        [
          "❌ <b>Could not recognize any valid email addresses or domains.</b>",
          "",
          "Valid formats: <code>name@domain.com</code>, <code>@domain.com</code>, or <code>domain.com</code>.",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    // Fetch current recipient rules to detect duplicates
    const currentList = await getRecipientWatchlist();
    const existingSet = new Set(currentList.map((item) => item.pattern.toLowerCase()));

    const newlyAdded: string[] = [];
    const alreadyPresent: string[] = [];

    for (const pattern of valid) {
      if (existingSet.has(pattern)) {
        alreadyPresent.push(pattern);
      } else {
        await addToRecipientWatchlist(pattern);
        newlyAdded.push(pattern);
        existingSet.add(pattern);
      }
    }

    const lines: string[] = [];

    if (newlyAdded.length > 0) {
      const addedList = newlyAdded.map((p) => `• <code>${escapeHtml(p)}</code>`).join("\n");
      lines.push(`✅ <b>Added ${newlyAdded.length} recipient rule(s):</b>`, addedList);
    }

    if (alreadyPresent.length > 0) {
      const existingList = alreadyPresent.map((p) => `• <code>${escapeHtml(p)}</code>`).join("\n");
      lines.push("", `ℹ️ <b>Already watched (${alreadyPresent.length}):</b>`, existingList);
    }

    if (invalid.length > 0) {
      const invalidList = invalid.map((p) => `• <code>${escapeHtml(p)}</code>`).join("\n");
      lines.push("", "⚠️ <b>Ignored invalid entries:</b>", invalidList);
    }

    const keyboard = new InlineKeyboard().text("📋 View watchlist", "cmd_list");
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  // /removeforward requires an argument; a bare /removeforward shows usage + rules
  bot.command("removeforward", async (ctx) => {
    const rawPattern = ctx.match?.trim();

    // If no argument provided, show usage hint plus a copy-pasteable rule list
    if (!rawPattern) {
      const list = await getRecipientWatchlist();
      if (list.length === 0) {
        await ctx.reply("📭 No recipient rules configured.", { parse_mode: "HTML" });
        return;
      }

      const items = list.map((item, idx) => {
        const type = item.pattern.startsWith("@") ? "🌐 Domain" : "📥 Address";
        return `${idx + 1}. <code>${escapeHtml(item.pattern)}</code> — ${type}`;
      });

      await ctx.reply(
        [
          "🗑️ <b>Usage:</b> <code>/removeforward &lt;email|@domain&gt;</code>",
          "",
          "<i>Copy a pattern below and send it with</i> <code>/removeforward</code><i>:</i>",
          "",
          ...items,
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    // If argument provided, normalize and remove
    const normalized = normalizePattern(rawPattern) || rawPattern.toLowerCase();
    const removed = await removeFromRecipientWatchlist(normalized);

    if (removed) {
      await ctx.reply(`🗑️ Removed <code>${escapeHtml(normalized)}</code> from recipient rules.`, {
        parse_mode: "HTML",
      });
    } else {
      await ctx.reply(
        `❓ <code>${escapeHtml(normalized)}</code> was not found in your recipient rules.`,
        { parse_mode: "HTML" }
      );
    }
  });

  // /list shows all rules with their priority and a pause toggle
  bot.command("list", async (ctx) => {
    await renderWatchlistMessage(ctx);
  });

  // /check command: simulate if an email matches active watchlist rules
  bot.command("check", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        [
          "⚠️ <b>Usage:</b> <code>/check &lt;email_address&gt;</code>",
          "",
          "<i>Example:</i>",
          "<code>/check security@wpscan.com</code>",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    const [watchlist, paused] = await Promise.all([getWatchlist(), isPaused()]);
    if (watchlist.length === 0) {
      await ctx.reply(
        "📭 Your watchlist is currently empty.\nUse <code>/add &lt;email|domain&gt;</code> to add rules first.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const match = findMatchingRule(input, watchlist);
    if (match) {
      const badge = priorityBadge(match.priority);
      const lines = [
        "🎯 <b>Match confirmed!</b>",
        "",
        `• <b>Queried email:</b> <code>${escapeHtml(input.toLowerCase())}</code>`,
        `• <b>Matched rule:</b> <code>${escapeHtml(match.pattern)}</code>`,
        `• <b>Priority:</b> ${badge ? badge + " " : ""}${escapeHtml(match.priority || "normal")}`,
        "",
        "✨ An email from this address <b>will</b> trigger an instant Telegram alert.",
      ];
      if (paused) {
        lines.push("", "⏸️ <b>Note:</b> alerts are currently paused — send <code>/resume</code> to receive it.");
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } else {
      await ctx.reply(
        [
          "⚪ <b>No match found</b>",
          "",
          `• <b>Queried email:</b> <code>${escapeHtml(input.toLowerCase())}</code>`,
          "",
          "This address does not match any sender or domain in your active watchlist.",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.command("pause", async (ctx) => {
    await setPaused(true);
    await ctx.reply("⏸️ <b>Notifications paused.</b>\nSend <code>/resume</code> to turn them back on.", {
      parse_mode: "HTML",
    });
  });

  bot.command("resume", async (ctx) => {
    await setPaused(false);
    await ctx.reply("▶️ <b>Notifications resumed!</b>", { parse_mode: "HTML" });
  });

  bot.command("status", async (ctx) => {
    const [health, historyId, paused, list, recipientList] = await Promise.all([
      getHealthStatus(),
      getHistoryId(),
      isPaused(),
      getWatchlist(),
      getRecipientWatchlist(),
    ]);

    const tz = appTimezone();
    const now = Date.now();

    let expiryStr = "Not configured";
    if (health.watchExpiration) {
      const diffHours = Math.round((health.watchExpiration - now) / (1000 * 60 * 60));
      const expDate = new Date(health.watchExpiration).toLocaleString("en-US", { timeZone: tz });
      expiryStr = `${expDate} (${diffHours > 0 ? diffHours + "h remaining" : "EXPIRED"})`;
    }

    let lastEventStr = "None recorded";
    if (health.lastEventTime) {
      lastEventStr = new Date(health.lastEventTime).toLocaleString("en-US", { timeZone: tz });
    }

    const msg = [
      "📊 <b>PostmanPingBot status</b>",
      "",
      `• <b>Alerts:</b> ${paused ? "⏸️ Paused" : "▶️ Active"}`,
      `• <b>Watchlist items:</b> ${list.length}`,
      `• <b>Recipient (forwarder) rules:</b> ${recipientList.length}`,
      `• <b>Gmail history ID:</b> <code>${escapeHtml(String(historyId || "None"))}</code>`,
      `• <b>Gmail watch expiry:</b> ${escapeHtml(expiryStr)}`,
      `• <b>Last Pub/Sub event:</b> ${escapeHtml(lastEventStr)}`,
      `• <b>Server time:</b> ${escapeHtml(new Date().toLocaleString("en-US", { timeZone: tz }))} (${escapeHtml(tz)})`,
    ].join("\n");

    const keyboard = new InlineKeyboard()
      .text(paused ? "▶️ Resume alerts" : "⏸️ Pause alerts", "toggle_pause")
      .text("📋 View watchlist", "cmd_list");

    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
  });

  bot.command("test", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .url("Open in Gmail", "https://mail.google.com/mail/u/0/#inbox");

    await ctx.reply(
      [
        "📬 <b>New mail from</b> Boss &lt;boss@example.com&gt;",
        "<b>Subject:</b> Q3 Review — Test alert confirmation",
        "<i>Hi, your Q3 review is scheduled for Friday at 10 AM. Please confirm…</i>",
        `🕒 ${new Date().toLocaleTimeString("en-US", {
          timeZone: appTimezone(),
          hour: "2-digit",
          minute: "2-digit",
        })}`,
        "",
        "<i>This is a sample — real alerts look exactly like this.</i>",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }
    );
  });

  // Callback query dispatcher for non-destructive inline buttons.
  // Deletion is intentionally NOT handled here — it is typed via `/remove`.
  // Any stale `del:` button on old messages falls through to the catch-all below.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Toggle pause callback
    if (data === "toggle_pause") {
      const currentlyPaused = await isPaused();
      const newPaused = !currentlyPaused;
      await setPaused(newPaused);
      await ctx.answerCallbackQuery({
        text: newPaused ? "⏸️ Alerts paused" : "▶️ Alerts resumed",
      });

      try {
        const keyboard = new InlineKeyboard()
          .text(newPaused ? "▶️ Resume alerts" : "⏸️ Pause alerts", "toggle_pause")
          .text("📋 View watchlist", "cmd_list");
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch {
        // ignore
      }
      return;
    }

    // Open watchlist command
    if (data === "cmd_list") {
      await ctx.answerCallbackQuery();
      await renderWatchlistMessage(ctx);
      return;
    }

    await ctx.answerCallbackQuery();
  });
}

/**
 * Helper to render the watchlist message with per-item priority and a pause toggle.
 */
async function renderWatchlistMessage(ctx: {
  reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
}) {
  const [list, recipientList, paused] = await Promise.all([
    getWatchlist(),
    getRecipientWatchlist(),
    isPaused(),
  ]);
  if (list.length === 0 && recipientList.length === 0) {
    await ctx.reply(
      "📭 Your watchlist is empty.\nUse <code>/add &lt;email|@domain&gt;</code> to start monitoring senders, or <code>/addforward &lt;email|@domain&gt;</code> to watch your own addresses.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const msg: string[] = [`<b>Status:</b> ${paused ? "⏸️ PAUSED" : "▶️ ACTIVE"}`, ""];

  if (list.length > 0) {
    const items = list.map((item, idx) => {
      const type = item.pattern.startsWith("@") ? "🌐 Domain" : "✉️ Sender";
      const badge = priorityBadge(item.priority);
      return `${idx + 1}. <code>${escapeHtml(item.pattern)}</code> — ${type}${badge ? " " + badge : ""}`;
    });
    msg.push(`📋 <b>Watched senders (${list.length})</b>`, ...items, "");
  }

  if (recipientList.length > 0) {
    const recipientItems = recipientList.map((item, idx) => {
      const type = item.pattern.startsWith("@") ? "🌐 Domain" : "📥 Address";
      return `${idx + 1}. <code>${escapeHtml(item.pattern)}</code> — ${type}`;
    });
    msg.push(
      `📥 <b>Watched recipient addresses (${recipientList.length})</b>`,
      ...recipientItems,
      ""
    );
  }

  msg.push(
    "<i>Remove senders with</i> <code>/remove &lt;pattern&gt;</code><i>, recipients with</i> <code>/removeforward &lt;pattern&gt;</code><i>.</i>"
  );
  const msgText = msg.join("\n");

  // Non-destructive action button only. Delete via typed `/remove <email>`.
  const keyboard = new InlineKeyboard()
    .text(paused ? "▶️ Resume alerts" : "⏸️ Pause alerts", "toggle_pause");

  await ctx.reply(msgText, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * Sends an email notification to the owner
 */
export async function sendEmailAlert(params: {
  senderName: string;
  senderEmail: string;
  subject: string;
  dateStr?: string;
  messageId: string;
  priority?: "normal" | "urgent" | "quiet";
  matchedRecipient?: string;
  snippet?: string;
}): Promise<void> {
  const bot = getTelegramBot();
  const ownerId = process.env.TELEGRAM_OWNER_ID?.trim();
  if (!ownerId) {
    throw new Error("TELEGRAM_OWNER_ID is not configured");
  }

  const fromLabel = params.senderName
    ? `${escapeHtml(params.senderName)} &lt;${escapeHtml(params.senderEmail)}&gt;`
    : `&lt;${escapeHtml(params.senderEmail)}&gt;`;

  const tz = appTimezone();
  const timeSource = params.dateStr ? new Date(params.dateStr) : new Date();
  const timeFormatted = timeSource.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });

  const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(params.messageId)}`;

  // Single non-destructive button: [Open in Gmail]
  const keyboard = new InlineKeyboard().url("Open in Gmail", gmailUrl);

  const header =
    params.priority === "urgent"
      ? `🔴 <b>URGENT — new mail from</b> ${fromLabel}`
      : `📬 <b>New mail from</b> ${fromLabel}`;

  const lines = [header];
  if (params.matchedRecipient) {
    lines.push(`📥 <b>To:</b> <code>${escapeHtml(params.matchedRecipient)}</code>`);
  }
  lines.push(`<b>Subject:</b> ${escapeHtml(params.subject || "(No Subject)")}`);
  const snippet = cleanSnippet(params.snippet);
  if (snippet) {
    lines.push(`<i>${escapeHtml(snippet)}</i>`);
  }
  lines.push(`🕒 ${timeFormatted}`);
  const text = lines.join("\n");

  await bot.api.sendMessage(ownerId, text, {
    parse_mode: "HTML",
    reply_markup: keyboard,
    disable_notification: params.priority === "quiet",
  });
}

/**
 * Sends health alert notifications to the owner
 */
export async function sendHealthAlert(title: string, details: string): Promise<void> {
  const bot = getTelegramBot();
  const ownerId = process.env.TELEGRAM_OWNER_ID?.trim();
  if (!ownerId) return;

  const text = [
    "⚠️ <b>PostmanPingBot system alert</b>",
    `<b>${escapeHtml(title)}</b>`,
    "",
    escapeHtml(details),
  ].join("\n");

  try {
    await bot.api.sendMessage(ownerId, text, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Failed to send health alert to Telegram:", err);
  }
}
