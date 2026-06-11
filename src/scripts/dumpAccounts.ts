import { db } from "../db";
import { accounts } from "../db/schema";

async function dump() {
  try {
    const list = await db.select().from(accounts);
    console.log("Found", list.length, "accounts:");
    for (const acc of list) {
      console.log(`- ID: ${acc.id}, Name: "${acc.name}", Type: ${acc.type}, CustomerType: ${acc.customer_type}, Deleted: ${acc.is_deleted}`);
    }
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}
dump();
