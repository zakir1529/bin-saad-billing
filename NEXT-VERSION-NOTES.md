# Next version: change list (gathered, NOT built yet)

Build only when the owner says "OK, build". The owner is still testing and will add more items.
Current released version: build-7/build-8 (see GitHub Releases). Receipt, tabs, udhaar and profit are already in.

## Login and password
1. **Forgot password / reset**: a recovery code made once in Settings (shown once, written on paper). Login screen gets a "Forgot password" link that takes the code and lets the owner set a new password. Bills, suits and udhaar are kept.
2. **Eye button on every password box** (login, first set-up, change password, staff passwords) to show what is typed.
3. **Bug**: after first set-up/login the name "Owner" appears at the top of the login box and only goes away after the program is closed and opened again. Fix so it clears straight away.
4. **Eye button for sales/profit** must not ask for the password again and again. Ask once per program start (after closing and reopening the program), then stay unlocked until the program is closed or the user logs out.

## Layout and look
5. Interface (menu tabs, look and feel) to follow the owner's friend's accessories/clothing shop software. Owner will send screenshots. Wait for them before designing.
6. **Inventory** as its own separate tab (stock in), and **Checkout/billing** as a separate tab.

## Receipt
7. Redesign to match the friend's printed bill exactly (photo coming): same structure and wording, quantity column, customer line like theirs. Copy the idea of that design.
8. **58 mm paper**: the receipt must be centred on the paper (today it sits to one side). 80 mm is fine.
9. **Invoice number** on the receipt, so a returned/exchanged suit can be matched to its bill.

## Reports
10. Daily sales as a **PDF download**, like a bank transaction history (list of the day's bills and totals).

## Quality
11. Aim: the program must not crash. Add safety checks and recovery. (No honest 0% guarantee is possible; reduce risk with tests, safe saves, automatic backups.)

## Open items and questions for later
- Returns and exchange: how should it work? (refund, credit note, swap for another suit, stock goes back?)
- Inventory scope: stock count per suit, low-stock warning, stock reduces on each sale?
- Printer: owner's printer is a "Sonic" USB thermal printer. Windows shows only Fax. Driver not installed yet. Model number from the sticker still needed. Receipt does not print until the driver is installed.
- Udhaar and profit work as agreed (receipt never shows udhaar or customer).

## Reference material received (friend's shop POS and printed bill)
Use the STRUCTURE and ideas only. Do NOT copy the other shop's name, logo, email or wording ("ZYRO"). Use Bin Saad Fabrics.

### Friend's printed bill (layout, top to bottom)
- Top row: date and time on the left, the word SALES on the right.
- Logo, big brand name, a rule, shop name, address, then email | phone.
- Block with labels on the left and values on the right: SOLD TO (Walk-in Customer, or the customer's name), DATE, INVOICE (format like 993-SQTC: number, dash, 4 letters).
- Table header: Qty | Item | Price, with rules above and below.
- Each item: qty, item name, a second small line with variant (size / colour), price on the right.
- Banner between dotted lines: "1 ITEM SOLD".
- Subtotal, Discount (10%) shown as -Rs 150, then TOTAL DUE in large bold between dashed lines, then PAYMENT MODE: CASH.
- Footer: thank-you line in capitals, and a small line "Exchange possible within 3 days with receipt."
- The friend's bill does not show udhaar. Bin Saad receipts must still never show udhaar.
- The bill shows "Rs 1,499" style (Rs, space, number) and rounds 10% of 1,499 to 150 (half up, same as our rule).

### Friend's software (dark theme POS, laptop screenshot)
- Dark, left side menu with: Dashboard, Product List, (category tabs like Winter Collection, Accessories), Sales Analytics, Admin Ledger, Website Track, Checkout, Receipts Vault, Settings, Logout (shows "Admin Session").
- Checkout / "Terminal" screen: search products at the top, grid of product cards. Each card: name, category line, colour dropdown, size dropdown showing stock (for example "Size M (4 Stock)" or "Out of Stock"), price, an "Add to Order" button.
- Receipts Vault = a place to find old receipts (like our Bills tab).
- Ideas to take: separate Inventory/Product List tab, separate Checkout tab, stock shown on each product, Out of Stock marking, a Dashboard, a Ledger.

### Questions still open
- Do the suits have sizes or colours as variants, or is each colour its own suit name?
- Dark theme like the friend's, or keep the current quiet light theme? (Earlier rule: the screen must not be easy for customers to read.)
- Return/exchange policy line on the bill (how many days)?
- Invoice number format: simple running number (0001) or like 993-SQTC?
- Printing now works on the owner's printer (our receipts were printed and seen in a photo). 58 mm receipt sits to one side and must be centred.
