import { createAccount } from "@/modules/accounts/service";
import { appUsers } from "@/db/schema";
import { db } from "@/db";

async function run() {
  console.log("Testing createAccount...");
  const [user] = await db.select().from(appUsers).limit(1);
  if (!user) {
    console.error("No user found. Seed database first.");
    process.exit(1);
  }

  const creator = { id: user.id, username: user.username };
  
  try {
    const acct = await createAccount({
      name: "Test Customer Test",
      type: "CUSTOMER",
      customer_type: "CUSTOMER",
      gst_no: null,
      pan_no: null,
      state_code: null,
      place_of_supply: null,
      address: null,
      phone: null,
      email: null,
      website: null,
      opening_pure_balance: "0",
      opening_cash_balance: "0",
    }, creator);

    console.log("Account created successfully:", acct);
    process.exit(0);
  } catch (error: any) {
    console.error("Failed to create account. Error details:", error);
    process.exit(1);
  }
}

run().catch(console.error);
