/**
 * Represents parsed email metadata relevant for alerting.
 */
export interface ParsedEmailHeader {
  rawFrom: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  date: string;
  recipientEmails: string[];
  /** Short plain-text preview from Gmail. Empty when Gmail returns none. */
  snippet: string;
}

/**
 * Extracts the actual email address and display name from an RFC 5322 From header.
 */
export function parseFromHeader(fromHeader = ""): { senderName: string; senderEmail: string } {
  const trimmed = fromHeader.trim();
  if (!trimmed) {
    return { senderName: "", senderEmail: "" };
  }

  // Look for the last <...> pair which contains the actual email address
  const bracketMatch = trimmed.match(/<([^>]+)>\s*$/);
  if (bracketMatch) {
    const senderEmail = bracketMatch[1].trim().toLowerCase();
    let senderName = trimmed.slice(0, bracketMatch.index).trim();
    // Strip surrounding quotes if present
    if (
      (senderName.startsWith('"') && senderName.endsWith('"')) ||
      (senderName.startsWith("'") && senderName.endsWith("'"))
    ) {
      senderName = senderName.slice(1, -1).trim();
    }
    return { senderName, senderEmail };
  }

  // If no angle brackets, check if the string itself is just an email
  const plainEmailMatch = trimmed.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (plainEmailMatch) {
    return { senderName: "", senderEmail: plainEmailMatch[0].toLowerCase() };
  }

  return { senderName: "", senderEmail: trimmed.toLowerCase() };
}

/**
 * Parses a To/Cc header value into a list of lowercase email addresses.
 * Handles display names (including quoted names that contain commas) and
 * bare addresses: `"Support, VIP" <vip@service.io>, boss@company.com`.
 * Non-address parts (e.g. "undisclosed-recipients") are dropped.
 */
export function parseAddressListHeader(headerValue = ""): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;

  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i];
    if (ch === '"' && headerValue[i - 1] !== "\\") {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === "<") {
      angleDepth++;
      current += ch;
    } else if (!inQuote && ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += ch;
    } else if (!inQuote && angleDepth === 0 && ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const emails: string[] = [];
  for (const part of parts) {
    const { senderEmail } = parseFromHeader(part);
    if (senderEmail && emailRegex.test(senderEmail)) {
      emails.push(senderEmail);
    }
  }
  return emails;
}

/**
 * Normalizes user-input patterns into clean, canonical watchlist formats:
 * - Domain without @ (e.g. "wpscan.com") -> "@wpscan.com"
 * - Domain with @ (e.g. "@wpscan.com") -> "@wpscan.com"
 * - URL (e.g. "https://wpscan.com/") -> "@wpscan.com"
 * - Markdown auto-link (e.g. "[wpscan.com](https://wpscan.com/)") -> "@wpscan.com"
 * - Telegram @-link (e.g. "[@wpscan](https://t.me/wpscan).com") -> "@wpscan.com"
 * - Exact email (e.g. "boss@company.com") -> "boss@company.com"
 * - Mailto URL (e.g. "mailto:boss@company.com") -> "boss@company.com"
 *
 * Returns null if the input cannot be resolved to a valid email or domain.
 */
export function normalizePattern(rawInput: string): string | null {
  if (!rawInput || typeof rawInput !== "string") {
    return null;
  }

  let text = rawInput.trim();

  // 1. Unpack Markdown links: [label](url)
  // If url contains email or mailto, use url; if label contains domain/email, use label
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    if (/mailto:|@/i.test(url)) {
      return url;
    }
    if (/@|\./.test(label)) {
      return label;
    }
    return url;
  });

  // 2. Strip surrounding angle brackets, quotes, and backticks
  text = text.replace(/^[<"'\s`]+|[>"'\s`]+$/g, "");

  // 3. Strip URL protocols: https://, http://, mailto:
  text = text.replace(/^(?:https?:\/\/|mailto:)/i, "");

  // 4. Strip path, query params, hash, trailing slashes
  // e.g. "wpscan.com/index.html?ref=1" => "wpscan.com"
  const slashIdx = text.indexOf("/");
  if (slashIdx !== -1) {
    text = text.slice(0, slashIdx);
  }
  const qIdx = text.indexOf("?");
  if (qIdx !== -1) {
    text = text.slice(0, qIdx);
  }
  const hashIdx = text.indexOf("#");
  if (hashIdx !== -1) {
    text = text.slice(0, hashIdx);
  }

  text = text.trim().toLowerCase();

  if (!text) return null;

  // 5. Check if it's an exact email address (user@domain.tld)
  const atCount = (text.match(/@/g) || []).length;
  if (atCount === 1 && !text.startsWith("@")) {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (emailRegex.test(text)) {
      return text;
    }
  }

  // 6. Check if it's a domain pattern
  let domain = text;
  if (domain.startsWith("@")) {
    domain = domain.slice(1);
  }

  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (domainRegex.test(domain)) {
    return `@${domain}`;
  }

  return null;
}

/**
 * Parses multiple space-, comma-, or newline-separated patterns from bulk user input.
 */
export function parseBulkPatterns(rawText: string): {
  valid: string[];
  invalid: string[];
} {
  if (!rawText) return { valid: [], invalid: [] };

  // Split on spaces, commas, semicolons, or newlines
  const tokens = rawText
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const validSet = new Set<string>();
  const invalidSet = new Set<string>();

  for (const token of tokens) {
    // Ignore stand-alone priority flag keywords
    if (["urgent", "normal", "quiet"].includes(token.toLowerCase())) {
      continue;
    }

    const normalized = normalizePattern(token);
    if (normalized) {
      validSet.add(normalized);
    } else {
      invalidSet.add(token);
    }
  }

  return {
    valid: Array.from(validSet),
    invalid: Array.from(invalidSet),
  };
}

/**
 * Checks if a sender email matches a watchlist pattern.
 * Supports:
 * - Exact email: "boss@company.com"
 * - Domain: "@bank.com" (also handles legacy "bank.com" without @)
 */
export function isSenderMatch(senderEmail: string, pattern: string): boolean {
  if (!senderEmail || !pattern) return false;

  const normalizedSender = senderEmail.trim().toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();

  // 1. Exact email match
  if (normalizedSender === normalizedPattern) {
    return true;
  }

  // 2. Domain pattern
  const senderDomain = normalizedSender.includes("@")
    ? normalizedSender.split("@").pop() || ""
    : normalizedSender;

  let patternDomain = normalizedPattern;
  if (patternDomain.startsWith("@")) {
    patternDomain = patternDomain.slice(1);
  }

  // Match root domain or subdomain (e.g. "@bank.com" matches "bank.com" and "mail.bank.com")
  if (
    senderDomain === patternDomain ||
    senderDomain.endsWith("." + patternDomain)
  ) {
    return true;
  }

  return false;
}

/**
 * Finds which watchlist pattern matched the sender, if any.
 */
export function findMatchingRule(
  senderEmail: string,
  watchlist: Array<{ pattern: string; priority?: string }>
): { pattern: string; priority?: string } | null {
  for (const item of watchlist) {
    if (isSenderMatch(senderEmail, item.pattern)) {
      return item;
    }
  }
  return null;
}

/**
 * Finds which recipient (forwarder) rule matched one of the message's
 * recipient addresses, if any. Matching semantics are identical to sender
 * rules: an exact address ("hello@shovon.bd") or a domain pattern
 * ("@shovon.bd", which also matches subdomains like "mail.shovon.bd").
 * Returns the matched rule plus the actual recipient address that matched,
 * so alerts can say which of your addresses the mail was sent to.
 */
export function findMatchingRecipientRule(
  recipientEmails: string[],
  recipientWatchlist: Array<{ pattern: string }>
): { pattern: string; recipientEmail: string } | null {
  for (const recipientEmail of recipientEmails || []) {
    for (const item of recipientWatchlist) {
      if (isSenderMatch(recipientEmail, item.pattern)) {
        return { pattern: item.pattern, recipientEmail };
      }
    }
  }
  return null;
}
