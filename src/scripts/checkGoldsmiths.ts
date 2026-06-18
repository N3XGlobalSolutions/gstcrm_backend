import { db } from "../db";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";

async function run() {
  try {
    const list = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        customer_type: accounts.customer_type,
        is_deleted: accounts.is_deleted,
      })
      .from(accounts)
      .where(eq(accounts.is_deleted, false));

    console.log("Found", list.length, "active accounts in DB:");
    for (const acc of list) {
      console.log(`- "${acc.name}": ID=${acc.id}, type=${acc.type}, customer_type=${acc.customer_type}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
