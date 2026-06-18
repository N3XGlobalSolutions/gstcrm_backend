import { db } from "@/db";
import { entryGroups, accounts } from "@/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  try {
    const groups = await db.select().from(entryGroups);
    console.log("=== ENTRY GROUPS ===");
    for (const g of groups) {
      const [acc] = await db.select().from(accounts).where(eq(accounts.id, g.account_id));
      console.log(`GroupID: ${g.id}, Type: ${g.type}, BillNo: ${g.bill_no}, EntryNo: ${g.entry_no}, AccountName: "${acc?.name}", Date: ${g.date}, Deleted: ${g.is_deleted}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
