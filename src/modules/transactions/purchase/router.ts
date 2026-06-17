import { router, guardedProcedure } from "@/lib/trpc";
import { z } from "zod";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { generateBillNo } from "@/lib/transactionQueries";
import {
  ListTxSchema,
  GetByIdSchema,
  CreatePurchaseSchema,
  UpdatePurchaseSchema,
  DeleteTxSchema,
  UpdateGSTPurchaseConversionSchema,
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
} from "./service";

export const purchaseRouter = router({
  list: guardedProcedure("purchase", "purchase", "view").input(ListTxSchema).query(async ({ input }) => listPurchases(input)),
  listGSTPurchaseHistory: guardedProcedure("purchase", "purchase", "view").input(ListTxSchema).query(async ({ input }) => listGSTPurchaseHistory(input)),
  getById: guardedProcedure("purchase", "purchase", "view").input(GetByIdSchema).query(async ({ input }) => getPurchaseById(input)),
  getNextNumbers: guardedProcedure("purchase", "purchase", "view").input(z.object({ accountId: z.string().uuid() })).query(async ({ input }) => {
    const res = await db.execute(sql`SELECT COALESCE(MAX(entry_no), 0) + 1 AS next_entry_no FROM entry_groups WHERE type = 'PURCHASE'`);
    const nextEntryNo = Number(res[0]?.next_entry_no || 1);
    const nextBillNo = await generateBillNo(db, input.accountId, "PURCHASE");
    return { entryNo: String(nextEntryNo), billNo: String(nextBillNo) };
  }),
  create: guardedProcedure("purchase", "purchase", "edit").input(CreatePurchaseSchema).mutation(async ({ input }) => createPurchase(input)),
  update: guardedProcedure("purchase", "purchase", "edit").input(UpdatePurchaseSchema).mutation(async ({ input }) => updatePurchase(input)),
  delete: guardedProcedure("purchase", "purchase", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deletePurchase(input)),
  updateGSTPurchaseConversion: guardedProcedure("purchase", "purchase", "edit").input(UpdateGSTPurchaseConversionSchema).mutation(async ({ input }) => updateGSTPurchaseConversion(input)),
  undoGSTPurchaseConversion: guardedProcedure("purchase", "purchase", "edit").input(GetByIdSchema).mutation(async ({ input }) => undoGSTPurchaseConversion(input.id)),
});

