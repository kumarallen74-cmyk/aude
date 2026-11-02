# Advertising on charger and kiosk screens (v1.51.0)

**Commercial → Advertising.** Ads on the screens of chargers and kiosks.

## Set up

1. *Settings*: turn advertising on, and set the tax on advertising invoices and the default slot length.
2. *Screens → Add a screen*: its site, and its charger (a charger's screen) or none (a kiosk), with its orientation. The
   player's address is shown once: `https://<console>/v1/ad-player/<key>`. *New key* replaces it.
3. *Advertisers → Add an advertiser*: the name, contact, tax id and billing address.

## The screen's player

The player (the charger's screen software, or a browser in kiosk mode on a media player) uses three calls:

- `GET /v1/ad-player/<key>`: the playlist. It lists the approved creatives of the campaigns running today at the
  screen's site, those for its orientation first. Each item has `seconds`, `weight` (how often it plays, relative to the
  others), `sha256` and `url`. Fetch the playlist again every `refreshSeconds`.
- `GET <url>`: the image or video. Cache it by its `sha256`.
- `POST /v1/ad-player/<key>/plays` with `{"plays": [{"creativeId": "…", "count": 12}]}`: what it played. A screen
  reports at least hourly, and for today or yesterday only. These counts are the proof of play, and campaigns priced
  per play are billed on them.

## Campaigns

A campaign belongs to an advertiser and has:
- its dates and its sites (none chosen: every site with a screen);
- its price: **per thousand plays** (CPM, with an optional budget at which it stops playing), or a **flat fee per
  month** (charged for the days it runs in each month);
- its share of the rotation, from 1 to 10.

It starts as a draft. **Creatives**: JPEG, PNG or WebP images, or MP4 videos, up to 30 MB, each with its length in
seconds. The content must match the file type. Each creative is reviewed: *Approve* lets it play, *Reject* needs the
reason. *Start* needs an approved creative, an end date that has not passed, and budget left.

The worker (hourly) ends campaigns past their end date and pauses CPM campaigns whose budget is spent.

A campaign's page shows:
- its plays by day and by site;
- the money spent;
- the charging sessions at its screens' chargers while it ran: the drivers in front of the screen.

*Proof of play* downloads a spreadsheet of the plays by day, site, screen and creative.

## Invoices

Each month, per advertiser:
- campaigns priced per play, by their plays;
- flat campaigns, by the days they ran;
- the tax and the total.

Last month's invoices are drafted automatically. *Issue* numbers an invoice (`ADV-YYYYMM-NNN`) and fixes it. *Paid*
records the payment's reference. Each invoice downloads as a spreadsheet.
