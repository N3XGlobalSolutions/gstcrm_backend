import { router, guardedProcedure } from "@/lib/trpc";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateSalesSchema,
  UpdateSalesSchema,
  DeleteTxSchema,
  UpdateGSTConversionSchema,
} from "./schema";
import {
  listSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
  updateGSTConversion,
  listGSTHistory,
} from "./service";

export const salesRouter = router({
  list: guardedProcedure("sales", "sales", "view").input(ListTxSchema).query(async ({ input }) => listSales(input)),
  listGSTHistory: guardedProcedure("sales", "sales", "view").input(ListTxSchema).query(async ({ input }) => listGSTHistory(input)),
  getById: guardedProcedure("sales", "sales", "view").input(GetByIdSchema).query(async ({ input }) => getSaleById(input)),
  create: guardedProcedure("sales", "sales", "edit").input(CreateSalesSchema).mutation(async ({ input, ctx }) => createSale(input, ctx.user!)),
  update: guardedProcedure("sales", "sales", "edit").input(UpdateSalesSchema).mutation(async ({ input, ctx }) => updateSale(input, ctx.user!)),
  delete: guardedProcedure("sales", "sales", "delete").input(DeleteTxSchema).mutation(async ({ input, ctx }) => deleteSale(input, ctx.user!)),
  updateGSTConversion: guardedProcedure("sales", "sales", "edit").input(UpdateGSTConversionSchema).mutation(async ({ input }) => updateGSTConversion(input)),
});
