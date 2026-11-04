// ─────────────────────────────────────────────────────────────────────────────
// Offline IP → city / region / country (MaxMind GeoLite2-City .mmdb).
// The reader is opened lazily from env.GEOIP_DB_PATH; a missing / unreadable
// file logs one warning and every lookup returns nulls. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import maxmind, { type CityResponse, type Reader } from "maxmind";
import { env } from "@/config/env";
import { normalizeIp, isPrivateIp, LOCAL_NETWORK, type GeoLocation } from "./ip";

export type { GeoLocation } from "./ip";

const EMPTY: GeoLocation = { city: null, region: null, country: null };

let readerPromise: Promise<Reader<CityResponse> | null> | null = null;

function getReader(): Promise<Reader<CityResponse> | null> {
  if (!readerPromise) {
    readerPromise = (async () => {
      const file = path.resolve(env.GEOIP_DB_PATH);
      try {
        if (!fs.existsSync(file)) {
          console.warn(`⚠️  GeoIP: ${file} not found — login locations will be blank.`);
          return null;
        }
        return await maxmind.open<CityResponse>(file, { cache: { max: 5000 } });
      } catch (err) {
        console.warn(`⚠️  GeoIP: could not open ${file} — login locations will be blank.`, err);
        return null;
      }
    })();
  }
  return readerPromise;
}

export async function lookupIp(ip: string | null | undefined): Promise<GeoLocation> {
  try {
    const v = normalizeIp(ip);
    if (!v) return { ...EMPTY };
    if (isPrivateIp(v)) return { city: null, region: null, country: LOCAL_NETWORK };
    if (!maxmind.validate(v)) return { ...EMPTY };

    const reader = await getReader();
    if (!reader) return { ...EMPTY };
    const hit = reader.get(v);
    if (!hit) return { ...EMPTY };
    return {
      city: hit.city?.names?.en?.slice(0, 100) ?? null,
      region: hit.subdivisions?.[0]?.names?.en?.slice(0, 100) ?? null,
      country: hit.country?.names?.en?.slice(0, 100) ?? hit.registered_country?.names?.en?.slice(0, 100) ?? null,
    };
  } catch (err) {
    console.error("GeoIP lookup failed:", err);
    return { ...EMPTY };
  }
}
