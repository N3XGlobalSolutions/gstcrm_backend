import { ListAccountsSchema } from "../modules/accounts/schema";

// Simulate exactly what the browser sends
const input = { type: "GOLDSMITH", limit: 200 };

console.log("Testing input:", JSON.stringify(input));

const result = ListAccountsSchema.safeParse(input);

if (result.success) {
  console.log("✅ Validation PASSED. Parsed data:", JSON.stringify(result.data));
} else {
  console.log("❌ Validation FAILED. Errors:");
  console.log(JSON.stringify(result.error, null, 2));
}
