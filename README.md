# Stock Inventory System

A single-page ledger app for tracking daily stock, sales, and stock status by brand — built for bartenders and small shops that need something simpler than a spreadsheet but more structured than a notebook.

Currency is displayed in **Ksh**.

---

## Files

You have two ways to run this system:

| File | Use it when… |
|---|---|
| **`stock_inventory.html`** | You just want one file. Open it directly — everything (HTML, CSS, JS) is bundled inside. This is the version that works in Claude's preview. |
| **`index.html` + `styles.css` + `script.js`** | You want the code split apart for editing or hosting. All three files must stay in the same folder — `index.html` loads the other two by filename. |

Both versions are functionally identical and are kept in sync.

---

## Getting Started

1. Open `stock_inventory.html` (or `index.html`, if using the split files).
2. You'll land on the **welcome screen** — click **Enter System**.
3. **First time only:** you'll be asked to choose a username and password.
4. After that, returning visits just ask for the password. Use **Logout** in the header to lock it again, or **reset it** from the login screen if you've forgotten it (this deletes the saved login entirely — the next person to open the file sets a new one).

Your data saves automatically as you work — there's no separate "Save" button to remember.

---

## The Ledger Table

Each row tracks one brand, with 15 blank rows to start (use **+ Add Row** for more).

| Column | Meaning |
|---|---|
| No. | Row number — stays fixed to that row even while searching |
| Brand | Product name (editable) |
| Opening Stock | Stock on hand at the start of the day |
| New Stock | Stock received/restocked during the day |
| Total Stock | *Auto-calculated:* Opening + New Stock |
| Closing Stock | *Auto-calculated:* Total Stock − Sales Stock |
| Sales Stock | Running total sold — see below |
| Price (Ksh) | Unit price |
| Totals | *Auto-calculated:* Sales Stock × Price |
| Status | **In Stock** or **Out of Stock**, based on Closing Stock |

### Sales Stock — quick-add instead of mental math

The Sales Stock total is directly editable (for corrections), **and** has a small "+ add sale" box beside it. Type just the current buyer's quantity and press Enter — it adds to the running total automatically, so you never have to add up multiple sales in your head. There's also a small reset (↺) button to zero it out if needed.

### Bartender name & date

Above the table: a **Name of Bartender** field and a **Date** field (defaults to today, editable). Both save automatically and appear on exports and printouts.

---

## Closing the Day

Click **Close Day & Carry Forward** to:

1. **Archive** the entire current table as a snapshot, filed under the date shown in the Date field.
2. **Carry stock forward** — each row's Closing Stock becomes tomorrow's Opening Stock; New Stock and Sales Stock reset to 0.
3. **Advance the Date field** to the next day automatically.
4. Log each row to the sales-history trend log (used by the Reports tab).

Use **🕘 View Past Day** in the toolbar to look up any previously archived date — it opens a read-only view of that day's table exactly as it was closed.

---

## Account & Access

- **🔑 Change Password** — rotate your password without a full reset. Asks for your current password first.
- **Reset login** — from the sign-in screen, if you've forgotten your password. This clears the saved login entirely; whoever opens the file next sets a brand-new one.
- **Passwords are hashed, not stored as plain text** — a salted SHA-256 hash is what actually gets saved, using the browser's built-in Web Crypto API. Even someone looking directly at the saved data doesn't see your actual password.

---

## Moving Data Between Devices

Three ways to get your data from one place to another, depending on the situation:

- **🔗 Sync via Code** — turns today's table (plus bartender/date) into a short text code you can copy and paste into the app on another device. Quicker than a file when you just need to move the working table over. Doesn't carry sales history or day archives.
- **💾 Save Backup / 📂 Load Backup** — downloads or restores your entire ledger (table + full history + day archives) as a `.json` file. The complete copy — use this for real backups, not just quick transfers.
- **🌐 Team Mode** — for working from the *same* table across devices or with other people at the same time, rather than transferring copies back and forth. See below.

---

## Team Mode — Shared Access

By default, your table is private to you. **Team Mode** switches you to a shared table instead — visible and editable by anyone else who also turns Team Mode on for this same file.

- Off by default. Turning it on requires an explicit confirmation, since it's a real change in who can see your data.
- Your personal table isn't deleted or merged when you switch — it's just set aside. Turn Team Mode off anytime to go back to it exactly as you left it.
- A blue banner appears across the top whenever Team Mode is active, so it's always obvious which table you're looking at.
- Want your current table to *become* the shared one instead of starting fresh? Turn on Team Mode, then use **Load Backup** or **Sync via Code** to bring your data in.
- Reports, day archives, and sales history all follow the same switch — turning Team Mode on or off moves everything together, not just the live table.

---

## Other Features

- **📋 Purchase Order** — auto-lists every out-of-stock brand with an editable reorder quantity and a print-ready order sheet with a total cost.
- **📊 Reports tab** — sales totals over time, filterable by month or all-time, built from the day-close history log.
- **🖨 Print Ledger** — a clean, print-only version of the table (no buttons or inputs).
- **📊 Export CSV** — downloads the current table (and a separate export for the Reports history).
- **🌙 Dark mode** — toggle in the header; remembered between visits.
- **Search** — filter the table by brand name.

---

## How Saving Works

Data saves automatically after every edit — there's no manual save step. A few things worth knowing:

- If a save fails (shown as a banner at the top of the table), **don't close the tab** — your edits are still there, just not yet confirmed saved. Use **Retry Save**, or download a backup as insurance.
- The system retries failed saves automatically a few times before giving up and showing you a banner, so brief connection hiccups usually resolve on their own without you noticing.
- If loading your data fails when opening the file, you'll see a banner offering **Retry** or **Continue anyway** — the second option starts a fresh table without assuming your old data is gone, since the app can't always tell "nothing saved yet" apart from "a real problem happened."

If failures persist across many attempts, that generally points to a temporary issue with the storage service itself rather than something wrong with your data — retrying later, or using Save Backup in the meantime, is the right move.

---

## Formulas Reference

```
Total Stock    = Opening Stock + New Stock
Closing Stock  = Total Stock − Sales Stock
Totals (Ksh)   = Sales Stock × Price
Status         = "Out of Stock" if Closing Stock ≤ 0, otherwise "In Stock"
```
