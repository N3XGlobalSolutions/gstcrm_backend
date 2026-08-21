const GROWW_URL =
  "https://cmsapi.groww.in/api/v1/metal-rates/monthly-movements/coimbatore?howManyMonth=1&metal=gold";

const CACHE_TTL_MS = 5 * 60 * 1000;

type GoldRateResult = {
  location: string;
  pricePerGram24k: number;
  pricePerGram22k: number;
  pricePerGram18k: number;
  date: string;
  changePercent: number;
  direction: "rising" | "falling" | "flat";
};

let cache: { data: GoldRateResult; fetchedAt: number } | null = null;

export async function getCoimbatoreGoldRate(): Promise<GoldRateResult> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const res = await fetch(GROWW_URL);
  if (!res.ok) {
    if (cache) return cache.data;
    throw new Error(`Failed to fetch gold rate: ${res.status}`);
  }

  const json = (await res.json()) as {
    location?: string;
    months?: Array<{
      trend?: { changePercent?: number; direction?: "rising" | "falling" | "flat" };
      gold?: Record<string, { last?: { price?: number; date?: string } }>;
    }>;
  };
  const month = json.months?.[0];
  const gold24 = month?.gold?.TWENTY_FOUR;
  const gold22 = month?.gold?.TWENTY_TWO;
  const gold18 = month?.gold?.EIGHTEEN;

  if (!gold24?.last?.price) {
    if (cache) return cache.data;
    throw new Error("Unexpected gold rate API response");
  }

  const result: GoldRateResult = {
    location: json.location ?? "Coimbatore",
    pricePerGram24k: gold24.last.price,
    pricePerGram22k: gold22?.last?.price ?? 0,
    pricePerGram18k: gold18?.last?.price ?? 0,
    date: gold24.last.date ?? new Date().toISOString().slice(0, 10),
    changePercent: month?.trend?.changePercent ?? 0,
    direction: month?.trend?.direction ?? "flat",
  };

  cache = { data: result, fetchedAt: Date.now() };
  return result;
}
