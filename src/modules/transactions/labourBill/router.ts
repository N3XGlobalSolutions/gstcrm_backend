import { router, guardedProcedure } from "@/lib/trpc";
import { notifyBillEdited } from "@/modules/notifications/service";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateLabourBillSchema,
  UpdateLabourBillSchema,
  DeleteTxSchema,
  CreateCycleSchema,
  ListCyclesSchema,
  GetCycleDetailSchema,
  ConvertGoldToCashSchema,
  ConvertCashToGoldSchema,
} from "./schema";
import {
  listLabourBills,
  getLabourBillById,
  createLabourBill,
  updateLabourBill,
  deleteLabourBill,
  createCycle,
  listCycles,
  getCycleDetail,
  convertGoldToCash,
  convertCashToGold,
} from "./service";

export const labourBillRouter = router({
  list:     guardedProcedure("labourBill", "labourBill", "view").input(ListTxSchema).query(async ({ input }) => listLabourBills(input)),
  getById:  guardedProcedure("labourBill", "labourBill", "view").input(GetByIdSchema).query(async ({ input }) => getLabourBillById(input)),
  create:   guardedProcedure("labourBill", "labourBill", "edit").input(CreateLabourBillSchema).mutation(async ({ input }) => createLabourBill(input)),
  update:   guardedProcedure("labourBill", "labourBill", "edit").input(UpdateLabourBillSchema).mutation(async ({ input, ctx }) => {
    const result = await updateLabourBill(input);
    await notifyBillEdited("Labour Bill", result.group.bill_no, ctx.user!);
    return result;
  }),
  delete:   guardedProcedure("labourBill", "labourBill", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deleteLabourBill(input)),

  // Bill Cycle routes
  createCycle:    guardedProcedure("labourBill", "labourBill", "edit").input(CreateCycleSchema).mutation(async ({ input }) => createCycle(input)),
  listCycles:     guardedProcedure("labourBill", "labourBill", "view").input(ListCyclesSchema).query(async ({ input }) => listCycles(input)),
  getCycleDetail: guardedProcedure("labourBill", "labourBill", "view").input(GetCycleDetailSchema).query(async ({ input }) => getCycleDetail(input)),

  // Opening-balance gold/cash conversion
  convertGoldToCash: guardedProcedure("labourBill", "labourBill", "edit").input(ConvertGoldToCashSchema).mutation(async ({ input }) => convertGoldToCash(input)),
  convertCashToGold: guardedProcedure("labourBill", "labourBill", "edit").input(ConvertCashToGoldSchema).mutation(async ({ input }) => convertCashToGold(input)),
});
