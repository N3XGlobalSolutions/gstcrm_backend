import { db } from "../db";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { getAggregateBalances } from "../lib/balance";
import { getAccountAggregateBalances } from "../modules/accounts/service";

async function main() {
    const [brn] = await db.select().from(accounts).where(eq(accounts.name, 'brn'));
    if (!brn) {
        console.log("No account named 'brn' found");
        process.exit(0);
    }

    console.log("Testing getAggregateBalances for brn:", brn.id);
    const rawBal = await getAggregateBalances(brn.id);
    console.log("  totalPure:", rawBal.totalPure.toFixed(3));
    console.log("  totalCash:", rawBal.totalCash.toFixed(2));
    console.log("  balancePure:", rawBal.balancePure.toFixed(3));

    console.log("\nTesting getAccountAggregateBalances for brn:");
    const apiBal = await getAccountAggregateBalances({ accountId: brn.id });
    console.log("  API response:", JSON.stringify(apiBal, null, 2));

    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
