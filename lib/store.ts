import { Redis } from "@upstash/redis";
import { encrypt, decrypt } from "./crypto.js";

export interface WatchlistItem {
  pattern: string;
  priority: "normal" | "urgent" | "quiet";
  addedAt: number;
}

export interface RecipientWatchlistItem {
  pattern: string;
  addedAt: number;
}

export interface StoredTokens {
  refresh_token: string;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  updated_at: number;
}

export interface WatchStatus {
  expiration: number | null;
  renewedAt: number | null;
  lastEventTime: number | null;
}

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisInstance) {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

    if (!url || !token) {
      throw new Error(
        "Missing Upstash Redis environment variables (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)."
      );
    }

    redisInstance = new Redis({
      url,
      token,
    });
  }
  return redisInstance;
}

const KEYS = {
  WATCHLIST: "postman:watchlist",
  RECIPIENT_WATCHLIST: "postman:recipient-watchlist",
  PAUSED: "postman:paused",
  OAUTH_TOKENS: "postman:oauth_tokens",
  OAUTH_LOCKED: "postman:oauth_locked",
  HISTORY_ID: "postman:history_id",
  WATCH_STATUS: "postman:watch_status",
  LAST_EVENT_TIME: "postman:last_event_time",
  seenMessage: (id: string) => `postman:seen_msg:${id}`,
};

/**
 * Watchlist management
 */
export async function getWatchlist(): Promise<WatchlistItem[]> {
  const redis = getRedisClient();
  const rawHash = await redis.hgetall<Record<string, string | WatchlistItem>>(KEYS.WATCHLIST);
  if (!rawHash) return [];

  const map = new Map<string, WatchlistItem>();
  for (const [key, val] of Object.entries(rawHash)) {
    if (!val) continue;
    let item: WatchlistItem;
    if (typeof val === "string") {
      try {
        item = JSON.parse(val);
      } catch {
        item = { pattern: key, priority: "normal", addedAt: Date.now() };
      }
    } else {
      item = val;
    }

    // Canonicalize pattern: if it has no @, it's a domain so prepend @
    const rawPattern = (item.pattern || key).trim().toLowerCase();
    const canonical = rawPattern.startsWith("@") || rawPattern.includes("@")
      ? rawPattern
      : `@${rawPattern}`;

    if (!map.has(canonical) || item.priority === "urgent") {
      map.set(canonical, { ...item, pattern: canonical });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.addedAt - a.addedAt);
}

export async function addToWatchlist(
  pattern: string,
  priority: "normal" | "urgent" | "quiet" = "normal"
): Promise<boolean> {
  const redis = getRedisClient();
  const normalized = pattern.trim().toLowerCase();
  const item: WatchlistItem = {
    pattern: normalized,
    priority,
    addedAt: Date.now(),
  };
  // Returns 1 if new field, 0 if updated
  await redis.hset(KEYS.WATCHLIST, { [normalized]: JSON.stringify(item) });
  return true;
}

export async function removeFromWatchlist(pattern: string): Promise<boolean> {
  const redis = getRedisClient();
  const normalized = pattern.trim().toLowerCase();
  const alt = normalized.startsWith("@") ? normalized.slice(1) : `@${normalized}`;
  const removed = await redis.hdel(KEYS.WATCHLIST, normalized, alt);
  return removed > 0;
}

/**
 * Recipient (forwarder) watchlist management.
 * Patterns are exact addresses ("hello@shovon.bd") or whole domains
 * ("@shovon.bd"). Stored separately from sender rules so the two kinds of
 * alerts stay distinguishable. Recipient alerts always use normal priority.
 */
export async function getRecipientWatchlist(): Promise<RecipientWatchlistItem[]> {
  const redis = getRedisClient();
  const rawHash = await redis.hgetall<Record<string, string | RecipientWatchlistItem>>(
    KEYS.RECIPIENT_WATCHLIST
  );
  if (!rawHash) return [];

  const map = new Map<string, RecipientWatchlistItem>();
  for (const [key, val] of Object.entries(rawHash)) {
    if (!val) continue;
    let item: RecipientWatchlistItem;
    if (typeof val === "string") {
      try {
        item = JSON.parse(val);
      } catch {
        item = { pattern: key, addedAt: Date.now() };
      }
    } else {
      item = val;
    }

    // Canonicalize pattern: if it has no @, it's a domain so prepend @
    const rawPattern = (item.pattern || key).trim().toLowerCase();
    const canonical = rawPattern.startsWith("@") || rawPattern.includes("@")
      ? rawPattern
      : `@${rawPattern}`;

    if (!map.has(canonical)) {
      map.set(canonical, { ...item, pattern: canonical });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.addedAt - a.addedAt);
}

export async function addToRecipientWatchlist(pattern: string): Promise<boolean> {
  const redis = getRedisClient();
  const normalized = pattern.trim().toLowerCase();
  const item: RecipientWatchlistItem = {
    pattern: normalized,
    addedAt: Date.now(),
  };
  // Returns 1 if new field, 0 if updated
  await redis.hset(KEYS.RECIPIENT_WATCHLIST, { [normalized]: JSON.stringify(item) });
  return true;
}

export async function removeFromRecipientWatchlist(pattern: string): Promise<boolean> {
  const redis = getRedisClient();
  const normalized = pattern.trim().toLowerCase();
  const alt = normalized.startsWith("@") ? normalized.slice(1) : `@${normalized}`;
  const removed = await redis.hdel(KEYS.RECIPIENT_WATCHLIST, normalized, alt);
  return removed > 0;
}

/**
 * Pause / Resume toggle
 */
export async function isPaused(): Promise<boolean> {
  const redis = getRedisClient();
  const paused = await redis.get<string>(KEYS.PAUSED);
  return paused === "true";
}

export async function setPaused(paused: boolean): Promise<void> {
  const redis = getRedisClient();
  await redis.set(KEYS.PAUSED, paused ? "true" : "false");
}

/**
 * OAuth token storage (Encrypted with AES-256-GCM)
 */
export async function saveOAuthTokens(tokens: StoredTokens): Promise<void> {
  const redis = getRedisClient();
  const plaintext = JSON.stringify(tokens);
  const encrypted = encrypt(plaintext);
  await redis.set(KEYS.OAUTH_TOKENS, encrypted);
}

export async function getOAuthTokens(): Promise<StoredTokens | null> {
  const redis = getRedisClient();
  const encrypted = await redis.get<string>(KEYS.OAUTH_TOKENS);
  if (!encrypted) return null;

  try {
    const plaintext = decrypt(encrypted);
    return JSON.parse(plaintext) as StoredTokens;
  } catch (err) {
    console.error("Failed to decrypt stored OAuth tokens:", err);
    return null;
  }
}

export async function isOAuthLocked(): Promise<boolean> {
  const redis = getRedisClient();
  const locked = await redis.get<string>(KEYS.OAUTH_LOCKED);
  return locked === "true";
}

export async function lockOAuth(): Promise<void> {
  const redis = getRedisClient();
  await redis.set(KEYS.OAUTH_LOCKED, "true");
}

/**
 * Gmail History ID tracking
 */
export async function getHistoryId(): Promise<string | null> {
  const redis = getRedisClient();
  return redis.get<string>(KEYS.HISTORY_ID);
}

export async function setHistoryId(historyId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.set(KEYS.HISTORY_ID, historyId);
}

/**
 * Message deduplication (7-day TTL)
 * Returns true if the message was newly seen, false if it's a duplicate.
 */
export async function markMessageSeen(messageId: string): Promise<boolean> {
  const redis = getRedisClient();
  const key = KEYS.seenMessage(messageId);
  // SET key 1 EX 604800 NX (7 days in seconds)
  const result = await redis.set(key, "1", { ex: 7 * 86400, nx: true });
  return result === "OK";
}

/**
 * Watch & Health Status Tracking
 */
export async function updateWatchStatus(expirationTimestampMs: number): Promise<void> {
  const redis = getRedisClient();
  await redis.set(
    KEYS.WATCH_STATUS,
    JSON.stringify({
      expiration: expirationTimestampMs,
      renewedAt: Date.now(),
    })
  );
}

export async function recordLastEventTime(): Promise<void> {
  const redis = getRedisClient();
  await redis.set(KEYS.LAST_EVENT_TIME, Date.now().toString());
}

export async function getHealthStatus(): Promise<{
  watchExpiration: number | null;
  renewedAt: number | null;
  lastEventTime: number | null;
}> {
  const redis = getRedisClient();
  const [rawWatchStatus, rawLastEventTime] = await Promise.all([
    redis.get<string>(KEYS.WATCH_STATUS),
    redis.get<string>(KEYS.LAST_EVENT_TIME),
  ]);

  let watchExpiration: number | null = null;
  let renewedAt: number | null = null;
  if (rawWatchStatus) {
    try {
      const parsed = typeof rawWatchStatus === "string" ? JSON.parse(rawWatchStatus) : rawWatchStatus;
      watchExpiration = parsed.expiration || null;
      renewedAt = parsed.renewedAt || null;
    } catch {
      // ignore
    }
  }

  const lastEventTime = rawLastEventTime ? parseInt(rawLastEventTime, 10) : null;

  return {
    watchExpiration,
    renewedAt,
    lastEventTime,
  };
}
