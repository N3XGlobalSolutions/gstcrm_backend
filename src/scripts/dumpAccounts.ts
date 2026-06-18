import { db } from "@/db";
import { accounts } from "@/db/schema";

async function run() {
  try {
    const list = await db.select().from(accounts);
    console.log("=== ACCOUNTS ===");
    for (const a of list) {
      console.log(`AccountID: ${a.id}, Name: "${a.name}", Type: ${a.type}, CustomerType: ${a.customer_type}, Deleted: ${a.is_deleted}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
