import { router, protectedProcedure } from "@/lib/trpc";
import {
  AddBankFundsSchema,
  BankLedgerSchema,
  TransferBankFundsSchema,
} from "./schema";
import {
  addBankFunds,
  getBankLedger,
  listBanks,
  transferBankFunds,
} from "./service";

export const bankRouter = router({
  // Banks as configured in Settings → Company Details.
  list: protectedProcedure.query(async () => listBanks()),

  // Per-bank balances plus the paginated transaction log.
  ledger: protectedProcedure
    .input(BankLedgerSchema)
    .query(async ({ input }) => getBankLedger(input)),

  // Add money to, or take money out of, one bank.
  addFunds: protectedProcedure
    .input(AddBankFundsSchema)
    .mutation(async ({ input, ctx }) => addBankFunds(input, ctx.user)),

  // Move money between two of the shop's own banks.
  transfer: protectedProcedure
    .input(TransferBankFundsSchema)
    .mutation(async ({ input, ctx }) => transferBankFunds(input, ctx.user)),
});
