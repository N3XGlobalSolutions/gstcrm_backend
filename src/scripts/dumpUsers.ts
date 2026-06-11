import { db } from "../db";
import { appUsers } from "../db/schema";

async function dump() {
  const users = await db.select({ id: appUsers.id, username: appUsers.username, is_deleted: appUsers.is_deleted }).from(appUsers);
  console.log("Users:", JSON.stringify(users, null, 2));
  process.exit(0);
}
dump();
