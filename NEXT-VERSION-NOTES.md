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
