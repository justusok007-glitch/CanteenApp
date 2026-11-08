# CanteenApp: Project Spec and Decisions

Last updated: 2026-11-08
Owner: Saqib Khalil (Okara, Punjab, Pakistan)
Purpose of this file: a single place to recall every decision made so far, so any new session can continue without re-explaining.

---

## 1. Problem

A cloud app to manage a **school canteen**: inventory, purchases, sales and profit.

Constraints that shape the whole design:
- The salesman is **not educated enough to use software**.
- Break time is only **~20 minutes** and selling is very fast, so nothing can be entered during sales.
- Real sales are unknown. Until now the only check was trusting the salesman.

**Core idea: do not measure sales at the counter. Measure stock and cash instead.** The salesman never touches the app.

---

## 2. Facts about the canteen

| Item | Value |
|---|---|
| Canteens | 1 now (design with `canteen_id` on every record so more can be added later) |
| Number of items | ~30 |
| Who does stock counts | The owner (Saqib) |
| Users | 2 (admin + one more) |
| Salesman pay | Rs 300 cash per active school day, deducted from the cash he hands over |
| Free items for salesman | **Not allowed** |
| Credit (udhar) to students/teachers | Possible; must be recorded |
| Supplier credit (buying on credit) | Yes |
| Wholesale prices | Change often |
| Sell price | Set manually by the owner |

---

## 3. Sales verification method (stock reconciliation)

Sales are **calculated**, never entered:

```
Sold = Last count + Purchases received since that count - New count - Recorded wastage
Expected cash = sum of (Sold x sell price) over all items
Shortage = Expected cash - (Cash handed over + salary kept)
```

### Flexible count checkpoints
- Counting is **not fixed daily**. It can be daily, every 2 days or weekly.
- A count is just a **checkpoint** in a dated stock ledger. The app computes sales for whatever gap lies between two counts.
- If new purchases arrive before the next count, they are entered with their own date and added into the formula. They never get mixed up with sales.
- A **cash check needs a full count** of all items in the same session. A partial count still gives item-level sales, but the cash check waits.
- Show "last counted" next to every item, and flag items not counted for more than X days.
- Suggested rhythm: fast sellers every 2 days, slow items weekly.
- Longer gaps still catch the shortage, but only as a total for the whole period.

### Rules that keep it accurate
- Enter purchases on the day they arrive, before stock goes to the counter.
- Update the count **before** changing a sell price, so one period never mixes two prices.
- Record active school days so the salary calculation is right.
- Record wastage, damage and expiry as separate lines (valued at cost), never as a shortage.
- Convert loose items into countable units (for example 1 tray = 20 samosas).
- Use round prices and countable/packaged items where possible.
- Record who did each count. Name one backup person for days the owner is absent.

### Reading results
- Small normal gaps are expected; set a tolerance (for example under 2%).
- Look at the **trend**, not one day. One bad day is likely a mistake; several in a row is a signal.
- Expected cash higher than actual: stock or cash is going missing.
- Expected cash lower than actual: the count was probably wrong or an item was sold cheaper.

### Other controls discussed (optional)
- Token/coupon system: students buy tokens elsewhere, the salesman takes only tokens, so he never handles cash. Strongest control, not chosen for now.
- Prepaid student QR card: too slow for a 20-minute rush, possible as a later phase.
- CCTV over the counter as a deterrent.

---

## 4. Costing and profit

### Cost: weighted average per item
```
Average cost = (Old stock value + New purchase value) / Total pieces
```
Example (juice): 50 pcs at Rs 40 plus 120 pcs at Rs 44 gives 170 pcs at Rs 42.82 average. Selling 100 at Rs 50 gives Rs 718 gross profit.

- FIFO was considered and rejected as too complex. Weighted average is accurate enough.
- Keep a **cost history** per item (which supplier, when, how much).
- Alert on cost change, for example "Juice cost up 8% since last purchase", as a cue to review the sell price.
- Items with no cost entered must be flagged so profit is never silently wrong.

### Sell price
- Stored with a **start date** (price history), so old reports keep their old price.
- The owner sets the price. The app shows profit live while typing:
  - Profit per unit = sell price - average cost
  - **Margin %** = profit / sell price x 100 (main number)
  - Markup % = profit / cost x 100 (smaller, beside it)
- Optional colour hints: red below a minimum margin, green above a target, warning if the price is below cost.
- Optionally show a few round price options near the target margin, each with its margin %.

### Profit report (per period)
- Gross profit = revenue - cost of goods sold
- Minus Rs 300/day salary, wastage (at cost) and other expenses
- Minus shortage (cash gap)
- = **Actual net profit**
- Also show **expected profit** (if everything was honest). The difference is what the shortage cost.
- Show margin % per item to spot low-margin slow items.

---

## 5. Purchase / inventory update screen

Fields per item line:
- Name: search-as-you-type over existing items (prevents "Juice" vs "Juice 200ml" duplicates). Picking an existing item pre-fills usual pieces per pack, last cost, current sell price and last supplier. A new name creates a new item.
- Number of packs
- Pieces per pack (1 for loose items)
- **Pack cost price** and **piece cost price**: the user enters **one**, the other auto-calculates. The app stores the typed value as the true one (for example Rs 400 pack of 12 stored as exactly Rs 400) so there is no rounding error.
- Sell price per piece (pre-filled, live margin %)
- Live totals: total for this item (packs x pack cost) and total pieces added
- Supplier: dropdown of saved suppliers plus "+ Add new" (name and phone) in the same screen. The last supplier is remembered.
- Date: defaults to today, editable for old bills.

Flow:
- "Save and add next item" keeps supplier and date, clears the rest. The whole session is **one purchase bill**.
- **Review screen before final submit**: each line shows item, new total stock, new average cost and new margin %. Also bill total, **Amount paid** and **Pending**. Lines can be edited or removed.

### What happens to existing items on submit
The app does not edit the item. It **adds a dated purchase record**, then recalculates:
1. Expected stock increases by packs x pieces per pack
2. Average cost is recalculated
3. Last cost is replaced (old one stays in history)
4. Sell price changes only if a new one was typed (old price kept with end date)
5. Pieces per pack updated if changed
6. Item's last supplier updated

### Supplier credit
- Bill total is computed from the lines; the owner enters amount paid; **Pending = Total - Paid**.
- Supplier balance rises by the pending amount.
- Later payments are recorded separately and reduce the balance. Each payment is an expense on its **payment date**, not the bill date.
- Supplier screen: total bought, total paid, balance owed.

### Editing or deleting a bill
- Stock and average cost are recalculated from the full history.
- Warn if the bill is older than the last count, since that changes the sales figure for that period.
- Keep an edit log (who, when, what changed).

---

## 6. Users, roles and security

- **Cloud-based**, so every phone sees the same data.
- Roles are **created by the admin**. Role names and feature access are controlled only by the admin.
- Admin creates users (name, username, role, password), changes roles, **resets passwords**, disables/enables users (preferred over deleting, to keep history), sees last login and can force logout.
- **Passwords:** the admin sets or resets them and sees the new one **once** on screen to pass it on. Existing passwords are **not viewable** (only a hash is stored). If forgotten, the admin resets it.
- **No forced password change at first login** (explicit decision). Users cannot change their own password; only the admin can. Use reasonably strong passwords since they stay long term.
- Keep login history (last login) to spot odd activity.

### Permission grid (admin ticks per role)

| Feature | View | Add | Edit | Delete |
|---|---|---|---|---|
| Items and sell prices | | | | |
| Purchases / bills | | | | |
| Stock counts | | | | |
| Cash handovers | | | | |
| Expenses and salary | | | | |
| Suppliers and payments | | | | |
| Reports | | | | |

Extra switches:
- Show cost price and profit (hide from data-entry staff)
- Edit records older than X days
- Manage users and roles (admin only by default)

### Server-side enforcement
- Permissions **must be enforced on the server** (row-level security), not just by hiding buttons.
- **Audit log** of who did what and when (bill edited, count changed, price changed).
- Daily automatic backup.

---

## 7. Technical plan

| Part | Choice |
|---|---|
| Code hosting and history | GitHub, repo `justusok007-glitch/CanteenApp` (private) |
| App screens hosting | GitHub Pages (free) |
| Database, login, roles, backups | Supabase (free tier is enough for 2 users) |
| UI building | Google AI Studio can sit on top |

Notes:
- GitHub hosts the code only. It cannot store data or run logins, so a backend (Supabase) is required.
- **Never commit passwords or service keys.** Only the public Supabase key goes in the app, and it is safe only with row-level security turned on.
- GitHub Pages is public, so the login screen is reachable by anyone with the link. Data stays protected by login. Keep the repo private.

### Planned database tables
`canteens`, `users`, `roles`, `role_permissions`, `items`, `item_price_history` (sell price with start/end date), `item_cost_history`, `suppliers`, `purchase_bills`, `purchase_lines`, `supplier_payments`, `stock_counts` and `stock_count_lines` (checkpoints, with who counted), `wastage`, `cash_handovers`, `expenses` (including daily salary), `school_days` (active days), `audit_log`.
Every table carries `canteen_id`.

---

## 8. Screens (in build order)

1. Login
2. Purchase entry (bill) and review
3. Stock count (pre-filled item list in shelf order, big number buttons)
4. Cash handover
5. Wastage and expenses/salary
6. Suppliers and payments
7. Reports (expected vs actual cash, shortage trend, profit per item and period, margin %)
8. Admin: users, roles, permissions

Count speed ideas: pre-pack stock into fixed bundles, keep the list in the same order as the shelf, count fast sellers more often than slow ones.

---

## 9. Open questions

- Is the Rs 300 salary always deducted from handed-over cash? (assumed yes)
- Which backup person does counts when the owner is absent?
- Minimum margin and target margin for the colour hints?
- Is credit (udhar) to students/teachers allowed, or banned? (if allowed, it needs its own record and balance)

## 10. Next steps

1. Write the database as one SQL file for Supabase, including row-level security for the roles.
2. Build the screens in the order above.
3. Test with real counts for a week, then tune the tolerance and count rhythm.
