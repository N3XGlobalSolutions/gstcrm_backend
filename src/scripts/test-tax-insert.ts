import { db } from "../db";
import { taxMaster } from "../db/schema";

async function main() {
  console.log("Querying existing Tax Master records...");
  try {
    const rows = await db.select().from(taxMaster);
    console.log("Current records in database:", rows);
  } catch (error) {
    console.error("Query error details:", error);
  }
  process.exit(0);
}

main();
