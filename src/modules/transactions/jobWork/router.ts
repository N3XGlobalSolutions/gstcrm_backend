import { router, guardedProcedure } from "@/lib/trpc";
import { notifyBillEdited } from "@/modules/notifications/service";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateJobWorkSchema,
  UpdateJobWorkSchema,
  DeleteTxSchema,
  CreateCycleSchema,
  ListCyclesSchema,
  GetCycleDetailSchema,
  ConvertGoldToCashSchema,
  ConvertCashToGoldSchema,
  ReceiveCashSchema,
} from "./schema";
import {
  listJobWork,
  getJobWorkById,
  createJobWork,
  updateJobWork,
  deleteJobWork,
  createCycle,
  listCycles,
  getCycleDetail,
  convertGoldToCash,
  convertCashToGold,
  receiveCash,
} from "./service";

export const jobWorkRouter = router({
  list:     guardedProcedure("jobWork", "jobWork", "view").input(ListTxSchema).query(async ({ input }) => listJobWork(input)),
  getById:  guardedProcedure("jobWork", "jobWork", "view").input(GetByIdSchema).query(async ({ input }) => getJobWorkById(input)),
  create:   guardedProcedure("jobWork", "jobWork", "edit").input(CreateJobWorkSchema).mutation(async ({ input }) => createJobWork(input)),
  update:   guardedProcedure("jobWork", "jobWork", "edit").input(UpdateJobWorkSchema).mutation(async ({ input, ctx }) => {
    const result = await updateJobWork(input);
    await notifyBillEdited("Job Work", result.group.bill_no, ctx.user!);
    return result;
  }),
  delete:   guardedProcedure("jobWork", "jobWork", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deleteJobWork(input)),

  // Bill Cycle routes
  createCycle:    guardedProcedure("jobWork", "jobWork", "edit").input(CreateCycleSchema).mutation(async ({ input }) => createCycle(input)),
  listCycles:     guardedProcedure("jobWork", "jobWork", "view").input(ListCyclesSchema).query(async ({ input }) => listCycles(input)),
  getCycleDetail: guardedProcedure("jobWork", "jobWork", "view").input(GetCycleDetailSchema).query(async ({ input }) => getCycleDetail(input)),

  // Gold ↔ Cash conversion + standalone Receive Cash (ported from Labour Bill)
  convertGoldToCash: guardedProcedure("jobWork", "jobWork", "edit").input(ConvertGoldToCashSchema).mutation(async ({ input }) => convertGoldToCash(input)),
  convertCashToGold: guardedProcedure("jobWork", "jobWork", "edit").input(ConvertCashToGoldSchema).mutation(async ({ input }) => convertCashToGold(input)),
  receiveCash:       guardedProcedure("jobWork", "jobWork", "edit").input(ReceiveCashSchema).mutation(async ({ input }) => receiveCash(input)),
});
