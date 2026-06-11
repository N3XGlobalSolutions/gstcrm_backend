import { router, publicProcedure } from "@/lib/trpc";
import { itemsRouter } from "@/modules/items/router";
import { accountsRouter } from "@/modules/accounts/router";
import { purchaseRouter } from "@/modules/transactions/purchase/router";
import { salesRouter } from "@/modules/transactions/sales/router";
import { jobWorkRouter } from "@/modules/transactions/jobWork/router";
import { labourBillRouter } from "@/modules/transactions/labourBill/router";
import { expenseRouter } from "@/modules/transactions/expense/router";
import { stockRouter } from "@/modules/stock/router";
import { dashboardRouter } from "@/modules/dashboard/router";
import { notificationsRouter } from "@/modules/notifications/router";
import { settingsRouter } from "@/modules/settings/router";

export const appRouter = router({
  system: router({
    ping: publicProcedure.query(async () => ({
      pong: true,
      timestamp: new Date().toISOString(),
    })),
  }),

  items: itemsRouter,
  accounts: accountsRouter,

  transactions: router({
    purchase: purchaseRouter,
    sales: salesRouter,
    jobWork: jobWorkRouter,
    labourBill: labourBillRouter,
    expense: expenseRouter,
  }),

  stock: stockRouter,
  dashboard: dashboardRouter,
  notifications: notificationsRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
