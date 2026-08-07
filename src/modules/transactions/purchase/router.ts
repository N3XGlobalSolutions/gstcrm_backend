import { router, guardedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { generateBillNo } from "@/lib/transactionQueries";
import { notifyBillEdited } from "@/modules/notifications/service";
import {
  ListTxSchema,
  GetByIdSchema,
  CreatePurchaseSchema,
  UpdatePurchaseSchema,
  DeleteTxSchema,
  UpdateGSTPurchaseConversionSchema,
  ConvertGoldToCashSchema,
  ConvertCashToGoldSchema,
} from "./schema";
import {
  listPurchases,
  getPurchaseById,
  createPurchase,
  updatePurchase,
  deletePurchase,
  updateGSTPurchaseConversion,
  listGSTPurchaseHistory,
  undoGSTPurchaseConversion,
  convertGoldToCash,
  convertCashToGold,
} from "./service";

export const purchaseRouter = router({
  list: guardedProcedure("purchase", "purchase", "view").input(ListTxSchema).query(async ({ input }) => listPurchases(input)),
  listGSTPurchaseHistory: guardedProcedure("purchase", "purchase", "view").input(ListTxSchema).query(async ({ input }) => listGSTPurchaseHistory(input)),
  getById: guardedProcedure("purchase", "purchase", "view").input(GetByIdSchema).query(async ({ input }) => getPurchaseById(input)),
  getNextNumbers: guardedProcedure("purchase", "purchase", "view").input(z.object({ accountId: z.string().uuid().optional().nullable() })).query(async ({ input }) => {
    const res = await db.execute(sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM entry_groups WHERE type = 'PURCHASE'`);
    const nextEntryNo = Number(res[0]?.next_entry_no || 1);
    let nextBillNo = "";
    if (input.accountId) {
      const generated = await generateBillNo(db, input.accountId, "PURCHASE");
      nextBillNo = String(generated);
    }
    return { entryNo: String(nextEntryNo), billNo: nextBillNo };
  }),
  create: guardedProcedure("purchase", "purchase", "edit").input(CreatePurchaseSchema).mutation(async ({ input }) => createPurchase(input)),
  update: guardedProcedure("purchase", "purchase", "edit").input(UpdatePurchaseSchema).mutation(async ({ input, ctx }) => {
    const result = await updatePurchase(input);
    await notifyBillEdited("Purchase Bill", result.group.bill_no, ctx.user!);
    return result;
  }),
  delete: guardedProcedure("purchase", "purchase", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deletePurchase(input)),
  updateGSTPurchaseConversion: guardedProcedure("purchase", "purchase", "edit").input(UpdateGSTPurchaseConversionSchema).mutation(async ({ input }) => updateGSTPurchaseConversion(input)),
  undoGSTPurchaseConversion: guardedProcedure("purchase", "purchase", "edit").input(GetByIdSchema).mutation(async ({ input }) => undoGSTPurchaseConversion(input.id)),
  convertGoldToCash: guardedProcedure("purchase", "purchase", "edit").input(ConvertGoldToCashSchema).mutation(async ({ input }) => convertGoldToCash(input)),
  convertCashToGold: guardedProcedure("purchase", "purchase", "edit").input(ConvertCashToGoldSchema).mutation(async ({ input }) => convertCashToGold(input)),
});

