// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT (login history helpers) — pure unit tests (no database, no env).
// User-agent parsing and private-IP detection / location text.
// Ported from Gold CRM (password-policy / lockout tests not ported: GST CRM has
// no password policy or account lockout).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "bun:test";
import { parseUserAgent, describeDevice } from "../userAgent";
import { normalizeIp, isPrivateIp, formatLocation, LOCAL_NETWORK } from "../ip";

// ─── parseUserAgent ───────────────────────────────────────────────────────────

describe("parseUserAgent", () => {
  it("Chrome on Windows → desktop", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome 141", os: "Windows 10", deviceType: "desktop" });
  });

  it("Safari on iPhone → mobile", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ browser: "Mobile Safari 17", os: "iOS 17.4", deviceType: "mobile" });
  });

  it("Chrome on Android phone → mobile", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ browser: "Chrome 141", os: "Android 14", deviceType: "mobile" });
  });

  it("iPad → tablet", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      ).deviceType,
    ).toBe("tablet");
  });

  it("Edge on macOS and Firefox on Ubuntu", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toEqual({ browser: "Edge 141", os: "Mac OS 10.15.7", deviceType: "desktop" });
    expect(parseUserAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0").browser).toBe(
      "Firefox 131",
    );
  });

  it("empty / unknown → all null", () => {
    const none = { browser: null, os: null, deviceType: null };
    expect(parseUserAgent(null)).toEqual(none);
    expect(parseUserAgent(undefined)).toEqual(none);
    expect(parseUserAgent("   ")).toEqual(none);
    expect(parseUserAgent("curl/8.4.0")).toEqual(none);
  });

  it("describeDevice", () => {
    expect(describeDevice({ browser: "Chrome 141", os: "Windows 10" })).toBe("Chrome 141 / Windows 10");
    expect(describeDevice({ browser: null, os: "iOS 17.4" })).toBe("iOS 17.4");
    expect(describeDevice({ browser: null, os: null })).toBe("Unknown device");
  });
});

// ─── IP helpers ───────────────────────────────────────────────────────────────

describe("normalizeIp", () => {
  it("strips ::ffff: from IPv4-mapped addresses", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp(" 8.8.8.8 ")).toBe("8.8.8.8");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe("isPrivateIp", () => {
  it("IPv4 private / loopback ranges", () => {
    for (const ip of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.10", "127.0.0.1", "169.254.1.1", "0.0.0.0"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("IPv4 public, incl. the edges of 172.16/12", () => {
    for (const ip of ["8.8.8.8", "1.2.3.4", "172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "49.204.10.20"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("IPv6 loopback, ULA fc00::/7, link-local fe80::/10", () => {
    for (const ip of ["::1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%eth0", "febf::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["2001:4860:4860::8888", "fec0::1", "2400:cb00::1"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("IPv4-mapped privates", () => {
    expect(isPrivateIp("::ffff:192.168.0.5")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("garbage is not private", () => {
    expect(isPrivateIp(null)).toBe(false);
    expect(isPrivateIp("")).toBe(false);
    expect(isPrivateIp("not-an-ip")).toBe(false);
    expect(isPrivateIp("999.1.1.1")).toBe(false);
  });
});

describe("formatLocation", () => {
  it("joins known parts, drops duplicates", () => {
    expect(formatLocation({ city: "Chennai", region: "Tamil Nadu", country: "India" })).toBe("Chennai, Tamil Nadu, India");
    expect(formatLocation({ city: null, region: null, country: LOCAL_NETWORK })).toBe("Local network");
    expect(formatLocation({ city: "Singapore", region: null, country: "Singapore" })).toBe("Singapore");
    expect(formatLocation({ city: null, region: null, country: null })).toBeNull();
    expect(formatLocation(null)).toBeNull();
  });
});

