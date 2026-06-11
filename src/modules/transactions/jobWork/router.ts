import { router, guardedProcedure } from "@/lib/trpc";
import {
  ListTxSchema,
  GetByIdSchema,
  CreateJobWorkSchema,
  UpdateJobWorkSchema,
  DeleteTxSchema,
} from "./schema";
import { listJobWork, getJobWorkById, createJobWork, updateJobWork, deleteJobWork } from "./service";

export const jobWorkRouter = router({
  list: guardedProcedure("jobWork", "jobWork", "view").input(ListTxSchema).query(async ({ input }) => listJobWork(input)),
  getById: guardedProcedure("jobWork", "jobWork", "view").input(GetByIdSchema).query(async ({ input }) => getJobWorkById(input)),
  create: guardedProcedure("jobWork", "jobWork", "edit").input(CreateJobWorkSchema).mutation(async ({ input }) => createJobWork(input)),
  update: guardedProcedure("jobWork", "jobWork", "edit").input(UpdateJobWorkSchema).mutation(async ({ input }) => updateJobWork(input)),
  delete: guardedProcedure("jobWork", "jobWork", "delete").input(DeleteTxSchema).mutation(async ({ input }) => deleteJobWork(input)),
});
