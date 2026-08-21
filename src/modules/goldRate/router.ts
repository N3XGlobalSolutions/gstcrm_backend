import { router, protectedProcedure } from "@/lib/trpc";
import { getCoimbatoreGoldRate } from "./service";

export const goldRateRouter = router({
  coimbatore: protectedProcedure.query(async () => {
    return getCoimbatoreGoldRate();
  }),
});
