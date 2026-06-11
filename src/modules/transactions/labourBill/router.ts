import { router, guardedProcedure } from "@/lib/trpc";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateLabourBillSchema,
  UpdateLabourBillSchema,
  DeleteTxSchema,
} from "./schema";
import { listLabourBills, getLabourBillById, createLabourBill, updateLabourBill, deleteLabourBill } from "./service";

export const labourBillRouter = router({
  list: guardedProcedure("labourBill", "labourBill", "view").input(ListTxSchema).query(async ({ input }) => listLabourBills(input)),
  getById: guardedProcedure("labourBill", "labourBill", "view").input(GetByIdSchema).query(async ({ input }) => getLabourBillById(input)),
  create: guardedProcedure("labourBill", "labourBill", "edit").input(CreateLabourBillSchema).mutation(async ({ input }) => createLabourBill(input)),
  update: guardedProcedure("labourBill", "labourBill", "edit").input(UpdateLabourBillSchema).mutation(async ({ input }) => updateLabourBill(input)),
  delete: guardedProcedure("labourBill", "labourBill", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deleteLabourBill(input)),
});
