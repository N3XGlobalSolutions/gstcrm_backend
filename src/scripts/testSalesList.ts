import { listSales } from "../modules/transactions/sales/service";

async function run() {
  try {
    const res = await listSales({ page: 1, limit: 20 });
    console.log("listSales returned", res.data.length, "items:");
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
