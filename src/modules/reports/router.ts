import { router, protectedProcedure } from "@/lib/trpc";
import {
  BankReportSchema,
  CustomerBalanceSchema,
  DetailedReportSchema,
  StockReportSchema,
  TransactionReportSchema,
} from "./schema";
import {
  getBankReport,
  getDetailedReport,
  getStockReport,
  getTransactionReport,
} from "./service";
import { getCustomerBalanceReport } from "./customerBalance";

export const reportsRouter = router({
  // Sales / Purchase / Labour Bill / Job Work / Expense — day- or month-wise.
  transactions: protectedProcedure
    .input(TransactionReportSchema)
    .query(async ({ input }) => getTransactionReport(input)),

  // Sales / Purchase / Labour Bill / Job Work — bill-by-bill with every line,
  // charge and payment broken out.
  detailed: protectedProcedure
    .input(DetailedReportSchema)
    .query(async ({ input }) => getDetailedReport(input)),

  // Party's opening → closing balance at every bill of one type.
  customerBalance: protectedProcedure
    .input(CustomerBalanceSchema)
    .query(async ({ input }) => getCustomerBalanceReport(input)),

  bank: protectedProcedure
    .input(BankReportSchema)
    .query(async ({ input }) => getBankReport(input)),

  stock: protectedProcedure
    .input(StockReportSchema)
    .query(async ({ input }) => getStockReport(input)),
});
