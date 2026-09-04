import { db } from "../db";
import { accounts, entryGroups, entries, items } from "../db/schema";
import { eq, or } from "drizzle-orm";

async function main() {
    const accs = await db.select().from(accounts).where(eq(accounts.name, 'brn'));
    if (accs.length === 0) {
        console.log("No account named 'brn' found.");
        process.exit(0);
    }

    const brn = accs[0]!;
    console.log("ACCOUNT brn:", brn);

    const groups = await db.select().from(entryGroups).where(eq(entryGroups.account_id, brn.id));
    console.log(`FOUND ${groups.length} GROUPS FOR brn:`);

    for (const g of groups) {
        const eList = await db.select().from(entries).where(eq(entries.group_id, g.id));
        console.log(`\nGROUP id=${g.id} bill_no=${g.bill_no} type=${g.type} is_deleted=${g.is_deleted}:`);
        for (const e of eList) {
            console.log(`  ENTRY id=${e.id} item_id=${e.item_id} qty=${e.quantity} pure=${e.pure_quantity} from=${e.from_account_id} to=${e.to_account_id}`);
        }
    }

    const unlinkedEntries = await db.select().from(entries).where(or(eq(entries.from_account_id, brn.id), eq(entries.to_account_id, brn.id)));
    console.log(`\nTOTAL UNFILTERED ENTRIES TOUCHING brn: ${unlinkedEntries.length}`);
    for (const e of unlinkedEntries) {
        console.log(`  UNLINKED ENTRY id=${e.id} group_id=${e.group_id} item_id=${e.item_id} qty=${e.quantity} pure=${e.pure_quantity} from=${e.from_account_id} to=${e.to_account_id}`);
    }

    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
