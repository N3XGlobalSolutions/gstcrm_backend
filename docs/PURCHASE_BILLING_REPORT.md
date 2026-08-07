# Purchase Billing System — Simple Report

## What "Purchase" Means Here

This is not an online shopping or subscription payment system. This app is a **jewelry shop ledger**.

- **Purchase** = the shop buying gold or ornaments from a supplier.
- **Billing** = the on-screen panel where the shop enters the gold weight, cash paid, and discount for that purchase.

There is **no credit card processing, no Stripe/Razorpay, no online payment gateway**. Everything is entered manually by the shop staff.

---

## 1. Frontend — What the User Sees

Main page: `PurchasePage.tsx`

Steps on screen:
1. Pick the **Supplier** from a dropdown.
2. The system auto-fills the next **Bill Number** and shows the supplier's **previous balance**.
3. Add rows of gold or ornament items — each row has weight, purity (touch %), and rate. The system auto-calculates pure weight and amount.
4. In the **Billing panel**:
   - See the total pure gold value.
   - Optionally enter a **bank payment** amount (and pick a bank from company settings).
   - Optionally enter a **discount**.
   - Choose whether the leftover balance is tracked in **Gold (grams)** or **Cash (₹)**.
5. Click **Save**.

Other things on this page:
- A **history table** of past purchase bills (edit, delete, print).
- A **print button** that opens a printable bill in a new browser window (nothing is saved as a PDF).
- A **GST conversion** option — turns a purchase bill into a GST-style invoice record, with a 12-hour undo window.

**How it talks to the backend:** Using a technology called tRPC (similar to an API, but type-safe). No plain REST calls for purchases.

---

## 2. Backend — What Happens on the Server

Location: `goldcrm_backend/src/modules/transactions/purchase/`

When Save is clicked, the backend:
1. Checks the user is **logged in** and has **permission** to create purchases.
2. **Validates** all the data (positive numbers, valid dates, etc.).
3. Calculates:
   - Pure gold weight for each item.
   - Total cash value of the purchase.
   - Discount amount.
4. Builds a list of accounting entries (see below) and saves them **all at once** in a single database transaction — so nothing gets half-saved.

Important: **Purchases can never be truly deleted.** Editing a purchase actually reverses the old entries and creates new ones, keeping a full history — like a real accounting ledger.

---

## 3. Database — Where the Data Is Stored

There are **no tables called `invoices`, `payments`, or `subscriptions`**. Instead, this system uses **double-entry bookkeeping** (like real accounting), shared across purchases, sales, and other transaction types.

| Table | What it stores |
|---|---|
| **entry_groups** | One row per purchase bill — bill number, date, which supplier, overall rate, GST/TDS/TCS amounts. |
| **entries** | The actual line items of that bill — e.g. "gold received," "cash paid," "discount given." Each purchase creates several of these rows. |
| **accounts** | List of suppliers, customers, and internal accounts (also stores each one's starting/opening balance). |
| **items** | The list of gold/ornament item types and their default purity. |
| **gst_purchase_history** | A snapshot copy of a bill's totals, only created when the user converts it to a GST invoice. |

**Important detail:** The system does **not** store a running "balance owed" number anywhere. Every time you open a supplier's account, it **recalculates** the balance by adding up all their `entries` rows from scratch. This makes it accurate but means all the history has to stay intact.

---

## 4. Full Flow (Click to Database)

1. Staff fills the purchase form and clicks **Save**.
2. Frontend checks the form is valid, then sends the data to the backend.
3. Backend checks login/permissions, then re-checks the data is valid.
4. Backend calculates pure weight, cash value, and discount.
5. Backend saves **one bill record** (`entry_groups`) and **multiple line entries** (`entries`) together, in one safe database transaction.
6. Frontend refreshes the history table, stock numbers, and balances automatically.
7. *(Optional)* Staff converts the bill to a GST invoice — saved separately in `gst_purchase_history`, undoable for 12 hours.
8. *(Optional)* Staff prints the bill — this only opens a print window, nothing extra is saved.

---

## Bottom Line

- No real payment gateway is involved — "payment" just means typing in a cash/bank amount.
- Every purchase is recorded as accounting-style entries, not a single row.
- Balances are always calculated live, never stored as a fixed number.
- Bills can be edited (which reverses + recreates them) but never truly deleted — full history is always kept.
