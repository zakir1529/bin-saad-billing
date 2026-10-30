# Bin Saad Billing: setup guide

A desktop billing program for Bin Saad Fabrics. It installs on the shop's Windows PC, opens in its own window (no browser), keeps its data on that PC, and prints receipts on a USB thermal printer.

## What it does

- Tap a suit to add it to the bill. Tap again for quantity 2. Search by typing; Enter adds the suit if only one matches.
- Discount in percent (5, 10, 15 or any number) or in rupees. Example: 10% on Rs. 4,000 prints `Discount (10%)  -400` and a total of Rs. 3,600.
- Payment by Cash, JazzCash, Easypaisa or Bank (editable in Settings). Cash shows the change to return in large type.
- Receipt on 80mm or 58mm paper: shop name, address, phone, numbered items, discount line, boxed total, "You saved" line, payment and change. It never shows the customer's name or phone, who served, or any udhaar. Logo and WhatsApp QR code can be added later in Settings.
- **Udhaar tab** (owner): a customer pays part of a bill now and owes the rest (Rs. 3,000 bill, Rs. 1,000 paid, Rs. 2,000 owed). On the New bill screen choose **Udhaar**, enter what was paid now (or nothing) and the customer's name and phone. The Udhaar tab lists everyone who owes, with their bills, and records money they bring back later. Customers are matched by phone number.
- **Profit tab** (owner, hidden behind the eye): enter a cost price for each suit in the Price list. Each bill keeps the cost it was sold at. Profit = what the customer paid after discount minus cost (Rs. 700 cost sold at Rs. 1,200 = Rs. 500; with Rs. 200 discount = Rs. 300). Bills with a suit that has no cost price are left out and reported, never counted as zero cost.
- Bills list: search by bill number, customer name, phone, suit or date. Reprint (marked DUPLICATE) and owner-only cancel with a reason.
- Sales for any day and any month, this month against last month, best sellers. Hidden behind an eye button with a slash. Click it, enter the owner password, and the figures show for 15 seconds, then hide again. Staff never see sales.
- Owner and staff logins. Staff can bill and reprint but cannot change prices, cancel bills, see sales, or give a discount above the limit (15% by default, changeable).
- Automatic backup copies (see Backups).

## 1. Get the installer

You need a Windows 10 or 11 PC with internet, once. Pick one way.

**A. On the shop PC (simplest)**
1. Install Node.js (the LTS version) from https://nodejs.org and restart the PC.
2. Put the program folder on the PC (for example on the Desktop).
3. Double-click `BUILD-INSTALLER.bat`. It downloads what it needs, runs the program's checks, and builds the installer. This takes a few minutes the first time.
4. The installer appears in the `dist` folder, named like `Bin Saad Billing Setup 1.0.0.exe`.

**B. In the cloud with GitHub (nothing to install on any PC)**
1. Put the program folder in a new private repository on GitHub (a free account is enough).
2. Open the Actions tab and run "Build Windows installer". When it finishes, download the files from the run's Artifacts.
3. You get two files: `Bin Saad Billing Setup 1.0.0.exe` (the normal installer) and `Bin Saad Billing 1.0.0.exe` (a portable version that runs by double-clicking, with no installation and no administrator rights). If the PC blocks installers, try the portable one. Both keep data in the same place.

To try the program without making an installer, double-click `TRY-WITHOUT-INSTALLING.bat`.

If Windows shows "Windows protected your PC" when you open the installer, click **More info**, then **Run anyway**. This happens once because the program is not digitally signed (signing costs money and is not needed for one shop).

## 2. First start

1. Install and open Bin Saad Billing from the desktop icon.
2. Create the owner password (at least 4 characters). Write it down and keep it safe: there is no way to recover it.
3. Go to **Settings** and fill in the shop name, address, phone and WhatsApp number. Press Save.

## 3. Printer

1. Plug in the USB thermal printer and install its driver (from the CD or the maker's website). Print the Windows test page to check it works.
2. In Windows printer properties, set the paper to the roll size (80mm or 58mm).
3. In the program: **Settings, Receipt printer**. Choose the paper width, and the printer (or leave "Windows default printer"). Press Save, then **Print a test receipt**.
4. If nothing prints straight away: untick "Print straight away, without asking each time" and save. Windows will then show its print window, where you can pick the printer. Tell the developer what you see.
5. **Save as PDF** on any bill is available if the printer is not working: the bill is still saved.

## 4. Add the suits

1. Go to **Price list, Paste a list**.
2. Type or paste one suit per line, with its price:
   ```
   Navy Blue Suit, 4000
   Black Suit 4500
   White Suit, 3800, Plain
   ```
   With the cost price after the price: `Navy Blue Suit, 4000, 2800`. The last part is an optional group (it becomes a tab on the billing screen): `White Suit, 3800, 2500, Plain`. Pasting a name that already exists updates its price.
3. Use **Add a suit** or **Edit** for single changes. A price change affects new bills only; old bills keep the price they were sold at. Switch a suit off instead of deleting it.

## 5. Daily use

1. Open the program. Log in.
2. Tap suits, choose a discount if needed, choose the payment method, enter the amount received (or press **Exact**), and press **Save and print**. For a customer who will pay later, choose **Udhaar** instead of Paid in full.
3. The saved box shows the change to return. Press Enter or **New bill** for the next customer.
4. If the printer fails, the bill is already saved. Press **Try printing again**. A bill can never be saved twice by pressing the button twice.
5. A wrong bill: open **Bills**, pick it, **Cancel this bill**, write the reason (owner only). It stays in the records, marked cancelled, and is not counted in sales.

## 6. Backups

- The program copies all data to a backup folder on this PC every day and whenever bills change.
- **Also choose a USB drive:** Settings, Backup, Choose. A copy goes there every day (one file per day, the last 60 days are kept). If the drive is unplugged, a red "Backup problem" note shows at the top.
- Leave the USB drive plugged in, and take a copy home now and then.

**Restoring from a backup** (new PC or a broken data file):
1. Close the program.
2. Copy the newest `binsaad-DATE.json` from the USB drive.
3. Put it in the program's data folder (shown at the bottom of Settings, usually `C:\Users\<name>\AppData\Roaming\Bin Saad Billing\data`) and rename it to `data.json`, replacing the old file.
4. Open the program.

## 7. Staff and passwords

Settings, **People who can log in**: add staff (name, username, password), give a new password, or switch a person off. Staff see only New bill, Bills and Prices. They can make an udhaar bill at the counter but cannot see the Udhaar tab, any cost or any profit.

## 8. What has and has not been tested

Tested by the developer's tools (all passing):
- 53 automatic checks of the money and billing rules, including cost, profit and udhaar: totals, percent and rupee discounts (including rounding), change, cash and wallet rules, double-press protection, bill numbers never repeating, cancel rules, owner-only actions, staff discount limit, search, monthly comparison, backups, damaged-file recovery, receipt contents.
- 63 on-screen checks that click through the real screens in a browser: first-time set-up, pasting suits, tap-to-add billing, 10% discount example, change, saved box, printer-offline recovery, bills search, reprint marked duplicate, cancel, hidden sales and eye button, staff limits, settings.

**Not yet tested (needs the real shop PC):**
- Opening as a Windows program (the installer, desktop icon, window).
- Printing on the real thermal printer: paper width, text size, and the paper cut. This is the first thing to check on day one. Tell the developer what the receipt looks like and it can be adjusted.

## 9. Things to know

- Money is in whole rupees only. Percent discounts are rounded to the nearest rupee (half rounds up).
- Data lives on this one PC. Keep the USB backup going. There is no phone or remote view.
- To update the program later, run a new installer over the old one. Data is kept.
- Not included in this version (can be added): stock counting, returns and exchange, hold bill, day-closing cash check, expenses, a printed slip for money received back on udhaar.

## New in this version
- **Dark look, new tabs:** Checkout, Inventory, Bills, and (owner) Udhaar, Profit, Sales, Settings.
- **Inventory:** each suit name+colour is its own item with a stock count. "+ Stock" adds pieces; "Paste stock counts" loads many. Out-of-stock suits cannot be sold.
- **Invoice numbers** look like BS-0042 (letters can be changed in Settings).
- **Forgot password:** at first start the program shows a recovery code. WRITE IT ON PAPER. On the login screen tap "Forgot password?" and enter it. Existing shops: Settings > Forgot-password code to make one.
- **Eye buttons** on every password box. The sales/profit eye asks for the password once per program start.
- **Receipt** is the new SALES style, centred on 58 mm and 80 mm paper. Exchange line is editable in Settings.
- **Daily sales PDF:** Sales tab > "Download this day (PDF)" (saved in Documents\Bin Saad Reports).
- **Safety:** errors are logged and the screen recovers; a backup is made on close.

## Version 3
- **Dashboard** is the first screen: today's bills, pieces sold, Udhaar owed, recent bills, items running low.
- **Sizes:** Inventory > "Add with sizes" makes Kurta/Waistcoat items in S, M, L, XL, each with its own stock ("Kurta Black (M)"). Shawls and suits have no size.
- **Analytics** (was Profit): pick a month, or a single day; profit by category.
- **Ledger:** stock worth (at cost and at selling price), today and yesterday, best seller, total since opening.
- **Start fresh:** Settings > "Delete test bills before a date" (type CLEAR + password; a backup is made first). On opening day tap **Start real sales** to switch test-clearing off for good.
- Lighter receipt: bold only on the shop name, items and TOTAL DUE.
