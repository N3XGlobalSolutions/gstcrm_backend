import { router, guardedProcedure } from "@/lib/trpc";
import {
  ListExpenseSchema,
  GetByIdSchema,
  CreateExpenseSchema,
  UpdateExpenseSchema,
  DeleteExpenseSchema,
} from "./schema";
import { listExpenses, getExpenseById, createExpense, updateExpense, deleteExpense } from "./service";

export const expenseRouter = router({
  list: guardedProcedure("expense", "expense", "view").input(ListExpenseSchema).query(async ({ input }) => listExpenses(input)),
  getById: guardedProcedure("expense", "expense", "view").input(GetByIdSchema).query(async ({ input }) => getExpenseById(input)),
  create: guardedProcedure("expense", "expense", "edit").input(CreateExpenseSchema).mutation(async ({ input }) => createExpense(input)),
  update: guardedProcedure("expense", "expense", "edit").input(UpdateExpenseSchema).mutation(async ({ input }) => updateExpense(input)),
  delete: guardedProcedure("expense", "expense", "delete").input(DeleteExpenseSchema).mutation(async ({ input }) => deleteExpense(input)),
});
