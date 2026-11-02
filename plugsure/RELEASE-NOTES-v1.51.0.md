# PlugSure CSMS v1.51.0: release notes

**Date:** 2 November 2026
**Base:** v1.50.0.

v1.51.0 is phase 39: advertising on charger and kiosk screens. It sells campaigns to advertisers, plays them on screens
at the sites, counts the plays and invoices them.

- **Migration:** one, 118. It is additive: seven tables.
- **When nothing changes:** advertising is off until turned on, and a screen plays nothing without running campaigns.
- **New worker:** advertising, hourly. It ends campaigns past their dates, pauses those whose budget is spent, and drafts
  last month's invoices.
- **Fixed:** dates (DATE columns) from phases 37 and 38 were shown a day early east of UTC:
  - swap plan periods (a plan due to renew could be refused a day early);
  - warranty and RMA dates;
  - dealer sales and code expiry;
  - sites' "checked on".
- **Guide:** [`deploy/ADVERTISING.md`](deploy/ADVERTISING.md).

## New

**Commercial → Advertising.**

- **Screens**: a charger's screen or a kiosk at a site, landscape or portrait. Its player fetches its playlist with the
  screen's key and reports what it played. The page shows each screen online or not, with its plays.
- **Advertisers** and their **campaigns**, each with:
  - its dates and its sites (or every site with a screen);
  - its pricing: per thousand plays (with an optional budget) or a flat fee per month, prorated by the days it runs;
  - its share of the rotation.
- **Creatives**: JPEG, PNG or WebP images, or MP4 videos, up to 30 MB. The file type is checked, and each creative is
  approved, or rejected with the reason, before it plays.
- **Audience**: plays by day and by site, the money spent, and the charging sessions at the campaign's screens. *Proof
  of play* downloads a spreadsheet of the plays.
- **Invoices**: monthly, per advertiser: plays or days, the tax and the total. Drafted automatically, issued with a
  number, and marked paid; each downloads as a spreadsheet.

## API

- **25 operations** (`src/api/openapi/catalogue/phase39.ts`), 1093 in all:
  - `/v1/advertising/settings`;
  - `/v1/advertisers*`;
  - `/v1/ad-screens*`;
  - `/v1/ad-campaigns*`, `/v1/ad-creatives*`;
  - `/v1/ad-invoices*`.
- **Public, with each screen's own key:** the player's API: `GET /v1/ad-player/{key}`,
  `GET /v1/ad-player/{key}/creatives/{id}`, `POST /v1/ad-player/{key}/plays`.
- The SDK is regenerated (1.51.0).

## Upgrading

1. Run migration 118 (`db/migrations/118_screen_advertising.sql`; rollback `db/rollback/118_down.sql`).
2. Deploy. Creatives are kept under `STORAGE_DIR/ads`: keep it on a persistent volume and in the backup.
3. Optional: see `deploy/README.md` item 44.

## Tests

`src/services/phase39.db.test.ts` covers:
- pricing per play and flat;
- screens and their keys;
- a campaign that plays only when active, with an approved creative, at its sites;
- the file type check;
- proof of play;
- the budget pausing a campaign;
- the invoice: plays, days prorated, the tax, the number, paid;
- campaigns ending.
