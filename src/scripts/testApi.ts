// Quick test: login and then call accounts.list
const loginRes = await fetch("http://localhost:3001/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "superadmin", password: "Hello@2026" }),
});
const loginData = await loginRes.json() as any;
console.log("Login:", loginRes.status, loginData.token ? "GOT TOKEN" : "NO TOKEN");

if (!loginData.token) {
  console.error("Login failed:", loginData);
  process.exit(1);
}

// Now call accounts.list with the token — exact same request as the browser
const input = encodeURIComponent(JSON.stringify({ "0": { type: "GOLDSMITH", limit: 200 } }));
const url = `http://localhost:3001/api/trpc/accounts.list?batch=1&input=${input}`;
console.log("Fetching:", url);

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${loginData.token}` },
});
const body = await res.text();
console.log("Status:", res.status);
console.log("Response:", body);
