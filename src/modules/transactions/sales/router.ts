import { router, guardedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { generateBillNo } from "@/lib/transactionQueries";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateSalesSchema,
  UpdateSalesSchema,
  DeleteTxSchema,
  UpdateGSTConversionSchema,
  ConvertGoldToCashSchema,
  ConvertCashToGoldSchema,
} from "./schema";
import {
  listSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
  updateGSTConversion,
  listGSTHistory,
  undoGSTConversion,
  convertGoldToCash,
  convertCashToGold,
} from "./service";

export const salesRouter = router({
  list: guardedProcedure("sales", "sales", "view").input(ListTxSchema).query(async ({ input }) => listSales(input)),
  listGSTHistory: guardedProcedure("sales", "sales", "view").input(ListTxSchema).query(async ({ input }) => listGSTHistory(input)),
  getById: guardedProcedure("sales", "sales", "view").input(GetByIdSchema).query(async ({ input }) => getSaleById(input)),
  getNextNumbers: guardedProcedure("sales", "sales", "view").input(z.object({ accountId: z.string().uuid().optional().nullable() })).query(async ({ input }) => {
    const res = await db.execute(sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM entry_groups WHERE type = 'SALE'`);
    const nextEntryNo = Number(res[0]?.next_entry_no || 1);
    let nextBillNo = "";
    if (input.accountId) {
      const generated = await generateBillNo(db, input.accountId, "SALE");
      nextBillNo = String(generated);
    }
    return { entryNo: String(nextEntryNo), billNo: nextBillNo };
  }),
  create: guardedProcedure("sales", "sales", "edit").input(CreateSalesSchema).mutation(async ({ input, ctx }) => createSale(input, ctx.user!)),
  update: guardedProcedure("sales", "sales", "edit").input(UpdateSalesSchema).mutation(async ({ input, ctx }) => updateSale(input, ctx.user!)),
  delete: guardedProcedure("sales", "sales", "delete").input(DeleteTxSchema).mutation(async ({ input, ctx }) => deleteSale(input, ctx.user!)),
  updateGSTConversion: guardedProcedure("sales", "sales", "edit").input(UpdateGSTConversionSchema).mutation(async ({ input }) => updateGSTConversion(input)),
  undoGSTConversion: guardedProcedure("sales", "sales", "edit").input(GetByIdSchema).mutation(async ({ input }) => undoGSTConversion(input.id)),
  convertGoldToCash: guardedProcedure("sales", "sales", "edit").input(ConvertGoldToCashSchema).mutation(async ({ input }) => convertGoldToCash(input)),
  convertCashToGold: guardedProcedure("sales", "sales", "edit").input(ConvertCashToGoldSchema).mutation(async ({ input }) => convertCashToGold(input)),
  getLatestPurchaseRate: guardedProcedure("sales", "sales", "view").query(async () => {
    const res = await db.execute(sql`
      SELECT rate_per_gram 
      FROM entry_groups 
      WHERE type = 'PURCHASE' AND is_deleted = false
      ORDER BY date DESC, entry_no DESC 
      LIMIT 1
    `);
    const rate = res[0]?.rate_per_gram ? Number(res[0].rate_per_gram) : 0;
    return { rate };
  }),
});
