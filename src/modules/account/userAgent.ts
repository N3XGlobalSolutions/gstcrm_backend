// ─────────────────────────────────────────────────────────────────────────────
// User-agent → "Chrome 141" / "Windows 10" / desktop|mobile|tablet.
// ua-parser-js v1 (MIT) — do NOT upgrade to v2 (AGPL). Pure, no db/env.
// ─────────────────────────────────────────────────────────────────────────────

import UAParser from "ua-parser-js";

export type DeviceType = "desktop" | "mobile" | "tablet";

export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
  deviceType: DeviceType | null;
}

const MAX_LEN = 100;

function join(name: string | undefined, version: string | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  const v = version?.trim();
  return (v ? `${n} ${v}` : n).slice(0, MAX_LEN);
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua || !ua.trim()) return { browser: null, os: null, deviceType: null };

  let result: UAParser.IResult;
  try {
    result = new UAParser(ua.slice(0, 1000)).getResult();
  } catch {
    return { browser: null, os: null, deviceType: null };
  }

  const browser = join(result.browser.name, result.browser.major ?? result.browser.version);
  const os = join(result.os.name, result.os.version);

  let deviceType: DeviceType | null;
  switch (result.device.type) {
    case "mobile":
    case "wearable":
      deviceType = "mobile";
      break;
    case "tablet":
      deviceType = "tablet";
      break;
    default:
      // No device type = a desktop browser (ua-parser only tags handheld/TV/console).
      deviceType = browser || os ? "desktop" : null;
  }

  return { browser, os, deviceType };
}

/** "Chrome 141 / Windows 10" (or whichever part is known; "Unknown device"). */
export function describeDevice(parsed: Pick<ParsedUserAgent, "browser" | "os">): string {
  const parts = [parsed.browser, parsed.os].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Unknown device";
}
