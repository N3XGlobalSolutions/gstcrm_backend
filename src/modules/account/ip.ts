// ─────────────────────────────────────────────────────────────────────────────
// IP helpers for login location — pure (no db/env), unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoLocation {
  city: string | null;
  region: string | null;
  country: string | null;
}

export const LOCAL_NETWORK = "Local network";

/** Trim and strip the IPv4-mapped "::ffff:" prefix. Empty → null. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let v = ip.trim();
  if (/^::ffff:/i.test(v) && v.includes(".")) v = v.slice(7);
  return v || null;
}

function ipv4Octets(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/**
 * Private / loopback / link-local addresses: 10/8, 172.16/12, 192.168/16, 127/8,
 * 169.254/16, 0.0.0.0, ::1, ::, fc00::/7, fe80::/10 (and ::ffff:-mapped IPv4 privates).
 */
export function isPrivateIp(ip: string | null | undefined): boolean {
  const v = normalizeIp(ip);
  if (!v) return false;

  const o = ipv4Octets(v);
  if (o) {
    const [a, b] = o as [number, number, number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 0 && o.every((x) => x === 0))
    );
  }

  const lower = v.toLowerCase().split("%")[0]!; // drop zone id (fe80::1%eth0)
  if (!lower.includes(":")) return false;
  if (lower === "::1" || lower === "::") return true;
  const first = lower.split(":")[0] ?? "";
  if (!first) return false;
  const head = parseInt(first.padStart(4, "0"), 16);
  if (Number.isNaN(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10
  return false;
}

/** "Chennai, Tamil Nadu, India" — known parts only, duplicates dropped; null when nothing known. */
export function formatLocation(geo: GeoLocation | null | undefined): string | null {
  if (!geo) return null;
  const parts: string[] = [];
  for (const p of [geo.city, geo.region, geo.country]) {
    const v = p?.trim();
    if (v && !parts.includes(v)) parts.push(v);
  }
  return parts.length ? parts.join(", ").slice(0, 150) : null;
}
