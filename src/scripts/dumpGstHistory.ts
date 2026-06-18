import { db } from "@/db";
import { gstSalesHistory, gstPurchaseHistory, accounts } from "@/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  try {
    const sales = await db.select().from(gstSalesHistory);
    console.log("=== GST SALES HISTORY ===");
    for (const s of sales) {
      const [acc] = await db.select().from(accounts).where(eq(accounts.id, s.account_id));
      console.log(`GSTSaleID: ${s.id}, SaleID: ${s.sale_id}, BillNo: ${s.bill_no}, EntryNo: ${s.entry_no}, Account: "${acc?.name}", Type: ${s.type}`);
    }

    const purchases = await db.select().from(gstPurchaseHistory);
    console.log("\n=== GST PURCHASE HISTORY ===");
    for (const p of purchases) {
      const [acc] = await db.select().from(accounts).where(eq(accounts.id, p.account_id));
      console.log(`GSTPurchaseID: ${p.id}, PurchaseID: ${p.purchase_id}, BillNo: ${p.bill_no}, EntryNo: ${p.entry_no}, Account: "${acc?.name}", Type: ${p.type}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
