import { db } from "@/db";
import { sql } from "drizzle-orm";

async function checkSize() {
  try {
    const result = (await db.execute(sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size, current_database() as db_name`)) as any[];
    if (result && result[0]) {
      console.log(`Database Name: ${result[0].db_name}`);
      console.log(`Database Size: ${result[0].size}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

checkSize();
