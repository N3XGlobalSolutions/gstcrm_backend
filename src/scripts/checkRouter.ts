import { appRouter } from "../app.router";

async function run() {
  try {
    // Create a mock context
    const ctx = {
      user: { id: "00000000-0000-0000-0000-000000000001", username: "superadmin" }
    };
    
    // Call the procedure caller
    const caller = appRouter.createCaller(ctx as any);
    const res = await caller.transactions.sales.list({ page: 1, limit: 100 });
    
    console.log("tRPC sales.list returned", res.data.length, "items:");
    for (const item of res.data) {
      console.log(`- ID: ${item.group.id}, Type: ${item.group.type}, Account: "${item.account_name}", Date: ${item.group.date}, Deleted: ${item.group.is_deleted}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
