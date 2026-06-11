import { db } from "./src/db";
import { appUsers } from "./src/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

async function run() {
  const [user] = await db.select().from(appUsers).where(eq(appUsers.username, "admin")).limit(1);
  console.log("User found:", !!user);
  if (user) {
    const isMatch = await bcrypt.compare("Admin@123", user.password_hash!);
    console.log("Password matches Admin@123:", isMatch);
  }
  process.exit(0);
}
run();
