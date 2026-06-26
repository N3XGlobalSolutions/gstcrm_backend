import { router, guardedProcedure } from "@/lib/trpc";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateLabourBillSchema,
  UpdateLabourBillSchema,
  DeleteTxSchema,
  CreateCycleSchema,
  ListCyclesSchema,
  GetCycleDetailSchema,
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
} from "./service";

export const labourBillRouter = router({
  list:     guardedProcedure("labourBill", "labourBill", "view").input(ListTxSchema).query(async ({ input }) => listLabourBills(input)),
  getById:  guardedProcedure("labourBill", "labourBill", "view").input(GetByIdSchema).query(async ({ input }) => getLabourBillById(input)),
  create:   guardedProcedure("labourBill", "labourBill", "edit").input(CreateLabourBillSchema).mutation(async ({ input }) => createLabourBill(input)),
  update:   guardedProcedure("labourBill", "labourBill", "edit").input(UpdateLabourBillSchema).mutation(async ({ input }) => updateLabourBill(input)),
  delete:   guardedProcedure("labourBill", "labourBill", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deleteLabourBill(input)),

  // Bill Cycle routes
  createCycle:    guardedProcedure("labourBill", "labourBill", "edit").input(CreateCycleSchema).mutation(async ({ input }) => createCycle(input)),
  listCycles:     guardedProcedure("labourBill", "labourBill", "view").input(ListCyclesSchema).query(async ({ input }) => listCycles(input)),
  getCycleDetail: guardedProcedure("labourBill", "labourBill", "view").input(GetCycleDetailSchema).query(async ({ input }) => getCycleDetail(input)),
});
