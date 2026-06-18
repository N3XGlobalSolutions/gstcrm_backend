import { db } from "../db";
import { entryGroups, accounts, gstPurchaseHistory, gstSalesHistory } from "../db/schema";
import { eq } from "drizzle-orm";

async function dump() {
  try {
    const list = await db
      .select({
        group: entryGroups,
        account_name: accounts.name,
      })
      .from(entryGroups)
      .leftJoin(accounts, eq(entryGroups.account_id, accounts.id));
    
    console.log("=== ENTRY GROUPS ===");
    for (const item of list) {
      console.log(`- ID: ${item.group.id}, Type: ${item.group.type}, Account: "${item.account_name}", BillNo: ${item.group.bill_no}, EntryNo: ${item.group.entry_no}, Date: ${item.group.date}, Deleted: ${item.group.is_deleted}, ReversedBy: ${item.group.reversed_by}, ReversalOf: ${item.group.reversal_of}`);
    }

    const gstPurchases = await db.select().from(gstPurchaseHistory);
    console.log("\n=== GST PURCHASE HISTORY ===");
    for (const item of gstPurchases) {
      console.log(`- ID: ${item.id}, PurchaseID: ${item.purchase_id}, BillNo: ${item.bill_no}, EntryNo: ${item.entry_no}, Date: ${item.date}`);
    }

    const gstSales = await db.select().from(gstSalesHistory);
    console.log("\n=== GST SALES HISTORY ===");
    for (const item of gstSales) {
      console.log(`- ID: ${item.id}, SaleID: ${item.sale_id}, BillNo: ${item.bill_no}, EntryNo: ${item.entry_no}, Date: ${item.date}`);
    }

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}
dump();
