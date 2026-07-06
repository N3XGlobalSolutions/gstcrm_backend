/**
 * Shared date-range resolver for period-scoped reports (dashboard, profit/loss).
 *
 * Resolves a range keyword (or an explicit custom range) into inclusive
 * `from`/`to` date strings (YYYY-MM-DD) that filter on `entry_groups.date`.
 * `all` returns { from: null, to: null } meaning "no lower/upper bound".
 *
 * NOTE: `today`/`week`/`month`/`custom` intentionally preserve the exact
 * behaviour previously inlined in dashboard/router.ts so dashboard metrics do
 * not shift. `year` and `all` are new options used by the profit/loss reports.
 */

export type RangeKey = "today" | "week" | "month" | "year" | "all" | "custom";

export interface DateRangeInput {
  range: RangeKey;
  from_date?: string;
  to_date?: string;
}

export interface ResolvedDateRange {
  from: string | null;
  to: string | null;
}

export function resolveDateRange(input: DateRangeInput): ResolvedDateRange {
  const now = new Date();
  const today = now.toISOString().split("T")[0]!;

  switch (input.range) {
    case "today":
      return { from: today, to: today };
    case "week": {
      const from = new Date(now);
      from.setDate(from.getDate() - 7);
      return { from: from.toISOString().split("T")[0]!, to: today };
    }
    case "month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: from.toISOString().split("T")[0]!, to: today };
    }
    case "year": {
      const from = new Date(now.getFullYear(), 0, 1);
      return { from: from.toISOString().split("T")[0]!, to: today };
    }
    case "all":
      return { from: null, to: null };
    case "custom":
    default:
      return {
        from: input.from_date ?? today,
        to: input.to_date ?? today,
      };
  }
}
