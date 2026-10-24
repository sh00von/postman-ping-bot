import { describe, it, expect } from "vitest";
import {
  parseFromHeader,
  parseAddressListHeader,
  isSenderMatch,
  findMatchingRule,
  findMatchingRecipientRule,
  normalizePattern,
  parseBulkPatterns,
} from "../lib/match.js";

describe("lib/match", () => {
  describe("parseFromHeader", () => {
    it("should parse standard Name <email> headers", () => {
      const res = parseFromHeader("Boss Person <boss@company.com>");
      expect(res.senderName).toBe("Boss Person");
      expect(res.senderEmail).toBe("boss@company.com");
    });

    it("should strip quotes from display name", () => {
      const res = parseFromHeader('"Support, VIP" <vip@service.io>');
      expect(res.senderName).toBe("Support, VIP");
      expect(res.senderEmail).toBe("vip@service.io");
    });

    it("should handle bare email without angle brackets", () => {
      const res = parseFromHeader("simple@domain.org");
      expect(res.senderName).toBe("");
      expect(res.senderEmail).toBe("simple@domain.org");
    });

    it("should handle only angle brackets", () => {
      const res = parseFromHeader("<onlyemail@test.com>");
      expect(res.senderName).toBe("");
      expect(res.senderEmail).toBe("onlyemail@test.com");
    });

    it("should normalize email to lowercase", () => {
      const res = parseFromHeader("User <MiXeD.CaSe@CoMpAnY.CoM>");
      expect(res.senderEmail).toBe("mixed.case@company.com");
    });
  });

  describe("normalizePattern", () => {
    it("should normalize plain domains to start with @", () => {
      expect(normalizePattern("wpscan.com")).toBe("@wpscan.com");
      expect(normalizePattern("@wpscan.com")).toBe("@wpscan.com");
      expect(normalizePattern("sub.domain.co.uk")).toBe("@sub.domain.co.uk");
    });

    it("should unpack Telegram Markdown auto-links", () => {
      // User typed /add wpscan.com and Telegram turned it into markdown [wpscan.com](https://wpscan.com/)
      expect(normalizePattern("[wpscan.com](https://wpscan.com/)")).toBe("@wpscan.com");
      // Telegram @ username link: [@wpscan](https://t.me/wpscan).com
      expect(normalizePattern("[@wpscan](https://t.me/wpscan).com")).toBe("@wpscan.com");
    });

    it("should strip URLs and protocols", () => {
      expect(normalizePattern("https://wpscan.com")).toBe("@wpscan.com");
      expect(normalizePattern("http://wpscan.com/")).toBe("@wpscan.com");
      expect(normalizePattern("https://wpscan.com/features?ref=1#faq")).toBe("@wpscan.com");
    });

    it("should normalize exact email addresses and mailto links", () => {
      expect(normalizePattern("boss@company.com")).toBe("boss@company.com");
      expect(normalizePattern("mailto:boss@company.com")).toBe("boss@company.com");
      expect(normalizePattern("[Boss](mailto:boss@company.com)")).toBe("boss@company.com");
      expect(normalizePattern("<boss@company.com>")).toBe("boss@company.com");
      expect(normalizePattern('"boss@company.com"')).toBe("boss@company.com");
    });

    it("should reject completely invalid entries", () => {
      expect(normalizePattern("")).toBeNull();
      expect(normalizePattern("not-a-domain")).toBeNull();
      expect(normalizePattern("hello world")).toBeNull();
      expect(normalizePattern("http://")).toBeNull();
    });
  });

  describe("parseBulkPatterns", () => {
    it("should parse multiple space- and comma-separated items", () => {
      const input = "boss@company.com, wpscan.com, @bank.com   alerts@server.io";
      const res = parseBulkPatterns(input);

      expect(res.valid).toEqual([
        "boss@company.com",
        "@wpscan.com",
        "@bank.com",
        "alerts@server.io",
      ]);
      expect(res.invalid).toEqual([]);
    });

    it("should handle newlines and ignore standalone priority keywords", () => {
      const input = "boss@company.com urgent\nhttps://wpscan.com\ninvalid_token";
      const res = parseBulkPatterns(input);

      expect(res.valid).toContain("boss@company.com");
      expect(res.valid).toContain("@wpscan.com");
      expect(res.invalid).toContain("invalid_token");
      expect(res.valid).not.toContain("urgent");
    });
  });

  describe("isSenderMatch", () => {
    it("should match exact email address case-insensitively", () => {
      expect(isSenderMatch("boss@company.com", "boss@company.com")).toBe(true);
      expect(isSenderMatch("Boss@Company.COM", "boss@company.com")).toBe(true);
      expect(isSenderMatch("boss@company.com", "BOSS@COMPANY.COM")).toBe(true);
      expect(isSenderMatch("other@company.com", "boss@company.com")).toBe(false);
    });

    it("should match domain patterns with @", () => {
      expect(isSenderMatch("security@chase.com", "@chase.com")).toBe(true);
      expect(isSenderMatch("alerts@sub.chase.com", "@chase.com")).toBe(true);
      expect(isSenderMatch("hacker@not-chase.com", "@chase.com")).toBe(false);
      expect(isSenderMatch("hacker@chase.com.attacker.com", "@chase.com")).toBe(false);
    });

    it("should match domain patterns without @", () => {
      expect(isSenderMatch("admin@google.com", "google.com")).toBe(true);
      expect(isSenderMatch("notifications@mail.google.com", "google.com")).toBe(true);
      expect(isSenderMatch("fraud@google.com.phish.org", "google.com")).toBe(false);
    });

    it("should prevent display name spoofing", () => {
      const parsed = parseFromHeader('"Boss <boss@company.com>" <attacker@evil.com>');
      expect(parsed.senderEmail).toBe("attacker@evil.com");
      expect(isSenderMatch(parsed.senderEmail, "boss@company.com")).toBe(false);
    });
  });

  describe("findMatchingRule", () => {
    const watchlist = [
      { pattern: "boss@company.com", priority: "urgent" },
      { pattern: "@bank.com", priority: "normal" },
    ];

    it("should return the matching rule when email matches", () => {
      const match = findMatchingRule("boss@company.com", watchlist);
      expect(match).not.toBeNull();
      expect(match?.pattern).toBe("boss@company.com");
      expect(match?.priority).toBe("urgent");
    });

    it("should return the matching rule when domain matches", () => {
      const match = findMatchingRule("statements@bank.com", watchlist);
      expect(match).not.toBeNull();
      expect(match?.pattern).toBe("@bank.com");
    });

    it("should return null when sender is not in watchlist", () => {
      const match = findMatchingRule("spam@promo.com", watchlist);
      expect(match).toBeNull();
    });
  });

  describe("parseAddressListHeader", () => {
    it("should parse a single address with display name", () => {
      expect(parseAddressListHeader("Minaruzzaman <hello@shovon.bd>")).toEqual([
        "hello@shovon.bd",
      ]);
    });

    it("should parse multiple addresses", () => {
      expect(
        parseAddressListHeader("hello@shovon.bd, Sales <sales@shovon.bd>")
      ).toEqual(["hello@shovon.bd", "sales@shovon.bd"]);
    });

    it("should not split on commas inside quoted display names", () => {
      expect(
        parseAddressListHeader('"Support, VIP" <vip@service.io>, boss@company.com')
      ).toEqual(["vip@service.io", "boss@company.com"]);
    });

    it("should lowercase addresses and drop non-address parts", () => {
      expect(
        parseAddressListHeader("Hello@Shovon.BD, undisclosed-recipients:;")
      ).toEqual(["hello@shovon.bd"]);
    });

    it("should return an empty list for an empty header", () => {
      expect(parseAddressListHeader("")).toEqual([]);
    });
  });

  describe("findMatchingRecipientRule", () => {
    const recipientWatchlist = [
      { pattern: "hello@shovon.bd" },
      { pattern: "@example.org" },
    ];

    it("should match an exact recipient address and report it", () => {
      const match = findMatchingRecipientRule(
        ["hello@shovon.bd"],
        recipientWatchlist
      );
      expect(match).not.toBeNull();
      expect(match?.pattern).toBe("hello@shovon.bd");
      expect(match?.recipientEmail).toBe("hello@shovon.bd");
    });

    it("should match any address on a watched domain", () => {
      const match = findMatchingRecipientRule(
        ["anyone@example.org"],
        recipientWatchlist
      );
      expect(match).not.toBeNull();
      expect(match?.pattern).toBe("@example.org");
      expect(match?.recipientEmail).toBe("anyone@example.org");
    });

    it("should match a subdomain of a watched domain", () => {
      const match = findMatchingRecipientRule(
        ["user@mail.example.org"],
        recipientWatchlist
      );
      expect(match).not.toBeNull();
      expect(match?.pattern).toBe("@example.org");
    });

    it("should return null when no recipient matches", () => {
      const match = findMatchingRecipientRule(
        ["someone@other.com"],
        recipientWatchlist
      );
      expect(match).toBeNull();
    });
  });
});
