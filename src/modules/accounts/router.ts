import { router, protectedProcedure } from "@/lib/trpc";
import { z } from "zod";
import {
  ListAccountsSchema,
  CreateAccountSchema,
  UpdateAccountSchema,
  DeleteAccountSchema,
  GetAccountBalanceSchema,
  GetAggregateBalancesSchema,
} from "./schema";
import {
  listAccounts,
  createAccount,
  updateAccountById,
  deleteAccount,
  getAccountBalance,
  getAccountAggregateBalances,
  getAccountById,
} from "./service";

export const accountsRouter = router({
  list: protectedProcedure
    .input(ListAccountsSchema)
    .query(async ({ input }) => listAccounts(input)),

  create: protectedProcedure
    .input(CreateAccountSchema)
    .mutation(async ({ input, ctx }) => createAccount(input, ctx.user!)),

  update: protectedProcedure
    .input(UpdateAccountSchema)
    .mutation(async ({ input, ctx }) => updateAccountById(input, ctx.user!)),

  delete: protectedProcedure
    .input(DeleteAccountSchema)
    .mutation(async ({ input, ctx }) => deleteAccount(input, ctx.user!)),

  getBalance: protectedProcedure
    .input(GetAccountBalanceSchema)
    .query(async ({ input }) => getAccountBalance(input)),

  getAggregateBalances: protectedProcedure
    .input(GetAggregateBalancesSchema)
    .query(async ({ input }) => getAccountAggregateBalances(input)),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => getAccountById(input.id)),
});

