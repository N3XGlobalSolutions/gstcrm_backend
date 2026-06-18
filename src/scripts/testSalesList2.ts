import { listSales } from "../modules/transactions/sales/service";

async function run() {
  try {
    const res1 = await listSales({ page: 1, limit: 20 });
    console.log("Full page returned", res1.data.length, "items");
    const res2 = await listSales({ page: 1, limit: 20, is_converted: false });
    console.log("Unconverted returned", res2.data.length, "items");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
