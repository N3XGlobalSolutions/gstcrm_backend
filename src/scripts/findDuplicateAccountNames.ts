import { db } from "@/db";
import { sql } from "drizzle-orm";

async function main() {
  const rows: any = await db.execute(sql`
    SELECT type, lower(btrim(name)) AS key, count(*) AS n,
           array_agg(entry_no ORDER BY entry_no) AS entry_nos,
           array_agg(name ORDER BY entry_no) AS names
    FROM accounts
    WHERE is_deleted = false AND is_system_account = false
    GROUP BY 1,2 HAVING count(*) > 1 ORDER BY 1,2`);
  console.log(rows.length ? rows : "NO DUPLICATES - migration will apply cleanly");
  process.exit(0);
}
main();
