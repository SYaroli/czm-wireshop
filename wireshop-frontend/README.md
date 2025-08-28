# Wireshop Inventory Patch

This zip contains two updated pages:

- `inventory.html` — robust QR/URL part-number parsing, plus a desktop prompt when opened without a PN. The top nav "Inventory" now points to `/inventory` (list view); QR codes keep using `/inv/<pn>` which Render rewrites to this page.
- `inventory-list.html` — upgraded list view with inline **adjust** buttons (−5/−1/+1/+5 and custom delta), live updates, and links to the single-item page for scans.

## What changed
- **inventory.html**
  - Parses PN from `/inv/<pn>`, `?part=`/`?pn=`, or `#pn=` and tolerates subfolders.
  - If no PN is present, shows an **Enter Part Number** prompt and remembers the last PN.
  - Nav "Inventory" links to `/inventory` so desktop users go to the list.
- **inventory-list.html**
  - Loads catalog, merges backend snapshots (`/api/inventory-all`), shows Min and Qty.
  - Inline adjustments post to `/api/inventory/:pn/adjust` and update the row.

## How to deploy
1. Back up your current `inventory.html` and `inventory-list.html`.
2. Replace them with the versions in this zip.
3. Your Render rules are already set:
   - `/inv/*` → `/inventory.html`
   - `/inventory` → `/inventory-list.html`
4. Hard refresh (Ctrl+F5) after deploy to bust caches.

Phones keep scanning to `/inv/<pn>` and work as before. Desktop users hit `/inventory` and get the full list with inline edits.
