I have comprehensive coverage. Here is the report.

---

# Payment Integration Options for PlugSure — Indonesia EV Charging SaaS

**Research date: 23 August 2026.** Figures verified against primary sources where possible. Uncertain or dated items are flagged inline with ⚠️.

---

## Executive summary

Four findings drive the architecture:

1. **QRIS has no pre-authorization. It never will in its current form.** The BI/ASPI standard defines a single immediate debit. Auth-then-capture does not exist on the QRIS rail. Any design that assumes "hold Rp200k, capture Rp87k" over QRIS is unbuildable.
2. **A regulatory change lands 1 October 2026 that is unusually favourable to EV charging.** BI extends 0% MDR to *all* merchant categories for transactions ≤ Rp100,000. A large share of Indonesian charging sessions fall under that line, making QRIS effectively free to accept for AC and small DC sessions.
3. **E-wallet tokenization is the closest thing Indonesia has to a pre-auth**, and it is a better fit than pre-auth anyway. Link the wallet once, then charge the exact final amount server-side after the session ends. Xendit documents this end-to-end.
4. **A stored-balance wallet is legal without a BI licence only below Rp1 billion of float, and only if it is genuinely closed-loop.** This is a hard ceiling that PlugSure will hit at modest scale, and the multi-tenant CPO model puts the "closed-loop" characterisation at risk. Treat this as a board-level decision, not an implementation detail.

**Recommendation in one line:** QRIS dynamic MPM as the universal fallback, e-wallet tokenization as the primary path for repeat drivers, card pre-auth for the premium/fleet segment, postpaid VA invoicing for B2B — and *avoid* a stored-balance wallet until you have legal advice and a licensing plan.

---

## 1. QRIS

### 1.1 What it is

QRIS (Quick Response Code Indonesian Standard) is Bank Indonesia's mandatory unified QR standard, launched August 2019 and compulsory for all QR payment providers since January 2020. One QR code accepts every participating bank and e-wallet. Reach as of mid-2026: **57M+ users** ([PaymentBrief](https://paymentbrief.com/markets/indonesia/), verified 21 Aug 2026).

### 1.2 MPM vs CPM, static vs dynamic

Per [Bank Indonesia's official QRIS page](https://www.bi.go.id/en/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx):

| Mode | Who presents | Amount | Intended for |
|---|---|---|---|
| **MPM Static** | Merchant displays a printed/fixed QR | Customer types it in | Micro/small merchants |
| **MPM Dynamic** | Merchant generates a per-transaction QR | Embedded in the QR | Medium/large, high volume |
| **CPM** | Customer's app shows a barcode, merchant scans | Merchant enters | Fast-throughput retail, transit |

**For PlugSure: MPM Dynamic is the only sensible choice.** Static QR means the driver types the amount, which is a support-ticket generator and a fraud vector (underpayment). Dynamic QR is generated per session via API, carries the exact amount, and reconciles cleanly against a session ID.

CPM is worth noting for a future hardware roadmap — it maps to the "scan the driver's phone at the charger" flow — but it requires a scanner on the charge point and is normally reserved for transit-grade throughput. Not a phase-one concern.

### 1.3 Transaction limit ⚠️ — correct a widespread error

**Current limit: Rp10,000,000 per transaction**, set by **PADG No. 3/2025 (19 February 2025)**, confirmed on BI's own QRIS page.

⚠️ **Warning:** search results are polluted with articles claiming a **Rp20 million** limit. I traced these to [Katadata](https://katadata.co.id/finansial/keuangan/620647c676342/bi-naikkan-lagi-limit-transaksi-qris-jadi-rp-20-juta) and [ANTARA](https://www.antaranews.com/berita/2698541/bi-rencana-tingkatkan-limit-transaksi-qris-hingga-rp20-juta), **both published 11 February 2022** — a Perry Warjiyo announcement that was superseded. The [ezeelink 2026 limit guide](https://ezeelink.co.id/blog/limit-qris/) explicitly flags the Rp20M figure as stale. Do not let Rp20M into the architecture doc.

There is **no uniform national daily/monthly cap**; issuers set their own cumulative limits by risk profile and KYC tier. Practical consequence: a driver's own bank may block a Rp900k DC fast-charge session even though it is well under the per-transaction ceiling. Your error handling must distinguish "issuer limit" from "insufficient funds" and surface a useful message.

Rp10M is comfortably above any plausible single charging session, so the ceiling is not a binding constraint for PlugSure.

### 1.4 MDR — and the October 2026 change

**Current structure, effective 15 March 2025** ([Bank Indonesia](https://www.bi.go.id/id/publikasi/ruang-media/cerita-bi/Pages/mdr-qris.aspx)):

| Category | MDR |
|---|---|
| Micro (UMI), transaction ≤ Rp500,000 | **0%** |
| Micro (UMI), transaction > Rp500,000 | **0.3%** |
| Small / Medium / Large (UKE / UME / UBE) | **0.7%** |
| Education | 0.6% |
| Fuel stations (SPBU) | **0.4%** |
| Government services, BLU, PSO, G2P, donations | 0% |

**Change effective 1 October 2026** — announced 17 August 2026 by Acting Governor **Destry Damayanti** ([ANTARA](https://www.antaranews.com/berita/5697901/bi-perluas-kebijakan-mdr-qris-0-persen-untuk-pelaku-umkm), [LBS](https://www.lbs.id/publication/berita/kebijakan-mdr-qris-gratis-0-mulai-oktober-2026)):

| Category | ≤ Rp100,000 | Above threshold |
|---|---|---|
| UMI | 0% (up to Rp500k) | 0.3% |
| UKE / UME / UBE | **0%** | 0.7% |
| Education | **0%** | 0.6% |
| SPBU | **0%** | 0.4% |
| Government | 0% | 0% |

Applied automatically, no merchant re-registration.

**Why this matters enormously for PlugSure.** At a PLN SPKLU fast-charge tariff of roughly Rp2,466/kWh, a 20 kWh top-up is ~Rp49,000 and a 40 kWh session is ~Rp99,000 — both under the Rp100,000 line. AC destination charging is almost always under it. A meaningful majority of your session volume will attract **zero MDR** from October 2026.

This has a direct product implication: **it weakens the financial case for a prepaid wallet.** The classic reason CPOs push stored balance is to amortise per-transaction fees across a single large top-up. If per-session QRIS acceptance is free below Rp100k, that argument mostly evaporates — and with it, the main justification for taking on e-money regulatory risk (see §3.3).

**Two open questions to put to your acquirer, not resolvable from public sources:**

- ⚠️ **Does EV charging get classified as SPBU (0.4%)?** Globally, EV charging has its own code, **MCC 5552**, separate from service stations ([Visa](https://usa.visa.com/content/dam/VCOM/global/support-legal/documents/faqs-about-using-mcc-5552.pdf), [PXP directory](https://www.pxp.io/mcc-codes/5552-electric-vehicle-charging)). I found no BI or ASPI guidance on whether SPKLU maps to the Indonesian SPBU MDR category. The delta is 0.7% vs 0.4% — material at scale. **Ask your PJP in writing during onboarding and get the MCC assignment confirmed.**
- **Who is the "merchant" in a multi-tenant model** — PlugSure or the site host? This determines the UMI/UKE classification and therefore the rate. See §2.5.

**Surcharging is prohibited.** BI explicitly forbids passing MDR to the consumer. You cannot add a "QRIS fee" line to the driver's receipt. Build MDR into the kWh tariff.

### 1.5 Settlement timing

⚠️ **Genuinely uncertain from public sources — verify contractually.** Neither Midtrans nor Xendit publishes a clean per-channel settlement table on an accessible page (Xendit's channel-timing article is blocked by robots.txt; Midtrans's per-method breakdown is not published).

What is documented:
- **Midtrans**: payouts can be requested any business day, but a transaction is only payout-eligible after it has been settled for **at least 3 business days** ([docs](https://docs.midtrans.com/docs/when-can-i-withdraw-my-transaction-funds-from-midtrans)).
- **Direct acquirer QRIS** is conventionally **T+1 business day**, but banks split static-QR settlement into batches and timing varies by acquirer.

Treat "T+1" as an industry rule of thumb, not a contractual fact. **Negotiate settlement SLA explicitly** — it directly sets your working-capital requirement for paying site hosts.

### 1.6 How a platform integrates QRIS

You cannot acquire QRIS yourself without a BI licence. Two routes:

1. **Via a licensed PJP / payment gateway** (Midtrans, Xendit, DOKU, Faspay). Fast, no licence needed, PJP is merchant of record or aggregator. **This is the correct route for PlugSure.**
2. **Direct with an acquiring bank** (BRI, BCA, Mandiri, BNI each expose QRIS APIs — e.g. [BRIAPI QRIS MPM Dynamic](https://developers.bri.co.id/en/docs/qris-merchant-presented-mode-mpm-dynamic)). Better rates at very high volume, far slower onboarding, and you carry more compliance weight.

Integration mechanics ([ezeelink API guide](https://ezeelink.co.id/blog/integrasi-api-qris/)) — the non-negotiables:
- Generate QR server-side with order ID, amount, expiry; display with a countdown.
- **Rely on webhooks, not browser redirects.** The driver may close the app mid-session.
- **Verify webhook signatures.** Never trust an unsigned JSON payload.
- **Idempotency keys** on every handler — replayed events are routine.
- Model transaction state as an explicit state machine with only legal transitions (pending → paid | expired).
- Server-to-server status polling as backstop, with timeout and exponential backoff.
- **Daily three-way reconciliation**: internal sessions vs PJP transactions vs settlement report, with a manual exception queue. Do not auto-correct discrepancies.

### 1.7 Pre-authorization on QRIS — definitively no

**QRIS does not support pre-authorization, holds, or auth-then-capture.** This is confirmed by absence across BI's specification, the ASPI standard, and every PJP integration guide reviewed. QRIS is a single immediate debit of a fixed amount.

The workaround CPOs reach for — **charge the maximum, then refund the difference** — is technically possible (DOKU documents automated QRIS refunds via Direct API across 24 banks and 30 e-wallets), but it is a poor product:

- The driver is debited the full amount up front. Charging Rp250k to deliver Rp80k of electricity is a conversion killer in a price-sensitive market.
- Refund settlement is slow and varies by issuer.
- Refund volume at that ratio will attract PJP risk-team attention and may look like laundering typology.
- Your float obligation balloons, and — see §3.3 — money you hold pending refund starts to look uncomfortably like float.

**Do not build this.** Use §3's recommended architecture instead.

### 1.8 QRIS Tap (NFC)

Launched **14 March 2025** ([ezeelink](https://ezeelink.co.id/blog/qris-tap-definisi-cara-kerja/)). Tap-to-pay over NFC, ~0.3 second transaction, no QR scan. ~15 issuers live including BCA, BNI, BRI, Mandiri, Bank Mega, GoPay, ShopeePay, DANA, Netzme. Requires an **NFC-capable terminal at the merchant** and an NFC phone with a compatible app. Same MDR and rules as standard QRIS.

**Relevance to PlugSure: interesting, phase three.** It requires NFC reader hardware in the charge point. If you are specifying chargers now, an NFC reader in the BOM gives you QRIS Tap *and* RFID card support (the global CPO standard for fleet/subscriber identification) from the same component. That is a cheap option to buy at hardware-spec time and expensive to retrofit. **Worth raising with hardware now even though the software is later.**

### 1.9 Cross-border QRIS

Live corridors as of July 2026 ([ezeelink](https://ezeelink.co.id/blog/qris-cross-border-2026/)): **Thailand, Malaysia, Singapore, Japan, South Korea, China.** India, Hong Kong and Timor Leste are announced for 2026. DOKU independently lists Malaysia (16 providers), Singapore (NETS/SGQR), Thailand (6 banks), China (6 providers), South Korea (5 institutions).

Mechanics: Rp10M per-transaction cap applies; FX converts automatically in the payment flow; **the Indonesian merchant settles in IDR regardless of payer origin.**

⚠️ **Critical caveat:** acceptance is **not automatic**. Corridor support depends on your PJP, the specific corridor, and per-account enablement. Confirm with your PJP and run a live test before advertising it.

**Relevance to PlugSure: modest but real.** Inbound tourists renting EVs in Bali and Jakarta are a genuine segment, and it is a differentiator versus a CPO whose app requires an Indonesian phone number. Low effort if your PJP already supports it — verify, don't assume.

---

## 2. Payment gateways

### 2.1 Midtrans

PT Midtrans, part of GoTo Financial (same group as GoPay/Gojek). BI-licensed PJP.

**Published fees** ([midtrans.com/pricing](https://midtrans.com/pricing)):

| Method | Fee |
|---|---|
| Virtual Account (BCA, BNI, Mandiri, Permata, CIMB, Danamon, BSI, SeaBank, Bank Saqu) | **Rp4,000 / txn** |
| QRIS | **0.7%** |
| GoPay | 2% |
| ShopeePay | 2% |
| DANA | 1.5% |
| OVO | 1.5% |
| Cards (Visa, MC, JCB, Amex, UnionPay) | **2.9% + Rp2,000** |
| Akulaku PayLater | 1.7% |
| Kredivo | 2% |
| Indomaret | direct to partner + Rp1,000 |
| Alfamart / Alfamidi / DAN+DAN | Rp5,000 |
| **Payout — bank account** | **Rp5,000** |
| **Payout — GoPay** | **Rp2,500** |

Free setup and integration. Fees exclude VAT *except* QRIS, GoPay and ShopeePay. Different rates apply to gaming/digital-goods merchants.

**Pre-authorization** — [docs](https://docs.midtrans.com/reference/card-feature-pre-authorization). Best-documented pre-auth of any Indonesian gateway:
- Set `"type": "authorize"` in the `credit_card` object on charge.
- Capture via the Capture API; status moves `authorize` → `capture`.
- **Capture amount may be lower than authorized, never higher.** Undefined = capture full amount.
- **Hold lasts 7 days**; funds auto-release if uncaptured.
- Retry/cancel window extends to 8 days.
- `challenge` fraud status must be explicitly approved or it auto-cancels.

**Recurring / tokenization** — [docs](https://docs.midtrans.com/docs/one-click-two-clicks-and-recurring-transaction):
- **One Click** — full card incl. CVV tokenized, single-action payment.
- **Two Clicks** — token without CVV; customer re-enters CVV each time.
- **Recurring/Subscription** — merchant-initiated, no customer interaction. There is a dedicated [Create Subscription](https://docs.midtrans.com/reference/create-subscription) endpoint.
- ⚠️ **Gating:** the first transaction must succeed **in 3DS mode**. One Click and recurring require **additional acquiring-bank approval and agreement** — this is a commercial negotiation with lead time, not a dashboard toggle. Start it early.

**Disbursement (Iris / Payouts)** — [docs](https://docs.midtrans.com/docs/disbursement-overview):
- Real-time to Mandiri, CIMB, BCA, Danamon, BNI, BRI, Permata. Others via **SKN** (national clearing, slower).
- Two models: **Aggregator** (you hold a topped-up balance with Midtrans, faster onboarding) vs **Facilitator** (your own bank account is the funding source, requires bank registration).
- Maker/Approver dual-control workflow; REST API plus dashboard with CSV/Excel bulk upload.
- Balance inquiry, create transfer, approve transfer, statements.

**Split payment: no native sub-merchant split.** Midtrans's answer to multi-tenant payout is "collect centrally, disburse via Iris." That works but you carry the ledger.

**QRIS specifics** — [docs](https://docs.midtrans.com/reference/qris): acquirers are **GoPay and ShopeePay (AirPay Shopee)** only; IDR only; on-us/off-us distinction in the response; statuses `pending`/`settlement`/`expire`/`deny`.

**Bonus: GoPay Mini App.** Midtrans offers [GoPay Mini App](https://midtrans.com/product/gopay-mini-app) integration — your service embedded inside the GoPay app, auto-login without phone re-entry, access to GoPay's DAU, marketing surface (banners, notifications), integration "within days," **no setup fee from GoPay**. See §5.3.

Docs: **docs.midtrans.com**. Free sandbox. Official SDKs for Node, Python, PHP, Java, Ruby, Go.

### 2.2 Xendit

PT Sinar Digital Terdepan. BI-licensed PJP. Also operates in the Philippines.

**Published list fees** ([xendit.co/en-id/pricing](https://www.xendit.co/en-id/pricing/)) — structure is **payment method fee + Rp4,000 processing fee**:

| Method | Method fee | + Processing |
|---|---|---|
| QRIS | **0.70%** (incl. VAT) | Rp4,000 |
| Virtual Account (BCA, BNI, BRI, Mandiri, Permata, CIMB, Neo, Sampoerna) | **Rp9,000** | Rp4,000 |
| Cards domestic & international (Visa/MC/JCB) | 2.90% + Rp2,000 | Rp4,000 |
| AMEX | 3.90% + Rp2,000 | Rp4,000 |
| Card installments (3–12 mo) | 5.00–10.00% + Rp2,000 | Rp4,000 |
| OVO | 3.00–5.50% | Rp4,000 |
| DANA | 3.00% | Rp4,000 |
| ShopeePay | 2.50% | Rp4,000 |
| GoPay | 3.00–5.00% | Rp4,000 |
| LinkAja | 2.00–3.15% | Rp4,000 |
| Jenius Pay / Astrapay | 2.00% | Rp4,000 |
| Kredivo / Akulaku / Indodana | 2.00–2.30% | Rp4,000 |
| Direct Debit (BRI) | 1.90% | Rp4,000 |
| Alfamart / Indomaret | Rp9,000 | Rp4,000 |
| **Payouts / disbursement** | **1.00%, min Rp2,500** | Rp4,000 |

⚠️ **These are list prices and they are materially worse than Midtrans on the headline** — VA at Rp13,000 all-in versus Midtrans's Rp4,000; e-wallets at 3–5.5% versus 1.5–2%. **Xendit list pricing is heavily negotiated down at volume**; do not treat this table as what you would actually pay. Get both to quote against a projected volume profile.

**Pre-authorization** — [docs](https://docs.xendit.co/docs/cards-capturing-a-card-payment):
- `POST /sessions` with `"capture_method": "MANUAL"`, `"session_type": "PAY"`.
- Await `payment.authorization` webhook → capture at `POST /v3/payments/{payment_id}/capture`.
- **Hold ~7 days**, then released.
- Partial capture "conditionally supported" and **country-dependent** — ⚠️ **confirm explicitly for Indonesia**, the docs hedge.
- ⚠️ **Multiple partial captures are NOT supported.** One capture per authorization. For EV charging that is fine (one session, one capture), but it forecloses split-billing patterns.

**E-wallet tokenization — the standout feature for PlugSure** ([docs](https://docs.xendit.co/id/ewallet/payment-flows/tokenized-payment), [help article](https://help.xendit.co/hc/en-us/articles/13322736469529-How-to-create-eWallet-Tokenization)):
1. Create a customer object.
2. `POST /v2/payment_methods` with customer ID and channel code (OVO documented).
3. Return an auth URL; driver authorizes the link once in their wallet app.
4. Success callback confirms linkage.
5. Thereafter `POST /ewallets/charges` with `"checkout_method": "TOKENIZED_PAYMENT"` and the stored payment method ID — **merchant-initiated, arbitrary amount, no customer interaction.**

This is the single most important capability for solving the unknown-amount problem in Indonesia. See §3.
⚠️ The full list of tokenization-supported wallets is not published; OVO is documented. **Confirm DANA, ShopeePay and GoPay coverage directly** — it determines your addressable base.

**Split payments / xenPlatform** — [split rules docs](https://docs.xendit.co/docs/split-payments), [product page](https://www.xendit.co/en/products/xenplatform/):
- Split rules at `POST /split_rules`, flat or percentage, multi-currency (IDR, PHP, THB, VND, MYR).
- Splits calculated on transaction total **minus fees**.
- Three routing patterns: sub-account → master, sub-account → sub-account, master → sub-account.
- Multiple routes per transaction ("5% to platform + 3% to sub-account B").
- **Owned** sub-accounts (platform controls via API/dashboard) vs **Managed** (sub-merchant gets dashboard access, own withdrawals, own channel activation).
- KYC: "let Xendit fully KYC your accounts, or reuse your existing business processes."
- Platform fee auto-deducted — a native revenue mechanism.

**This is the decisive differentiator for a multi-tenant CPO platform.** It means each site host can be a sub-merchant, funds split at transaction time, and PlugSure's take-rate is deducted automatically rather than reconciled after the fact. Midtrans has no equivalent.

**Virtual accounts** — [explainer](https://www.xendit.co/en-id/blog/what-is-a-virtual-account-and-how-does-it-work/): **Fixed** (persistent, tied to a customer identifier, multiple payments) vs **single-use**; **open** amount (any amount above a minimum) vs **closed** (exact amount only). Per-customer VA solves Indonesia's core reconciliation problem — banks do not reliably expose sender identity on transfers, and 60–80% of B2B transactions move by bank transfer. See §4.

Docs: **docs.xendit.co**. Free sandbox/test mode. SDKs for Java, PHP, Python, Node, Go.

### 2.3 DOKU

PT Nusa Satu Inti Artha. One of the oldest Indonesian gateways, BI-licensed.

- **QRIS**: static and dynamic, both activate together. No-integration options (Payment Links, Digital Catalog) plus DOKU Checkout and Direct API ([docs](https://docs.doku.com/accept-payments/no-integration-products/qris)).
- **Refunds**: automated via Direct API across **24 banking institutions** (BRI, BCA, Mandiri…) and **30 e-wallet providers** (OVO, GoPay, ShopeePay, DANA…), with real-time status via API callbacks. **The strongest published refund coverage of any gateway reviewed** — relevant if you ever do need the charge-then-refund pattern.
- **Cross-border QRIS**: the widest published corridor list — Malaysia (16 providers), Singapore (NETS/SGQR), Thailand (6 banks), China (6), South Korea (5). Settles IDR.
- Requires an Indonesian Business Account; QRIS operates only in Indonesia.
- ⚠️ **Pricing not published.** Quote required.
- ⚠️ **Pre-auth support unconfirmed** — the docs site restructured and card pages returned 404s during research. Ask directly.
- Docs: **docs.doku.com** and **developers.doku.com**.

**Assessment:** credible incumbent, strong on QRIS refunds and cross-border, but no published pricing and no evidence of native split-payment. A reasonable third quote, not a front-runner.

### 2.4 Faspay and iPaymu

**Faspay** (PT Media Indonusa) — [faspay.co.id](https://faspay.co.id/en/): 50+ payment methods across 30+ partners. Products: **Business** (acceptance), **Billing** (invoices via chat platforms), **Sendme** (disbursement to 150+ banks, e-wallets, VAs), **Cashout** (retail withdrawal), **QRIS**. BI-licensed, PCI-DSS Level 1. ⚠️ No published pricing. *Sendme's 150+ destination coverage is the widest disbursement reach found* — relevant if site hosts bank with smaller regional institutions.

**iPaymu** — [ipaymu.com](https://ipaymu.com/en/): positions on price ("Rp 3.5K Virtual Account Best Price" — cheaper than both Midtrans and Xendit on VA if accurate). Supports VA, QRIS static+dynamic, Alfamart/Indomaret, domestic and international cards, direct debit, e-wallets, COD. Claims "realtime settlement." PCI-DSS certified; PSE registration 004433.01/DJAI.PSE/07/2022. ⚠️ **Note carefully: the site evidences Kominfo PSE registration, which is an electronic-system registration, NOT a BI PJP payment licence.** These are different things and PSE registration does not authorise payment services. **Verify BI PJP licence status directly before shortlisting.** Pricing at ipaymu.com/en/pricing.

**Assessment:** both are viable for simple acceptance. Neither shows evidence of pre-auth, tokenization, or native split payment. For PlugSure's requirements they are backups, not candidates.

### 2.5 Comparison matrix

| Capability | Midtrans | Xendit | DOKU | Faspay | iPaymu |
|---|---|---|---|---|---|
| QRIS dynamic | ✅ (GoPay/ShopeePay acq.) | ✅ | ✅ | ✅ | ✅ |
| VA — major banks | ✅ Rp4,000 | ✅ Rp13,000 list | ✅ | ✅ | ✅ ~Rp3,500 |
| Cards | ✅ 2.9%+Rp2k | ✅ 2.9%+Rp2k | ✅ | ✅ | ✅ |
| E-wallets | ✅ 1.5–2% | ✅ 2.5–5.5% list | ✅ | ✅ | ✅ |
| BNPL (Kredivo/Akulaku) | ✅ 1.7–2% | ✅ 2.0–2.3% | ✅ | ✅ | — |
| **Card pre-auth / capture** | ✅ **best documented**, 7d | ✅ 7d, no multi-partial | ⚠️ unconfirmed | ⚠️ | ⚠️ |
| **E-wallet tokenization** | ⚠️ unclear | ✅ **documented** | ⚠️ | ⚠️ | ⚠️ |
| Card recurring / subscription | ✅ + Subscription API | ✅ | ⚠️ | ⚠️ | ⚠️ |
| **Native split / sub-merchant** | ❌ | ✅ **xenPlatform** | ❌ | ❌ | ❌ |
| Disbursement API | ✅ Iris, Rp5,000 | ✅ 1%, min Rp2,500 | ✅ | ✅ Sendme, 150+ | ⚠️ |
| Published pricing | ✅ | ✅ | ❌ | ❌ | partial |
| Sandbox | ✅ | ✅ | ✅ | ✅ | ✅ |
| BI PJP licence | ✅ | ✅ | ✅ | ✅ | ⚠️ verify |

**Recommendation: Xendit primary, Midtrans secondary.** Xendit wins on the two capabilities that define this product — e-wallet tokenization and native sub-merchant splitting. Midtrans wins on headline price and pre-auth documentation quality, and its GoPay Mini App route is a genuine distribution asset. Running both is defensible: Xendit for the tokenized/split core, Midtrans for QRIS and cards where its pricing is better. Budget for the integration overhead of two gateways only if volume justifies it; otherwise start with Xendit and keep Midtrans as the negotiating lever and failover.

---

## 3. The EV charging payment problem

### 3.1 The problem

At session start the final amount is unknown. It depends on kWh delivered, session duration, whether the driver unplugs early, idle fees, and tariff tier. Payment must be secured *before* electricity flows, but the amount is only known *after*.

### 3.2 How CPOs solve it globally

**(a) Pre-auth hold, then capture.** Authorize a worst-case amount at session start, capture the actual amount at end, release the remainder. Real-world hold amounts:

| Operator | Hold | Release |
|---|---|---|
| [ChargePoint](https://www.chargepoint.com/drivers/support/faqs/how-much-pre-authorization-hold-amount-sessions-started-without-chargepoint) (guest, no account) | **$50** | — |
| [EVgo](https://helpcenter.evgo.com/hc/en-us/articles/20444993723543-Pre-Authorization-Holds) | **up to $60** | 3–5 business days |
| [EVCS](https://support.evcs.com/hc/en-us/articles/22972419096468-Why-is-there-a-30-or-50-hold-on-my-credit-card) | **$30 or $50** | — |

Universal complaint: drivers see two entries (the hold and the charge) and think they were double-billed. Every one of these operators maintains a dedicated support article about it.

**(b) Prepaid wallet / stored balance.** Driver tops up, sessions debit the balance. Solves unknown-amount entirely (check balance ≥ minimum, then debit actual). Amortises transaction fees. **But it creates float, and float is regulated** — see §3.3.

**(c) Postpaid invoicing.** Sessions accrue; invoice monthly. Standard for B2B fleet where creditworthiness is established. Requires credit risk management.

**(d) Account + RFID/tokenized identity.** Driver identified at the charger by RFID card or app; payment instrument on file charged post-session. This is what tokenization enables in software form.

### 3.3 What actually works in Indonesia — and the compliance trap

**Pre-auth on cards: works, but limited reach.** Both Midtrans and Xendit support it with 7-day holds. But card penetration is ~35% ([PaymentBrief](https://paymentbrief.com/markets/indonesia/)), and while EV owners skew affluent, restricting charging to cardholders forecloses a large share of drivers. **Viable as a premium/guest path, not as the default.**

**Pre-auth on QRIS: impossible.** §1.7. QRIS is 57M+ users and the default payment habit — and it cannot hold funds. This is the central constraint.

**E-wallet tokenization: the right answer.** Xendit's tokenized payment flow gives you exactly what pre-auth gives you, without the hold:

- Driver links their wallet **once**, at signup.
- At session start, PlugSure validates the token — no debit, no hold, no visible pending charge.
- At session end, PlugSure charges the **exact final amount** server-side.
- The driver sees one clean transaction for the right amount. No "why is there Rp250,000 pending on my DANA."

This is strictly better UX than pre-auth, and it fits Indonesian payment habits (e-wallets ~35% of consumer payment volume, and per [Ipsos February 2026](https://www.ipsos.com/en-id/mapping-digital-wallet-landscape-2026-which-platform-leads-users-preferred-choice-according-ipsos): ShopeePay 91% 3-month usage, GoPay 67%, DANA 67%, OVO 44%).

⚠️ **Caveat that must be resolved before committing:** tokenization does not guarantee funds. A driver can link a wallet with a zero balance. Mitigations: risk-score by history, cap unsecured session value for new users, degrade to prepay-a-fixed-amount for users with a failed charge, and check wallet balance at session start where the API exposes it.

**Prepaid wallet: legally hazardous. Read this carefully.**

The governing regulation is **PBI No. 20/6/PBI/2018 on Uang Elektronik**. Confirmed consistently across [SSEK](https://ssek.com/blog/bank-indonesia-sets-new-limits-for-the-provision-of-e-money/), [ABNR](https://www.abnrlaw.com/news/details-on-the-updated-e-money-regulation) and [Conventus Law](https://conventuslaw.com/report/indonesia-details-on-the-updated-e-money/):

| Concept | Rule |
|---|---|
| **Closed loop** | Payment recipient is **the same party that issued** the e-money |
| **Open loop** | Usable to pay **parties other than the issuer** |
| **Closed-loop exemption** | Floating funds **< Rp1,000,000,000** → "Exempted Closed-Loop E-Money", **no BI licence required** |
| **Above Rp1bn float** | **BI licence mandatory** |
| **Float calculation** | Aggregated **across all systems** the issuer operates (server-based + chip-based) |
| **Open loop** | Licence required **regardless of float amount** |

Capital requirements for licensed non-bank issuers:

| Floating funds | Minimum paid-up capital |
|---|---|
| Baseline | **Rp3 billion** |
| Rp3–5 billion | Rp6 billion |
| Rp5–9 billion | Rp10 billion |
| > Rp9 billion | Rp10 billion + 3% of excess |

Plus: **foreign ownership capped at 49%** (direct and indirect), PT structure mandatory, majority of directors domiciled in Indonesia, and Article 70 obligations to provide reports, data and clarification to BI on demand.

User balance caps (since 1 July 2022): **unregistered Rp2 million**; **registered Rp20 million balance, Rp40 million/month** turnover.

Separately, under **PBI No. 23/6/PBI/2021** the PJP licensing tiers are ([BI regulation text](https://www.bi.go.id/en/publikasi/peraturan/Documents/PBI_230621_EN.pdf)): **Category 1 — Rp15bn** (fund source administration, information provision, payment initiation/acquiring, remittance); **Category 2 — Rp5bn** (information + initiation/acquiring); **Category 3 — Rp500m**, or Rp1bn if providing systems to other Category 3 PJPs. Ownership: min 15% Indonesian, min 51% domestic voting shares.

**Two specific risks for PlugSure:**

**Risk 1 — the Rp1bn ceiling arrives fast.** If 10,000 active drivers hold an average Rp100,000 balance, you are at Rp1bn. That is a small, entirely achievable user base. The exemption is not a long-term structure; it is a runway of limited length.

**Risk 2 — and this is the more serious one — a multi-tenant CPO platform may not be closed-loop at all.** The closed-loop test is whether *the recipient of payment is the same party that issued the e-money*. If a driver tops up a PlugSure balance and then spends it on electricity delivered by **a third-party site host or independent CPO**, a regulator can readily characterise the recipient as a party other than the issuer — which makes it **open loop, and open loop requires a licence at any float level**. The Rp1bn exemption would simply not apply.

This is precisely where PlugSure's multi-tenant architecture collides with the regulation, and it is not a question you can safely resolve from public sources.

**How companies structure around this in practice** (each requires legal validation, none is a shortcut):
- **Partner with a licensed e-money issuer** — white-label an existing licensed wallet; they hold the float and the licence, you hold the UX.
- **Route through your PJP's balance** — some gateways can hold merchant-side balances under their own licence.
- **Stay genuinely closed-loop** by structuring PlugSure as merchant of record for all electricity sold, with site hosts as suppliers paid under commercial contract rather than as payment recipients. This is a real structure, but it changes your tax, VAT and commercial position materially, and must be designed with counsel — not retrofitted.
- **Avoid float entirely** using tokenization (the recommendation below).

⚠️ **Flag for the architecture doc: engage Indonesian payments counsel before writing a single line of wallet code.** The cost of getting this wrong is not a refactor; it is unlicensed provision of payment services. Note also that BI's framework continues to move — PADG No. 32/2025 tightened payment-industry licensing and sanctions, which I did not research in depth and which should be part of the counsel brief.

### 3.4 Recommended approach

A tiered model that avoids float, avoids visible holds, and degrades gracefully:

**Tier 1 — Registered driver, wallet linked (target: majority of volume)**
E-wallet tokenization via Xendit. Link once at signup. Validate token at session start, charge exact amount at session end. No hold, no float, no e-money licence. **This is the primary path and the product should push hard toward it.**

**Tier 2 — Registered driver, card on file (premium / fleet drivers)**
Card tokenization with pre-auth at session start (a conservative worst-case amount), capture actual at session end. Midtrans's 7-day window is ample. Requires 3DS on first transaction and acquirer approval for One Click/recurring — **begin that negotiation early.**

**Tier 3 — Guest / walk-up (QRIS)**
Because QRIS cannot hold, invert the flow: **pre-purchase a fixed quantity.** Driver scans a dynamic QRIS for a chosen amount (Rp50k / Rp100k / Rp150k), and the charger delivers exactly that much energy, then stops. This is not a compromise — **it is what PLN already does at SPKLU via PLN Mobile**, so it matches existing Indonesian driver expectations rather than fighting them. No unknown amount, no hold, no refund. And with the October 2026 rule, sessions at the Rp50k and Rp100k tiers carry **0% MDR**.

Deliberately price your QRIS tiers to cluster at or below Rp100,000 where possible — it is free money.

**Tier 4 — B2B fleet**
Postpaid. Sessions accrue against a corporate account; monthly invoice with a dedicated virtual account. See §4.

**Explicitly do not build:** a stored-balance driver wallet, or charge-max-then-refund on QRIS. The first is a licensing exposure that your multi-tenant model makes worse; the second is bad UX that only postpones the same problem.

**One consequence worth surfacing:** this architecture makes registration genuinely valuable to the driver (Tier 1 is a strictly better experience than Tier 3), which gives you a clean, honest incentive to drive signup — without needing to hold their money to do it.

---

## 4. B2B billing

### 4.1 VAT (PPN) — get the arithmetic right

⚠️ **This is widely misreported. The headline rate and the effective rate differ.**

- **Headline rate: 12%**, effective 1 January 2025 under **PP No. 1/2025**.
- **For non-luxury goods and services — which includes EV charging — the tax base (DPP) is "nilai lain" of 11/12 of the selling price**, per **PMK No. 131/2024**. This makes the **effective rate 11%** ([MUC Consulting](https://muc.co.id/en/article/effective-now-12-vat-for-luxury-goods-11-for-non-luxury-goods)).
- Worked example: selling price Rp12,000,000 → DPP = 12,000,000 × 11/12 = Rp11,000,000 → VAT = 11,000,000 × 12% = **Rp1,320,000** = 11% effective.
- The 12% full rate applies to luxury goods subject to PPnBM, [confirmed to continue in 2026](https://mitraconsulting.co.id/tarif-ppn-12-tetap-berlaku-untuk-barang-mewah-pada-2026/).

⚠️ Note that some tax-guide sites (including [one 2026 guide](https://tax.atmo.co.id/en/guide/vat-12-percent-guide-2026)) present a flat 12% calculation and omit the 11/12 mechanism. **Have your tax advisor confirm the DPP treatment for electricity supply specifically** — electricity has its own VAT history in Indonesia and may carry exemptions or special treatment at certain tariff levels that I did not research.

**Architecture implication:** do not hardcode a rate. Store DPP basis and rate as configurable, versioned, effective-dated fields. Indonesian VAT has changed twice in three years.

### 4.2 e-Faktur and Coretax

Since January 2025, **Coretax DJP** has replaced the old e-Faktur desktop workflow. Integration ([saka-erp](https://www.saka-erp.id/artikel/cara-integrasi-erp-dengan-coretax)):

- **REST API with OAuth2 authentication.**
- Requires a **digital certificate** (BSSN or DJP), Client ID/Secret from DJP portal registration, **IP whitelisting**, and retry handling.
- ⚠️ **Critical sequencing constraint:** *"Faktur tidak boleh diterbitkan ke pelanggan sebelum NSFP diterima dari Coretax"* — **you may not issue a tax invoice to the customer until the serial number (NSFP) is returned by Coretax.** Your invoicing pipeline must treat Coretax as a synchronous dependency with a pending state, not a fire-and-forget async job. This is a common and expensive design error.
- Recommended rollout: master data validation (NPWP, PKP status, product codes) → JSON format compliance → sandbox → **2–4 week parallel run** comparing outputs before cutover.

**PJAP route.** Rather than integrating Coretax directly, use a **Penyedia Jasa Aplikasi Perpajakan** — an officially appointed DJP application partner. Established providers: [Mekari Klikpajak](https://klikpajak.id/), [OnlinePajak](https://www.online-pajak.com/tentang-efaktur-ppn/penyedia-jasa-aplikasi-perpajakan/), [Pajakku](https://pajakku.com/). These expose cleaner APIs and absorb DJP-side changes.

**Recommendation: use a PJAP.** Direct Coretax integration is not where a CPO platform should spend engineering capacity, and DJP interfaces change with little notice.

### 4.3 Payment gateways do not do tax invoices

⚠️ **Important scoping point:** no Indonesian payment gateway issues e-Faktur. Midtrans, Xendit, DOKU and Faspay handle money movement only. **Tax invoicing is an entirely separate integration.** Do not let a "the gateway handles billing" assumption into the architecture doc — invoicing, VAT and e-Faktur are your build.

### 4.4 Automated bank transfer reconciliation

Bank transfer and VA are ~25% of Indonesian payment volume, and B2B skews far higher — Xendit cites **60–80% of transactions via bank transfer**. The structural problem: **Indonesian banks do not reliably expose sender identity**, making manual reconciliation the default and a real operational cost.

**Solution: per-customer fixed virtual accounts.**

- Assign each fleet customer a **fixed VA** (persistent, tied to the customer, accepts repeated payments).
- Choose **open amount** (accepts any amount above a minimum) for account-level top-ups against a running balance, or **closed amount** (exact only, auto-confirms) for per-invoice matching.
- Payment arrives → VA identifies the payer unambiguously → auto-match to invoice → webhook → ledger update. No human in the loop.

Both Xendit and Midtrans support VA across BCA, BNI, BRI, Mandiri, Permata and others. Midtrans's Rp4,000 flat is markedly cheaper than Xendit's Rp13,000 list — **on VA-heavy B2B volume this is the strongest argument for keeping Midtrans in the stack**, or for negotiating Xendit's VA pricing down specifically.

Note also **BI-FAST** as the underlying real-time rail: fee capped at **Rp2,500 per transaction**, 1.4 billion transactions in Q1 2026. Relevant for outbound payouts to site hosts.

---

## 5. Local UX rails

### 5.1 WhatsApp Business API

⚠️ **The pricing model changed and most third-party sources are wrong.** Meta **deprecated conversation-based pricing and moved to per-message pricing effective 1 July 2025** ([Meta developer docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), and Meta's own [conversation-based pricing page now marked "Deprecated"](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing)). Sources still describing 24-hour conversation windows — including [one 2026 Indonesia pricing guide](https://cekat.ai/en/blog/harga-whatsapp-api-indonesia-2026) — are describing the retired model.

Current model:

| Category | Charging |
|---|---|
| **Marketing** | Always charged |
| **Utility** | **Free within an open customer service window**; charged outside it |
| **Authentication** | Charged |
| **Service** | **Free for all businesses** since November 2024 |
| Non-template messages in an open service window | Free |
| Free Entry Point (ad-click triggered) | All messages free for 72 hours |

⚠️ **Indonesia per-message rates: uncertain.** Meta's public docs place Indonesia (+62) under "Rest of Asia Pacific" but publish rates only via interactive rate cards. Third-party figures circulating for Indonesia — roughly **marketing $0.0492, utility $0.0212, authentication $0.0190** — derive from the *retired conversation model* and should be treated as indicative order-of-magnitude only. **Get current rates from Meta's rate card or your BSP.**

**The design insight that actually matters:** utility templates are **free inside an open customer service window**. An EV charging session inherently opens one — the driver initiates contact by starting a session. Structure your notifications ("charging started", "80% complete", "session ended, Rp87,400 charged") as **utility templates sent inside that window** and your per-session messaging cost approaches **zero**. This is a significant and easily-missed saving; design the messaging flow around the window deliberately rather than blasting marketing-category templates.

**Provider options:**
- **Meta Cloud API** — direct, no BSP per-message markup, most engineering effort. Best economics at scale.
- **Qontak (Mekari)** — Indonesian, local support and billing, integrates with the Mekari suite (relevant given Klikpajak for §4.2).
- **Twilio / Vonage** — excellent docs and reliability, USD billing, markup over Meta rates.
- Local alternatives: Qiscus, Cekat.

**Recommendation:** start on a BSP (Qontak for local support and IDR billing, or Twilio for developer experience), migrate to Cloud API direct when volume justifies removing the markup.

### 5.2 SMS OTP

- **~$0.054 / ~Rp690 per SMS** in Indonesia ([MessageCentral Indonesia pricing](https://www.messagecentral.com/product/verify-now/pricing/pricing-indonesia)), pay-as-you-go, charged only on successful delivery. Volume pricing negotiable.
- Local aggregators are meaningfully cheaper at volume than Twilio/Vonage international rates.
- WhatsApp OTP is a common **fallback route** (and often a cheaper primary, given Indonesia's near-universal WhatsApp usage).

**Norms:** phone-number-first authentication is the Indonesian default. Email-primary login is unusual and will cost you conversion. Expect: enter phone number → OTP → done. Passwords are increasingly optional or absent.

**Recommendation:** **WhatsApp OTP primary, SMS fallback.** Cheaper, higher delivery reliability, and matches user habit. Given ~Rp690/SMS, at 100,000 OTPs/month you are looking at ~Rp69M/month on SMS-only versus a fraction of that with WhatsApp-first. Budget for both — SMS fallback is not optional, since WhatsApp delivery can fail.

### 5.3 Native app vs web vs mini-app

**Do not build a native-app-only product.** Walk-up drivers at a charger will not install an app to buy Rp50,000 of electricity. The Tier 3 QRIS flow (§3.4) must work from a **mobile web page reached by scanning a QR on the charger** — no install, no signup.

The layered answer:

- **Mobile web / PWA — mandatory, phase one.** Guest sessions, QRIS payment, session status. Zero friction.
- **Native app — phase two.** Justified for registered drivers by things web cannot do well: background session notifications, saved payment tokens, RFID/NFC pairing, offline station maps.
- **GoPay Mini App — high-leverage, worth serious evaluation.** Via [Midtrans](https://midtrans.com/product/gopay-mini-app): your service embedded in the GoPay app, **users auto-logged-in without re-entering their phone number**, access to GoPay's daily active user base, marketing surface (banners, notifications, promotions), integration "within days", and **no setup fee from GoPay**. For a new CPO with no brand recognition, distribution inside a super-app that already has the user's payment credentials and identity is a materially cheaper acquisition channel than app-store install campaigns. Commercial terms are negotiated directly.

Indonesia is a super-app market — Gojek/GoPay and Grab dominate daily mobile behaviour. Meeting users inside those surfaces beats asking them to come to yours.

---

## 6. Recommendations

### Payment stack
1. **Xendit as primary gateway.** E-wallet tokenization and xenPlatform split payments are the two capabilities this product cannot be built well without, and only Xendit has both.
2. **Midtrans as secondary** for QRIS and VA, where its pricing is markedly better (VA Rp4,000 vs Rp13,000 list), plus GoPay Mini App distribution. Also your negotiating lever on Xendit's list pricing.
3. **Get written quotes from both** against a projected volume profile. Published Xendit rates are list prices, not market prices.
4. **Confirm in writing with your PJP:** the MCC/merchant-category assignment for EV charging (0.4% SPBU vs 0.7% standard), which e-wallets support tokenization, partial-capture availability in Indonesia, and the settlement SLA per channel.

### Payment flows
5. **Tier 1 — e-wallet tokenization** for registered drivers. Link once, charge exact amount post-session. Primary path; design the product to funnel users here.
6. **Tier 2 — card pre-auth/capture** for premium and fleet drivers. Start acquirer approval for One Click/recurring early; it has lead time.
7. **Tier 3 — QRIS pre-purchase tiers** for guests. Fixed amounts, charger delivers exactly that energy. Matches the PLN SPKLU pattern drivers already know. **Price tiers at or below Rp100,000 to land in the 0% MDR band from 1 October 2026.**
8. **Tier 4 — postpaid VA invoicing** for B2B fleet.
9. **Do not build a stored-balance wallet.** Do not build charge-max-then-refund on QRIS.

### Compliance
10. **Engage Indonesian payments counsel before any wallet/balance feature is specified.** The specific question: does a multi-tenant CPO platform holding driver balances spent on electricity supplied by third-party site hosts qualify as closed-loop, or is it open-loop e-money requiring a licence regardless of float? The Rp1bn exemption may not apply at all. Include PADG No. 32/2025 in the brief.
11. **Instrument float from day one** even if you never intend to hold balance — refund-pending and settlement-in-transit balances need monitoring against the Rp1bn line.
12. **Confirm VAT treatment for electricity supply** with a tax advisor; do not assume the general 11% effective rate applies unmodified.

### Build sequence
13. **Phase 1:** mobile web + QRIS dynamic (Tier 3) + VA for B2B. Ships fastest, zero licensing exposure, covers walk-up and fleet.
14. **Phase 2:** driver accounts + e-wallet tokenization (Tier 1) + card pre-auth (Tier 2) + WhatsApp notifications.
15. **Phase 3:** xenPlatform sub-merchant onboarding and automated site-host splits; native app; evaluate GoPay Mini App; consider QRIS Tap if NFC hardware is specced.
16. **Spec NFC readers into the charge-point BOM now** even though the software is phase three — it unlocks both QRIS Tap and RFID, and retrofitting hardware is expensive.

### Non-obvious things worth flagging to the architecture team
17. **Coretax must be synchronous in the invoicing pipeline** — no tax invoice may be issued before the NSFP returns. Design for a pending state.
18. **Structure session notifications as utility templates inside the open customer service window** — drives per-session WhatsApp cost toward zero.
19. **Store VAT rate and DPP basis as configurable, effective-dated values.** Indonesian VAT changed twice in three years.
20. **Webhook signature verification and idempotency are not optional** on any Indonesian payment rail.

---

## Confidence and gaps

**High confidence:** QRIS limit (Rp10M, PADG 3/2025); MDR tables and the 1 Oct 2026 change; the closed-loop Rp1bn exemption and e-money capital tiers; PJP licence categories and capital; Midtrans and Xendit published fees; pre-auth mechanics on both; the 11/12 DPP mechanism; WhatsApp per-message model change.

**Flagged as uncertain — verify before relying on:**
- Settlement timing per channel for both gateways (not publicly documented; contractual).
- Whether EV charging receives SPBU 0.4% MDR treatment in Indonesia.
- Full list of tokenization-supported e-wallets (only OVO documented).
- Xendit partial-capture availability specifically in Indonesia.
- WhatsApp per-message rates for Indonesia (circulating figures derive from the retired model).
- DOKU pre-auth support; DOKU/Faspay/iPaymu pricing (none published).
- iPaymu's BI PJP licence status (site evidences Kominfo PSE registration, which is a different thing).
- VAT treatment specific to electricity supply.
- PADG No. 32/2025 licensing/sanctions changes — surfaced but not researched in depth.

**Sources:**

[Bank Indonesia — QRIS](https://www.bi.go.id/en/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx) · [BI — MDR QRIS categorisation](https://www.bi.go.id/id/publikasi/ruang-media/cerita-bi/Pages/mdr-qris.aspx) · [BI — PBI 23/6/PBI/2021 (EN)](https://www.bi.go.id/en/publikasi/peraturan/Documents/PBI_230621_EN.pdf) · [BI — PBI 20/6/PBI/2018](https://www.bi.go.id/id/publikasi/peraturan/Pages/PBI-200618.aspx) · [ANTARA — 0% MDR expansion](https://www.antaranews.com/berita/5697901/bi-perluas-kebijakan-mdr-qris-0-persen-untuk-pelaku-umkm) · [LBS — MDR 0% Oct 2026](https://www.lbs.id/publication/berita/kebijakan-mdr-qris-gratis-0-mulai-oktober-2026) · [ezeelink — QRIS limits](https://ezeelink.co.id/blog/limit-qris/) · [ezeelink — MDR QRIS](https://ezeelink.co.id/blog/mdr-qris/) · [ezeelink — QRIS Tap](https://ezeelink.co.id/blog/qris-tap-definisi-cara-kerja/) · [ezeelink — QRIS cross-border 2026](https://ezeelink.co.id/blog/qris-cross-border-2026/) · [ezeelink — QRIS API integration](https://ezeelink.co.id/blog/integrasi-api-qris/) · [Midtrans Pricing](https://midtrans.com/pricing) · [Midtrans — Pre-Authorization](https://docs.midtrans.com/reference/card-feature-pre-authorization) · [Midtrans — One Click/Two Clicks/Recurring](https://docs.midtrans.com/docs/one-click-two-clicks-and-recurring-transaction) · [Midtrans — Create Subscription](https://docs.midtrans.com/reference/create-subscription) · [Midtrans — Disbursement (Iris)](https://docs.midtrans.com/docs/disbursement-overview) · [Midtrans — QRIS](https://docs.midtrans.com/reference/qris) · [Midtrans — Withdrawals](https://docs.midtrans.com/docs/when-can-i-withdraw-my-transaction-funds-from-midtrans) · [Midtrans — GoPay Mini App](https://midtrans.com/product/gopay-mini-app) · [Xendit Pricing](https://www.xendit.co/en-id/pricing/) · [Xendit — Authorize & capture](https://docs.xendit.co/docs/cards-capturing-a-card-payment) · [Xendit — Split payments](https://docs.xendit.co/docs/split-payments) · [Xendit — xenPlatform](https://www.xendit.co/en/products/xenplatform/) · [Xendit — eWallet tokenization](https://help.xendit.co/hc/en-us/articles/13322736469529-How-to-create-eWallet-Tokenization) · [Xendit — Virtual accounts](https://www.xendit.co/en-id/blog/what-is-a-virtual-account-and-how-does-it-work/) · [DOKU — QRIS](https://docs.doku.com/accept-payments/no-integration-products/qris) · [Faspay](https://faspay.co.id/en/) · [iPaymu](https://ipaymu.com/en/) · [BRIAPI — QRIS MPM Dynamic](https://developers.bri.co.id/en/docs/qris-merchant-presented-mode-mpm-dynamic) · [SSEK — E-money limits](https://ssek.com/blog/bank-indonesia-sets-new-limits-for-the-provision-of-e-money/) · [ABNR — Updated e-money regulation](https://www.abnrlaw.com/news/details-on-the-updated-e-money-regulation) · [Conventus Law — E-money detail](https://conventuslaw.com/report/indonesia-details-on-the-updated-e-money/) · [Mondaq — BI payment system FAQ](https://www.mondaq.com/financial-services/1098148/indonesia-payment-system-regulation-faq-on-the-new-bank-indonesia-payment-system-legal-frameworks) · [Hukumonline RCS — E-wallet licensing](https://rcs.hukumonline.com/insights/izin-ewallet-bank-indonesia) · [Fastpay — E-money balance limits](https://www.fastpay.co.id/blog/limit-saldo-e-money-naik-jadi-rp20-juta-mulai-juli-2022.html) · [MUC — 12% luxury / 11% non-luxury VAT](https://muc.co.id/en/article/effective-now-12-vat-for-luxury-goods-11-for-non-luxury-goods) · [Mitra Consulting — 12% VAT in 2026](https://mitraconsulting.co.id/tarif-ppn-12-tetap-berlaku-untuk-barang-mewah-pada-2026/) · [Saka ERP — Coretax integration](https://www.saka-erp.id/artikel/cara-integrasi-erp-dengan-coretax) · [OnlinePajak — PJAP services](https://www.online-pajak.com/tentang-efaktur-ppn/penyedia-jasa-aplikasi-perpajakan/) · [Mekari Klikpajak](https://klikpajak.id/) · [Meta — WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [Meta — Conversation-based pricing (deprecated)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing) · [MessageCentral — Indonesia OTP pricing](https://www.messagecentral.com/product/verify-now/pricing/pricing-indonesia) · [ChargePoint — Pre-auth hold](https://www.chargepoint.com/drivers/support/faqs/how-much-pre-authorization-hold-amount-sessions-started-without-chargepoint) · [EVgo — Pre-authorization holds](https://helpcenter.evgo.com/hc/en-us/articles/20444993723543-Pre-Authorization-Holds) · [EVCS — Hold amounts](https://support.evcs.com/hc/en-us/articles/22972419096468-Why-is-there-a-30-or-50-hold-on-my-credit-card) · [Visa — MCC 5552 FAQ](https://usa.visa.com/content/dam/VCOM/global/support-legal/documents/faqs-about-using-mcc-5552.pdf) · [PXP — MCC 5552](https://www.pxp.io/mcc-codes/5552-electric-vehicle-charging) · [PaymentBrief — Indonesia](https://paymentbrief.com/markets/indonesia/) · [Ipsos — Digital wallet landscape 2026](https://www.ipsos.com/en-id/mapping-digital-wallet-landscape-2026-which-platform-leads-users-preferred-choice-according-ipsos)

agentId: a0bf09f65ba099e3b (use SendMessage with to: 'a0bf09f65ba099e3b', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 138719
tool_uses: 101
duration_ms: 1142802</usage>