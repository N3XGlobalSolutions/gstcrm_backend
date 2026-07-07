# GoldCRM — Full-Cycle Bill Test Report

**Scope:** Sales, Purchase, and Labour Bill transaction pages — end-to-end bill lifecycle.
**Author:** Senior QA (automated integration suite)
**Date:** 2026-07-07
**Result:** ✅ **46 / 46 tests passing** (Sales 19 · Purchase 13 · Labour 14)

> **Update 2026-07-07:** Fixed the **Sales wastage-as-stock bug** (wastage% is a profit line, not physical gold). See §10. Three regression tests added (S17–S19).

---

## 1. Executive summary

Every meaningful money/gold path of the three transaction pages was exercised against the **real backend service code** — `createSale`, `createPurchase`, `createLabourBill`, their `update*` (reverse-and-recreate) paths, and the single source of truth for balances (`getAggregateBalances` / `getBalance`). Nothing was mocked; each test writes real ledger rows and reads the balance back.

The suites cover the three lifecycle states you asked for — **balance (credit) bills, partial-payment bills, and full-settlement bills** — plus wastage modes, discounts, TDS/TCS, multi-item bills, ornament lots, stock movement, the reversal-on-edit path, the overpayment guard, rate-change behaviour, and the **3-decimal cash invariant** that caused the historical ₹1–10 opening-balance drift.

### Isolation (important)

Your `DATABASE_URL` points at **production Neon (`neondb`)**. No test bill was ever written there. The harness provisions a **throwaway `goldcrm_fullcycle_test` database** on the same Neon endpoint, replays all Drizzle migrations, seeds the system accounts/items, runs the suites, then **drops the database**. Production data is untouched.

> The Neon *management* MCP was offline during this run, so an isolated *branch* could not be cut. A separate throwaway *database* on the same endpoint gives the same isolation guarantee and was used instead.

---

## 2. How to run it

```bash
cd goldcrm_backend

# One command: provision isolated DB → run all 3 suites → tear down
npm run test:fullcycle

# Keep the DB up afterwards to inspect rows
npm run test:fullcycle:keep

# Manual control
npm run test:fullcycle:setup      # create + migrate + seed the throwaway DB
npm run test:fullcycle:teardown   # drop it
```

**Files delivered**

| File | Purpose |
|---|---|
| `scripts/fulltest/provision.mjs` | Create / migrate / seed / drop the isolated test DB |
| `scripts/fulltest/run.mjs` | One-command orchestrator (provision → test → teardown) |
| `src/modules/transactions/__tests__/_harness.ts` | Shared factories, balance readers, gold-math helpers |
| `src/modules/transactions/__tests__/sales.fullcycle.test.ts` | 16 Sales scenarios |
| `src/modules/transactions/__tests__/purchase.fullcycle.test.ts` | 13 Purchase scenarios |
| `src/modules/transactions/__tests__/labour.fullcycle.test.ts` | 14 Labour scenarios |

Runtime: ~9 min end-to-end (Neon pooler latency dominates; the logic itself is instant).

---

## 3. Ledger model under test

All three pages write through **one** ledger writer (`createEntryGroup`) and are read through **one** balance function. Balances are never stored — they are always derived:

```
balancePure(account) = Σ pure_in(to=account) − Σ pure_out(from=account)
                       − Σ cash(from=account)/rate_of_bill
                       + Σ cash(to=account)/rate_of_bill
```

`balancePure` is the **rate-stable gold still owed**, and it is exactly what becomes the *next* bill's opening balance. Because each cash payment is divided by the rate of *its own* bill, later rate changes cannot resurrect a settled balance (verified — see P10).

Sign conventions verified by the suites:

| Page | Gold direction | Cash direction | Carried balance meaning |
|---|---|---|---|
| **Sales** | SHOP → customer (customer pure ↑) | customer → SHOP | `balancePure` = gold the customer still owes |
| **Purchase** | supplier → SHOP (stock ↑) | SHOP → supplier | `−balancePure` = gold the shop still owes the supplier |
| **Labour** | 4-way SHOP ↔ goldsmith | both directions | `totalPure` = raw gold owed; `balancePure` also nets cash |

---

## 4. Sales — 19 scenarios

Customer buys gold; shop gives gold, customer pays cash. Rate ₹6000/g unless noted.

| # | Scenario | Key input | Expected | ✔ |
|---|---|---|---|---|
| S1 | **Balance bill** (full credit) | 10 g @ 92 %, no payment | balance = **9.200 g**, cash 0, shop stock 100→90 | ✅ |
| S2 | **Partial payment** | 20 g @ 91.6 %, pay ₹50 000 | 18.320 − 50000/6000 = **10.0367 g**, cash −50 000 | ✅ |
| S3 | **Full settlement** | 15 g @ 90 %, pay full ₹81 000 | balance → **0** | ✅ |
| S4 | Multi-item bill | 10 g @92 + 5 g @75 | 9.200 + 3.750 = **12.950 g** | ✅ |
| S5 | Wastage **PERCENT** | 10 g @92, 5 % wastage | pure incl. wastage carried | ✅ |
| S6 | Wastage **GRAM** | 10 g @92, 0.05 g/g | 10.5 g → **9.660 g** | ✅ |
| S7 | Cash discount | 10 g @92, disc ₹3 000 | 9.200 − 0.5 = **8.700 g** | ✅ |
| S8 | Pure-gold discount | 10 g @92, disc 0.5 g | **8.700 g** | ✅ |
| S9 | **3-decimal cash invariant** | 12.345 g @ 94.32 %, rate **14 527.20** | carries 3dp pure **exactly**; cash = round3(pure)×rate, drift < ₹0.01 | ✅ |
| S10 | **Overpayment guard** | pay > owed | rejected: “exceeds outstanding balance” | ✅ |
| S11 | CASH balance-mode settle | full pay, mode=CASH | balance → **0** | ✅ |
| S12 | **TDS effect** | tds ₹1 200 | balance = 9.200 **+** 0.2 → **9.400 g** *(see Finding F1)* | ✅ |
| S13 | **TCS effect** | tcs ₹1 200 | balance = 9.200 **−** 0.2 → **9.000 g** *(see Finding F1)* | ✅ |
| S14 | **4-bill lifecycle** | credit → paid → credit → settle-all | carries 9.2 → 9.2 → 16.56 → **0** | ✅ |
| S15 | Update / reversal | edit 10 g → 12 g | old reversed, balance = **11.040 g** | ✅ |
| S16 | Ornament sale from lot | 40 g @ 91.6 % from lot | **36.640 g**, lot fully issued | ✅ |
| S17 | **Wastage bug repro** — sell whole 40 g lot @91.6 **+ 8 % wastage** | full lot + wastage | **succeeds**; stock → 0 (physical 40 g only); customer billed gross pure incl. wastage | ✅ |
| S18 | Pooled gold, sell **all** stock + 5 % wastage | 10 g @92 + 5 % | succeeds; stock → 0; billed gross pure | ✅ |
| S19 | Partial ornament sale + wastage | 25 g of 40 g lot + 8 % | lot 40 → **15** (only physical grams leave); billed gross | ✅ |

---

## 5. Purchase — 13 scenarios

Supplier sells gold to shop; shop receives stock and owes the supplier. `payable = −balancePure`.

| # | Scenario | Key input | Expected | ✔ |
|---|---|---|---|---|
| P1 | **Balance bill** | buy 100 g @92, no pay | payable **92.000 g**, stock +100 | ✅ |
| P2 | **Partial payment** | 50 g @91.6, pay ₹100 000 | 45.8 − 100000/6000 = **29.1333 g** | ✅ |
| P3 | **Full settlement** | 20 g @90, pay full | payable → **0** | ✅ |
| P4 | Multi gold items | 100 g@92 + 50 g@75 | **129.500 g** | ✅ |
| P5 | Ornament purchase | 30 g @91.6 | payable **27.480 g**, shop lot +30 | ✅ |
| P6 | Mixed gold + ornament | 10 g@92 + 5 g@90 | **13.700 g** | ✅ |
| P7 | Cash discount | disc ₹3 000 | 9.200 − 0.5 = **8.700 g** | ✅ |
| P8 | Pure-gold discount | disc 0.5 g | **8.700 g** | ✅ |
| P9 | **3-decimal cash invariant** | 12.345 g @94.32, rate 14 527.20 | payable = 3dp pure exactly; cash reconciles < ₹0.01 | ✅ |
| P10 | **Rate-change / no phantom** | bill1 @5000 paid full, bill2 @7000 unpaid | payable = **5.000 g** only (settled bill stays settled) | ✅ |
| P11 | **4-bill lifecycle** | credit → paid → credit → settle-all | 18.4 → 18.4 → 22.9 → **0** | ✅ |
| P12 | Stock accuracy | buy 123.456 g | shop stock **+123.456 g** exact | ✅ |
| P13 | Update / reversal | edit 10 g → 15 g | payable **13.800 g**, stock reflects edit | ✅ |

---

## 6. Labour Bill — 14 scenarios

Goldsmith cycle; gold moves in 4 directions plus cash. `totalPure` = raw gold owed, `balancePure` also nets cash at each bill's rate.

| # | Scenario | Key input | Expected | ✔ |
|---|---|---|---|---|
| L1 | Gold **issue** only | issue 50 g @92 | totalPure **46.000**, balancePure 46 | ✅ |
| L2 | Gold **receipt** only | receipt 20 g @92 | totalPure **−18.400** | ✅ |
| L3 | Issue + receipt net | 50 g − 20 g | **27.600 g** | ✅ |
| L4 | Ornament issue + wastage | 40 g @91.6, 8 % | gross-weight pure carried | ✅ |
| L5 | **Ornament receipt** | 40 g @91.6, 8 % | debt = gross pure, **stock = physical 40 g** (not gross) | ✅ |
| L6 | **Bank paid** | issue 50 g + pay ₹60 000 | balancePure 46 **+** 10 = **56.000**; totalPure unaffected | ✅ |
| L7 | **Bank receive** | issue 50 g + recv ₹60 000 | **36.000 g** | ✅ |

| L8 | Discount (shop→smith) | disc ₹6 000 | 9.2 **+** 1 = **10.200 g** | ✅ |
| L9 | TDS (shop→smith) | tds ₹6 000 | 9.2 **+** 1 = **10.200 g** | ✅ |
| L10 | **Cash conversion** | issue 20 g, convert 5 g @6000 | balancePure 18.4 − 5 = **13.400**; totalPure still 18.4 | ✅ |
| L11 | **Missing/unknown cycle** guard | random cycle id | rejected: cycle does not exist | ✅ |
| L12 | **Wrong-goldsmith cycle** guard | cycle of smith A used by smith B | rejected: “different goldsmith” | ✅ |
| L13 | **4-bill cycle lifecycle** | issue → receipt → receipt → settle cash | totalPure nets 18.4, balancePure → **0** | ✅ |
| L14 | Update / reversal | edit 10 g → 15 g | totalPure **13.800 g** | ✅ |

---

## 7. Invariants proven

- **3-decimal cash invariant** (S9/P9): every cash figure equals `round3(pure) × rate`. Feeding the historically-problematic `rate = 14 527.20`, `touch = 94.32 %`, `weight = 12.345 g` (raw pure `11.6438340 g` vs stored `11.644 g`), the ledger carries the 3dp value exactly and the next opening reconciles to **< ₹0.01**. The old ±₹7 drift cannot occur.
- **Rate-stable carry-forward** (P10): a fully-paid bill at one rate does **not** create a phantom balance when a later bill uses a different rate.
- **Physical-weight stock vs gross-pure debt** (L5): ornament receipts add the *physical* weight to shop stock while reducing the goldsmith's balance by the *full gross* pure — verified separately.
- **Reversal-on-edit** (S15/P13/L14): editing a bill reverses the original group and recomputes the balance from scratch — no double counting.
- **Stock integrity** (S1, P12, S16): every gram sold leaves shop stock; every gram bought enters it; ornament lots deplete correctly.
- **Overpayment guard** (S10): payments beyond the outstanding balance are rejected.

---

## 8. Findings

### F1 — TDS/TCS: overpayment-guard direction is inverted vs the actual ledger effect  ·  Severity: **MEDIUM**

The Sales overpayment guard computes the max payable as
`… − tdsInPure + tcsInPure` (`sales/service.ts:252-253`) — i.e. it treats **TDS as reducing** the amount owed and **TCS as increasing** it, matching the in-code comments (“TDS reduces customer’s payable”).

But the ledger entries write TDS as `SHOP → customer` and TCS as `customer → SHOP`, so the **carried balance moves the opposite way**: TDS **increases** `balancePure` by `tds/rate` and TCS **decreases** it (proven by S12 = 9.400 g and S13 = 9.000 g).

**Impact:** the guard's ceiling and the balance actually carried to the next bill disagree whenever TDS/TCS is used. With TDS enabled, a customer's carried gold debt goes *up*, while the guard behaves as if it went *down* — a legitimate full payment can be mis-judged, and the running balance shown on the next bill will not match the intent described in the code.

**Action:** confirm the business meaning of TDS/TCS in this ledger, then make the entry direction and the guard agree. This is a **semantic** inconsistency, not a crash — the tests assert the *current* behaviour so the discrepancy is documented and locked, ready for you to decide the correct direction.

### F2 — Purchase page has no overpayment guard  ·  Severity: **LOW / by-design**

`createPurchase` intentionally allows any `bank_amount` (running balances are permitted for suppliers). Confirmed as designed; noted so it is a conscious choice, not an oversight.

### F3 — `getLotBalances` stock check is commented out for labour issues  ·  Severity: **LOW / by-design**

Labour gold/ornament *issues* deliberately allow negative shop stock (the shop can hand a goldsmith gold it doesn't nominally hold). Confirmed as designed (see comments in `labourBill/service.ts`).

---

## 9. Recommendation

The core money engine is **solid** — balances, carry-forward, the 3-decimal invariant, stock, and reversal all behave correctly across all three pages. The one item needing a product decision is **F1 (TDS/TCS direction)**; once you confirm the intended sign I can align the ledger entry and the guard and update the two tests to assert the corrected values.

These suites are safe to run any time (`npm run test:fullcycle`) — they never touch production data.

---

## 10. Fix — Sales wastage treated as physical gold (RESOLVED)

**Symptom (reported):** on the Sales page, selling a *full* ornament lot succeeded, but adding a **wastage %** (the shop's profit) rejected the bill with *“value exceeded than stock.”*

**Root cause:** `createSale` added wastage to the **physical gold quantity** written to the ledger:

```
totalQuantity = weight + wastageQty          // 40 g + 3.49 g = 43.49 g
stock check   → needs 43.49 g of a 40 g lot  → REJECTED
entry.quantity = 43.49 g                      → would also over-deplete stock
```

Because `entries.quantity` is what stock availability is measured from, any wastage on a full lot asked for more gold than existed. Wastage on a sale is a **profit line**, not physical gold — it must not be deducted from stock.

**Fix (`sales/service.ts`, `createSale`):** the gold-out entry now separates *physical gold* from *billed value* — the same pattern the Labour page already uses for ornament receipts:

| Field | Before | After |
|---|---|---|
| `quantity` (drives stock) | `weight + wastage` | **`weight`** (physical) |
| stock-availability check | vs `weight + wastage` | vs **`weight`** |
| `pure_quantity` (drives customer bill/balance) | `(weight+wastage)×touch/100` | **unchanged** — wastage still billed as profit |
| `wastage_mode` / `wastage_value` | stored | stored (edit round-trip intact) |

**Effect:** selling a full 40 g lot @91.6 % with 8 % wastage now **posts successfully**, stock drops by exactly **40 g**, and the customer is still billed for the gross pure `(40 + 3.49) × 91.6 %` — the 3.49 g wastage remains the shop's profit. This also fixes a latent edit bug (editing a wastage sale previously reloaded the inflated weight). Purchase and Labour were not touched.

**Regression tests:** S17 (full lot + wastage succeeds, stock → 0), S18 (pooled gold, full stock + wastage), S19 (partial sale removes only physical grams). All green.

### Follow-up worth a look (not blocking)

- **P&L / COGS on wastage:** the sale's `pure_quantity` is gross (incl. wastage), so the income-statement query (`incomeStatement.ts`, which sums `pure_quantity`) counts wastage grams as both revenue *and* cost of goods. Since wastage is pure profit with ~zero gold cost, gross margin is understated by roughly `wastage × avgCost`. Worth confirming how you want wastage to appear in the profit/loss section.
- **`average_touch` on the sale entry** is derived as `grossPure ÷ physicalWeight`, so it reads slightly above the item's touch; only affects the *displayed* average touch of a partially-sold ornament lot (cosmetic).
