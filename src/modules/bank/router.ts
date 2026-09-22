import { router, protectedProcedure } from "@/lib/trpc";
import {
  AddBankFundsSchema,
  BankLedgerSchema,
  SaveBanksSchema,
  TransferBankFundsSchema,
} from "./schema";
import {
  addBankFunds,
  getBankLedger,
  listBanks,
  saveBanks,
  transferBankFunds,
} from "./service";

export const bankRouter = router({
  // Banks as configured in Settings → Company Details.
  list: protectedProcedure.query(async () => listBanks()),

  // Per-bank balances plus the paginated transaction log.
  ledger: protectedProcedure
    .input(BankLedgerSchema)
    .query(async ({ input }) => getBankLedger(input)),

  // Add, edit or remove the shop's bank accounts (same list as Company Details).
  save: protectedProcedure
    .input(SaveBanksSchema)
    .mutation(async ({ input }) => saveBanks(input)),

  // Add money to, or take money out of, one bank.
  addFunds: protectedProcedure
    .input(AddBankFundsSchema)
    .mutation(async ({ input, ctx }) => addBankFunds(input, ctx.user)),

  // Move money between two of the shop's own banks.
  transfer: protectedProcedure
    .input(TransferBankFundsSchema)
    .mutation(async ({ input, ctx }) => transferBankFunds(input, ctx.user)),
});
