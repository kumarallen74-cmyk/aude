I have gathered comprehensive material across all eight areas. Here is the report.

---

# Indonesia EV Charging (SPKLU/SPBKLU): Regulatory, Grid & Market Landscape
**Research brief for PlugSure — charge point management platform**
*Compiled August 2026. Figures in IDR unless noted. Confidence flags included throughout.*

---

## 0. Executive summary — what matters most for the product

Six findings that should directly shape the PRD:

1. **The tariff engine is formula-driven, not table-driven.** PLN's SPKLU-relevant tariffs are defined in Permen ESDM 7/2024 as *multiplier formulas*: bulk/curah = `Q × 707` (0.8 ≤ Q ≤ 3) and special-service = `N × 1,650` (1.0 ≤ N ≤ 1.5). A hard-coded rate table will break. Model the multiplier.
2. **PLN already charges a 2% platform fee** in its partnership schemes — that is PlugSure's direct price anchor and its most important competitive datapoint (§3.5).
3. **Legal-for-trade metrology became real in May 2026.** Kemendag launched type-approval + tera/tera-ulang for EV chargers on 25 May 2026, targeting all operational SPKLU within one year. This creates a hard product requirement around meter identity, accuracy class, and seal/calibration expiry tracking (§2).
4. **Billing must be layered, not flat.** A single session bill can carry: energy (kWh) + regulated session fee + admin fee + PBJT regional tax (up to 10%, varies by kabupaten/kota) + PPN. At least one live operator (Casion) bills per-minute. The pricing model needs to be composable (§2.3, §3.6).
5. **Time-of-use is codified but currently flat in practice** — WBP/LWBP blocks exist in the tariff structure, and PLN runs a 30% night discount (22:00–05:00) on home charging. Peak-shaving value is real but presently sits mostly in the `rekening minimum` (40 × kVA) and demand-side, not in energy-price arbitrage (§3.3, §3.7).
6. **TKDN now formally covers software** (Permenperin 35/2025) — this is newly winnable and matters enormously for selling to PLN and SOEs (§5).

---

## 1. Regulatory framework

### 1.1 The presidential layer

**Perpres 55/2019** (Percepatan Program Kendaraan Bermotor Listrik Berbasis Baterai untuk Transportasi Jalan) remains the umbrella instrument, **amended by Perpres 79/2023** (signed December 2023).

Charging-relevant articles of the amended Perpres ([full text, JDIH Kemenkeu](https://jdih.kemenkeu.go.id/api/download/2426f667-7c15-4afb-8a52-4efc01da5e9b/2023perpres079.pdf)):

| Article | Content |
|---|---|
| **Pasal 22(1)** | Defines charging infrastructure as recharging facilities incl. electrical equipment, control systems, safety mechanisms, plus battery-exchange facilities |
| **Pasal 22(2)** | Three deployment contexts: private installations, **SPKLU** (public charging), **SPBKLU** (public battery swap) |
| **Pasal 26(3)** | Mandates SPKLU/SPBKLU deployment at fuel stations (SPBU), gas stations, **government offices, shopping centres, and roadside parking** |
| **Pasal 17(3)** | Incentive-eligible parties explicitly include **charging infrastructure providers** and battery-rental companies |
| **Pasal 19(1)** | Fiscal incentives: import duty reduction, PPnBM exemption, tax breaks, **charging-equipment support**, professional certification funding |
| **Pasal 8** | TKDN schedule for vehicles (see §5) — Perpres 79/2023 *delayed* these targets |

The main substantive change in Perpres 79/2023 was pushing back vehicle TKDN targets (4W: 40% held through 2026, 60% 2027–29, 80% from 2030) and broadening investor incentives ([Bloomberg Technoz](https://www.bloombergtechnoz.com/detail-news/23685/poin-poin-krusial-perpres-79-2023-soal-insentif-kendaraan-listrik), [CNN Indonesia](https://www.cnnindonesia.com/otomotif/20231213110705-603-1036637/jokowi-terbitkan-revisi-perpres-kendaraan-listrik-berikut-isinya)).

### 1.2 The ministerial layer — Permen ESDM 1/2023

**Permen ESDM No. 1 Tahun 2023** on *Penyediaan Infrastruktur Pengisian Listrik untuk Kendaraan Bermotor Listrik Berbasis Baterai* is the operative charging-infrastructure regulation ([BPK peraturan.bpk.go.id](https://peraturan.bpk.go.id/Details/252409/permen-esdm-no-1-tahun-2023) — note: this site 403s to automated fetch; [JDIH Kemenko Infrastruktur summary](https://jdih.kemenkoinfra.go.id/permen-esdm-12023-penyediaan-infrastruktur-pengisian-listrik-kendaraan-listrik-berbasis-baterai) is accessible).

It replaced the earlier Permen ESDM 13/2020 regime. Key content:

**Charging classifications** (drive the fee ceilings and, in practice, hardware categorisation in software) — per [Indonesia Baik / ESDM infographic](https://indonesiabaik.id/infografis/tarif-ngecas-cepat-kendaraan-listrik):

| Class | Output power |
|---|---|
| Slow charging | ≤ 7 kW |
| Medium charging | > 7 kW – 22 kW |
| Fast charging | > 22 kW – 50 kW |
| Ultrafast charging | > 50 kW |

**Pasal 8(2)** requires operators to obtain a **Nomor Identitas SPKLU** (SPKLU identity number) by submitting facility specifications and location data to ESDM ([Prolegal](https://prolegal.id/jenis-jenis-izin-usaha-stasiun-pengisian-kendaraan-listrik-umum-spklu/)).

> ⚠️ **Uncertainty flag:** I could not confirm whether Permen ESDM 1/2023 has been formally amended or replaced between 2024 and August 2026. Searches surfaced no successor Permen. However, PP 28/2025 (below) materially changed the *licensing* mechanics that sit underneath it, and Permen ESDM 7/2024 superseded the tariff provisions. **Recommend a JDIH ESDM check before the PRD is frozen** — the ESDM JDIH portal and gatrik.esdm.go.id are JavaScript-rendered and resisted automated retrieval throughout this research.

### 1.3 Licensing — what you actually need to operate an SPKLU

Licensing runs on **Permen ESDM 11/2021** (electricity business licensing) as re-plumbed by **PP 5/2021** and now **PP 28/2025** on risk-based business licensing.

The authoritative current breakdown comes from Ditjen Gatrik's own June 2025 licensing deck, *"Perizinan Berusaha SPKLU IUPTL-PWU"* ([PDF, gatrik.esdm.go.id](https://gatrik.esdm.go.id/infogatrik/api//storage/2025/konten/pdf/7QYZeAN2hV_02062025021414.pdf)):

**Required credentials for a provider/retailer selling electricity to the public:**

1. **NIB** (Nomor Induk Berusaha) — via OSS
2. **Penetapan Wilayah Usaha (WILUS)** — business-area designation. Requires SPKLU locations spanning **at least 2 provinces** for the cross-province IUPTL-PWU route
3. **Pengesahan RUPTL** — electricity supply business plan, endorsed by the Minister
4. **IUPTLU** (Izin Usaha Penyediaan Tenaga Listrik untuk Umum) — the general public-supply licence
5. **Nomor Identitas SPKLU** — issued within **5 working days** of documentation completeness
6. **SLO** (Sertifikat Laik Operasi) — must precede commercial operation

**KBLI code:** 35114 (Penjualan Tenaga Listrik), classified **high risk** ([Prolegal](https://prolegal.id/jenis-jenis-izin-usaha-stasiun-pengisian-kendaraan-listrik-umum-spklu/)).

**Important carve-out:** entities that merely *lease equipment* or *perform maintenance* in partnership with a licensed provider/retailer explicitly **do not need** WILUS, RUPTL, IUPTLU, or an SPKLU identity number. Verbatim from the Gatrik deck: *"tidak memerlukan WILUS, RUPTL, IUPTLU dan Nomor Identitas SPKLU."*

> 💡 **Product implication:** This carve-out is the legal basis on which PlugSure can serve site hosts and equipment owners as a pure software/service vendor without itself becoming a licensed electricity seller. It also means a large share of your addressable market are parties operating *under* someone else's licence — the platform's tenancy model should support a licence-holder umbrella with many sub-operators beneath it.

**IUPTLS** (Izin Usaha Penyediaan Tenaga Listrik untuk **Kepentingan Sendiri** — self-consumption) is the *different* instrument covering own-use generation, e.g. a building with captive generation or solar. It is not the SPKLU public-sale licence. A private workplace/fleet charger that does not resell electricity generally falls outside IUPTLU entirely ([Ditjen Gatrik IUPTLS FAQ](https://gatrik.esdm.go.id/assets/uploads/download_index/files/0d0f0-faq-izin-usaha-penyediaan-tenaga-listrik-untuk-kepentingan-sendiri-iuptls-.pdf); [HSE.co.id glossary](https://hse.co.id/kamus/iuptls-izin-usaha-penyediaan-tenaga-listrik-kepentingan-sendiri)).

### 1.4 Recognised business models — the POSO/ROSO scheme taxonomy

This is the single most product-relevant piece of the licensing framework, and it is not widely documented in English. Ditjen Gatrik formally recognises **nine operating schemes**, split into Provider and Retailer families:

**Provider schemes** (party holds the electricity relationship):
| Code | Meaning |
|---|---|
| **POSO** | Provider, Owner, Self-Operated |
| **POPO** | Provider, Owner, Privately Operated |
| **PLPO** | Provider, Lease, Privately Operated |
| **PLSO** | Provider, Lease, Self-Operated |

**Retailer schemes** (party buys electricity from a TWU-LP / TWU-NLP holder and resells):
`ROSO`, `ROPO`, `RLPO`, `RLSO`, `RPOO`

The scheme code is embedded in the SPKLU identity number itself. Format example from the Gatrik deck: **`01.POSO.20.3275.010`** — decoding as business-entity code, operating scheme, location sequence, and municipality code (3275 = Kota Bekasi).

> 💡 **Product implication — high priority.** The SPKLU ID is a structured, government-issued identifier that encodes the legal operating model of each site. PlugSure should treat it as a **first-class field on the charge-point/site entity**, parse its components, and validate its format. Reporting, compliance, and any future Single Gateway integration will key off it. The scheme code also tells you who owns the asset vs. who operates it vs. who holds the licence — exactly the three-way split your permissions model needs.

### 1.5 PP 28/2025 and the Single Gateway

**PP 28/2025** on *Penyelenggaraan Perizinan Berusaha Berbasis Risiko* (risk-based business licensing) re-ordered licensing across sectors including electricity. Ditjen Gatrik responded by simplifying SPKLU permitting and strengthening data collection **via the Aplikasi Single Gateway** ([Ditjen Gatrik news](https://gatrik.esdm.go.id/berita/?slug=pasca-pp-28-2025-pemerintah-sederhanakan-izin-spklu-dan-perkuat-sistem-data-ketenagalistrikan&category=ketenagalistrikan)).

The **Single Gateway** is a national charging-station data and search platform built by ESDM with the **ENTREV** programme (the UNDP/GEF-backed Accelerating Clean Energy Transition through Electric Vehicles project). Originally targeted for completion end-2023/2024 ([Bloomberg Technoz](https://www.bloombergtechnoz.com/detail-news/11380/single-gateway-aplikasi-pencarian-spklu-diluncurkan-akhir-tahun)), it was still being socialised and trialled with badan usaha through 2025 — Ditjen Gatrik ran *bimtek* (technical guidance) sessions with businesses on a charging-station data application.

> ⚠️ **Uncertainty flag — and a research gap worth closing directly.** I could not retrieve the technical specification for Single Gateway: whether integration is *mandatory* for private CPOs, whether it is API-based or manual upload, what schema it expects, or its current operational status. The Ditjen Gatrik pages that describe it are JS-rendered and blocked automated access. **This is the highest-value open question in the regulatory section** — if Single Gateway integration becomes mandatory, it is a compliance feature PlugSure must ship, and being early is a differentiator. Recommend contacting Direktorat Pembinaan Pengusahaan Ketenagalistrikan directly, or attending a bimtek session.

### 1.6 Reporting and integration with PLN

There is **no general legal requirement** that a private CPO integrate with PLN Mobile. However:

- Under PLN's **partnership schemes**, PLN provides the app/payment layer and takes a **2% revenue share** for it (§3.5) — so partnership-scheme sites are on PLN Mobile by commercial construction, not by law.
- PLN Mobile hosts an "Electric Vehicle Digital Services" platform with trip planning by distance and charger location, plus queue management ([Ecobiz Asia](https://ecobiz.asia/spklu-pln-melonjak-44-persen-sepanjang-2025-layanan-home-charging-naik-dua-kali-lipat/)).
- Independent CPOs (Starvo, Voltron, Shell Recharge, Casion) run **their own apps and their own payment rails** ([Gardu Oto, Aug 2026](https://www.garduoto.com/142917/peta-tarif-fast-charging-non-pln-di-indonesia-mana-paling-praktis)) — confirming that operating outside PLN Mobile is both legal and normal practice.

**Roaming/interoperability:** there is no Indonesian regulatory mandate for OCPI or eRoaming. Utomo Charge+ and PLN have announced work on *"integrasi jaringan akses mobilitas"* across Southeast Asia ([Kontan press release](https://pressrelease.kontan.co.id/news/utomo-chargeplus-pln-kembangkan-integrasi-jaringan-akses-mobilitas-di-asia-tenggara)), which suggests roaming is emerging commercially rather than by regulation.

### 1.7 Safety certification — SLO

**SLO (Sertifikat Laik Operasi)** is mandatory before an SPKLU may operate and before the SPKLU identity number is issued. It is issued by a **LIT (Lembaga Inspeksi Teknik)** — accredited technical inspection bodies such as Sucofindo ([Sucofindo SLO service](https://www.sucofindo.co.id/en/layanan-jasa/sertifikasi-laik-operasi-slo/)). Operating without SLO carries sanctions under the electricity law regime ([Prolegal on SLO](https://prolegal.id/sertifikat-laik-operasi-slo-adalah-definisi-manfaat-dan-sanksinya/)).

> ⚠️ I could not confirm the **validity period** of SLO for SPKLU installations specifically (for general installations it is commonly cited as 5–15 years depending on installation class). Treat SLO expiry as a tracked field with a configurable period.

> 💡 **Product implication:** SLO certificate number, issuing LIT, issue date and expiry belong on the site record, alongside the SPKLU ID and the meter tera certificate (§2). A "compliance document vault + expiry alerting" module is a genuine, defensible feature for the Indonesian market — three separate certificate regimes with three different expiries per site.

---

## 2. Metering & legal-for-trade

### 2.1 The May 2026 regime change — the most important recent development

On **25 May 2026**, the Ministry of Trade (Kemendag) formally launched **type approval (persetujuan tipe), tera, and tera ulang services for EV charger measuring instruments** ([Kemendag press release](https://www.kemendag.go.id/berita/siaran-pers/kemendag-luncurkan-layanan-persetujuan-tipe-tera-dan-tera-ulang-alat-ukur-pengisi-daya-kendaraan-listrik); [Koran Jakarta](https://koran-jakarta.com/2026-05-25/pastikan-pengisian-daya-listrik-akurat-dan-adil-kemendag-resmikan-layanan-tera-spklu)). Trade Minister Budi Santoso launched it by affixing certification stickers to EVSE units.

**Legal basis:**
- **Permendag No. 24 Tahun 2024** — procedures for type approval, tera and tera ulang of measuring instruments (UTTP) ([JDIH Kemendag](https://jdih.kemendag.go.id/peraturan/peraturan-menteri-perdagangan-nomor-24-tahun-2024-tentang-kegiatan-tera-dan-tera-ulang-alat-ukur-alat-timbang-dan-alat-perlengkapan-metrologi-legal-1); [BPK](https://peraturan.bpk.go.id/Details/305838/permendag-no-24-tahun-2024))
- **Permendag No. 33 Tahun 2025** — standards for business activities and products/services under risk-based licensing in trade and legal metrology
- Underlying: UU No. 2/1981 on Metrologi Legal

**Core rule: EVSE is classified as UTTP** (Ukur, Takar, Timbang dan Perlengkapannya) — a measuring instrument subject to mandatory verification, exactly like fuel dispensers at SPBU. Director of Metrology Sri Astuti: *"Alat ukur di SPKLU ini sudah wajib tera"* ([Antara](https://www.antaranews.com/berita/4105503/pemerintah-sebut-alat-ukur-di-spklu-wajib-ditera)).

**Accuracy classes and maximum permissible error (BKD — Batas Kesalahan yang Diizinkan):**

| Accuracy class | Permitted error |
|---|---|
| Class 0.5 | ± 0.5% |
| Class 1 | ± 1% |
| Class 2.5 | ± 2.5% |

Error is determined by comparing a reference standard against the EVSE's actual measured delivery.

**Scope and timeline:** the government targets **phased testing of all operational SPKLU within one year** of the May 2026 launch (i.e. by ~May 2027). At launch this covered **4,769 EVSE units across 3,097 public charging locations** per PLN data. Enforcement in DKI Jakarta is carried out by **UPT Metrologi DKI**.

> ⚠️ **Uncertainty flags:** (a) the **tera ulang interval** for EVSE is not stated in the sources I could reach — for most UTTP categories in Indonesia it is annual, but this must be confirmed with Direktorat Metrologi; (b) **penalties** for operating an unverified charger are not specified in the launch materials, though UU 2/1981 provides criminal sanctions for using unverified UTTP in trade.

> 💡 **Product implications — these are concrete PRD requirements:**
> - Store per-connector: **meter serial number, accuracy class, type-approval (persetujuan tipe) number, last tera date, next tera-ulang due date, seal status**.
> - Alerting on approaching tera expiry, and the ability to **block a connector from commercial sessions** when its verification lapses.
> - Session records must be **tamper-evident and reconcilable to the legally verified meter register**, not merely to an OCPP `MeterValues` stream. Where the CPMS and the legal meter can diverge, the legal meter must win for billing.
> - Export format for metrology inspections.
> - This is a genuine moat: an international CPMS will not have Indonesian tera-ulang lifecycle tracking.

### 2.2 Is kWh-based billing to the public legal?

**Yes — and it is now the clearly-preferred basis.** kWh billing is the assumed model throughout Permen ESDM 1/2023 and Permen ESDM 7/2024, and the May 2026 metrology regime exists precisely to make kWh sale legally defensible. The Trade Minister framed it as ensuring *"konsumen harus dapat sesuai yang dibayarkan"* — consumers must receive what they paid for ([Viva](https://www.viva.co.id/bisnis/1901070-kemendag-mulai-uji-tera-spklu-mendag-budi-tegaskan-konsumen-harus-dapat-sesuai-yang-dibayarkan)).

The condition attached: the meter must be type-approved and tera-verified.

### 2.3 Time-based and session-based billing

**Session-based fees are explicitly regulated and legal.** Kepmen ESDM 182.K/TL.04/MEM.S/2023 sets *biaya layanan* ceilings **per charging session** (§3.4).

**Time-based (per-minute) billing is in active commercial use** — **Casion** bills at **Rp 1,000/minute** ([Otodriver price list](https://otodriver.com/daftar-harga/2025/daftar-harga-pengisian-daya-spklu-pln-dan-swasta-dafebjdfsta)).

> ⚠️ **Uncertainty flag:** I found **no explicit regulatory authorisation for, nor prohibition of, per-minute energy pricing**. Casion's practice suggests tolerance in the market, but the direction of travel — EVSE classified as UTTP, mandatory tera, "consumers must receive what they paid for" — points toward regulators favouring metered kWh as the basis of trade. Per-minute pricing may attract scrutiny as the metrology regime matures, since a per-minute charge is not a measurement of the commodity delivered.
>
> **Recommendation:** build per-minute and per-session as supported pricing components, but **default new tenants to kWh-based** and treat time-based as an idle/occupancy fee rather than the primary energy charge. That is both the safest legal posture and the international norm.

### 2.4 MID/OIML equivalents

Indonesia does not implement the EU Measuring Instruments Directive. The functional equivalent is the **UU 2/1981 Metrologi Legal → Permendag 24/2024** type-approval-plus-verification chain described above, administered by **Direktorat Metrologi** under Kemendag, with execution devolved to provincial/municipal **UPT Metrologi** units.

Indonesia is an OIML member and its UTTP framework is OIML-derived in structure (type approval → initial verification → periodic re-verification), so **an EVSE meter carrying an OIML R46 / MID Annex MI-003 certificate is a strong starting point** for Indonesian type approval — but it does not substitute for it. Local persetujuan tipe is still required.

### 2.5 SNI standards for charging equipment

- **38 SNI standards** have been established across the EV ecosystem, with 9 battery-related SNI in development as of the reporting ([BSN](https://www.bsn.go.id/main/berita/detail/17758/ribuan-spklu-standar-sni-beredar-di-indonesia)).
- **SNI IEC 61851-21-1:2017** is a confirmed adopted standard ([BSN PESTA catalogue](https://pesta.bsn.go.id/produk/detail/12787-sniiec61851-21-12017)). The SNI series adopts IEC 61851 (charging system) and IEC 62196 (connectors).
- **PT PLN operates an accredited test laboratory** capable of SNI SPKLU testing — protection index (IP rating), material composition, corrosion resistance ([BSN](https://bsn.go.id/main/berita/detail/12518/-pln-kini-bisa-terbitkan-sertifikasi-sni-untuk-spklu)).
- Roughly **2,100 SNI-certified SPKLU** were reported in circulation — but this figure dates to **2023** and is now badly stale against a ~5,000-unit fleet.

**Connectors in practice:** AC uses **Type 2 (IEC 62196)**; DC uses **CCS2**, with **GB/T** present on Chinese-brand vehicles and some networks ([Pingalax](https://pingalax.id/spklu-technical-standards/); [Gardu Oto](https://www.garduoto.com/142917/peta-tarif-fast-charging-non-pln-di-indonesia-mana-paling-praktis)). CHAdeMO is legacy/marginal.

> ⚠️ **Uncertainty flag:** whether SNI certification is **wajib (mandatory)** or voluntary for EVSE is genuinely unclear from available sources. BSN has expanded mandatory SNI to various electrical products, but I found no explicit *pemberlakuan wajib SNI* instrument naming EVSE. Confirm with BSN/Kemenperin.

**Protocol:** **OCPP is not legally mandated** in Indonesia. It is, however, the de facto expectation — regional 2026 baseline is **OCPP 1.6J minimum, OCPP 2.0.1 preferred** ([Joint Charging SEA analysis](https://jointcharging.com/sea-ev-charging-market-2026-analysis/)). One Indonesian academic implementation study targets OCPP 1.6 ([JTIIK, Universitas Brawijaya](https://jtiik.ub.ac.id/index.php/jtiik/article/view/6647)).

---

## 3. PLN tariffs and the SPKLU business case

### 3.1 The governing instrument

**Permen ESDM No. 7 Tahun 2024** on *Tarif Tenaga Listrik yang Disediakan oleh PT PLN (Persero)* is the current tariff regulation ([official PDF, JDIH ESDM](https://jdih.esdm.go.id/common/dokumen-external/Permen%20ESDM%20Nomor%207%20Tahun%202024.pdf); [BPK](https://peraturan.bpk.go.id/Details/294347/permen-esdm-no-7-tahun-2024)). It replaced the prior tariff regime and, critically, **created dedicated SPKLU/SPBKLU tariff categories**.

### 3.2 The two tariff routes for a charging operator

**Pasal 3(g) — Curah (bulk) tariff: `C/TR`, `C/TM`, `C/TT`.** Explicitly available to:
- *badan usaha SPKLU* for four-wheel-or-more vehicles
- *badan usaha SPKLU* for two-/three-wheel vehicles
- *badan usaha SPBKLU* (battery swap)

**Pasal 3(h) — Layanan Khusus (special services) tariff: `L/TR`, `L/TM`, `L/TT`.** Covers *"pengisian listrik kepada pemilik kendaraan bermotor listrik berbasis baterai."*

### 3.3 The formulas — this is what the software must model

**Lampiran VII — Curah (C):**
```
Blok WBP dan LWBP  =  Q × 707   (Rp/kWh)
where  0.8 ≤ Q ≤ 3    (Q set by PLN Direksi)

Rekening Minimum (RM) = 40 × Connected Capacity (kVA) × Cost per Usage Block
```

**Lampiran VIII — Layanan Khusus (L):**
```
Blok WBP dan LWBP  =  N × 1,650   (Rp/kWh)
where  1 ≤ N ≤ 1.5   (values outside range need Director-General approval)
```

**This is the "K factor" that industry shorthand refers to** — formally it is **Q** for bulk and **N** for special services. The widely-quoted retail SPKLU price of **Rp 2,466–2,475/kWh is simply N = 1.5**: `1,650 × 1.5 = 2,475`.

**Time-of-use:** WBP (Waktu Beban Puncak, peak) and LWBP (Luar Waktu Beban Puncak, off-peak) blocks are structurally present in both C and L schedules — but in the current lampiran **the base rate is the same across both blocks** for these two categories. Time-of-use differentiation is therefore *available in the tariff architecture but not currently priced in* for SPKLU categories.

> 💡 **Product implication:** Build WBP/LWBP as a **first-class dimension** in the tariff engine even though today's SPKLU rates are block-flat. The structure exists in regulation, PLN already applies WBP/LWBP differentials to industrial categories (typically WBP = K × LWBP with K around 1.4–2.0), and a future SPKLU differential is a plausible policy move. Retrofitting time-of-use into a flat-rate engine is expensive; anticipating it is nearly free.

### 3.4 Service fee ceilings (biaya layanan)

**Kepmen ESDM No. 182.K/TL.04/MEM.S/2023** on *Biaya Layanan Pengisian Listrik pada SPKLU*, announced 31 July 2023 (Ref 337.Pers/04/SJI/2023) ([ESDM press release](https://www.esdm.go.id/id/media-center/arsip-berita/percepat-ekosistem-kendaraan-listrik-pemerintah-resmi-terbitkan-tarif-dan-biaya-layanan-pengisian-listrik-pada-spklu); [Antara](https://www.antaranews.com/berita/3659736/kementerian-esdm-tetapkan-biaya-layanan-pengisian-listrik-di-spklu)):

| Charging class | Max service fee **per session**, excl. PPN |
|---|---|
| Slow (≤7 kW) | **Not regulated** |
| Medium (>7–22 kW) | **Not regulated** |
| Fast (>22–50 kW) | **Rp 25,000** |
| Ultrafast (>50 kW) | **Rp 57,000** |

These are **ceilings, not fixed prices** — operators may charge less or nothing. ESDM deliberately regulated only fast/ultrafast, leaving slow and medium to free pricing ([Kompas Otomotif](https://otomotif.kompas.com/read/2023/07/26/183716515/hanya-tarif-fast-charging-dan-ultrafast-charging-yang-diatur-ini-kata-esdm)). With 11% PPN, the ultrafast ceiling reaches ~Rp 63,270.

> ⚠️ **Uncertainty flag:** Kepmen 182.K/2023 is a 2023 instrument. **Kepmen ESDM No. 24.K/TL.01/MEM.L/2025** exists and was socialised by Ditjen Gatrik (referenced in [this socialisation deck](https://gatrik.esdm.go.id/assets/uploads/download_index/files/1e8cd-bahan-ditbinus.pdf), which I could not retrieve — JS-rendered), and appears related to the SPKLU roadmap 2025–2030 and possibly to tariffs. **Verify whether 182.K/2023 remains in force or has been superseded.** As of August 2026 the Rp 25,000/Rp 57,000 ceilings are still being quoted in current market reporting, so they are likely still operative.

### 3.5 PLN's partnership economics — the competitive anchor

PLN offers four partnership schemes. Revenue splits ([Masko Electrical analysis](https://www.maskoelectrical.com/post/cara-menjalin-kerja-sama-dengan-pln-untuk-membangun-spklu-di-lokasi-anda)):

| Scheme | Land owner | Charger provider | **PLN (app/platform)** |
|---|---|---|---|
| 1 — PLN provides charger | 25% | 73% (PLN) | **2%** |
| 2 — Partner provides land + charger | 98% (combined) | — | **2%** |
| 3 — Separate land owner & charger provider | 25% | 73% | **2%** |
| 4 — Partner provides full facility + holds IUPTL | 98% | — | **2%** |

> 💡 **This 2% is the single most important number in this report for pricing strategy.** PLN has established a market reference price for the app/platform layer at 2% of charging revenue. PlugSure's pricing will be read against it. Note also what the 2% *buys*: app presence and integrated payment — not load management, not smart charging, not multi-tenant fleet billing, not tera-ulang compliance tracking. That gap is where value-based pricing above 2% can be justified.

**Partnership investment levels** ([Kumparan](https://kumparan.com/kumparanbisnis/pln-buka-kemitraan-bikin-spklu-modal-rp-400-jutaan-tertarik-20ywqMrdhWU); [spklu.com](https://spklu.com/modal-buka-usaha-spklu/)):
- Fast charging SPKLU: ~**Rp 400 million**
- Ultrafast: **> Rp 400 million**
- PLN partnership packages: **Rp 361 million (indoor) / Rp 389 million (outdoor)**, each with 3 charging nozzles
- SPBKLU (motorcycle battery swap): from **Rp 85.5 million**
- Land requirement: **6 × 7 m** minimum, with zoning documentation and no prior PLN disputes

### 3.6 Operator margin structure

PLN procures/supplies at the curah rate and permits resale up to the L-tariff ceiling:

| Item | Value |
|---|---|
| Curah (bulk) purchase | **~Rp 707–714/kWh** (Q = 1.0–1.01) |
| Retail ceiling | **Rp 2,466–2,475/kWh** (N = 1.5) |
| **Gross spread** | **~Rp 1,366–1,760/kWh** |
| Reported net margin, indoor | **Rp 1,268.33/kWh** |
| Reported net margin, outdoor | **Rp 1,350.07/kWh** |
| Reported return on initial outlay | **15–20%** |

In December 2024 PLN moved partners from a temporary service tariff of **Rp 1,644/kWh** onto the **curah tariff of ~Rp 1,100/kWh**, alongside a **50% discount on connection costs**, explicitly to shorten payback ([Listrik Indonesia](https://listrikindonesia.com/detail/14957/tingkatkan-minat-bangun-spklu-pln-beri-tarif-curah-dan-diskon-penyambungan-50)).

> ⚠️ **Reconciliation note:** sources give curah as Rp 700, Rp 707, Rp 714, and Rp 1,100 at different dates. This is **entirely consistent with the Q-multiplier design** (Q between 0.8 and 3 against a Rp 707 base gives Rp 566–2,121). PLN sets Q by Direksi decision and it evidently varies by scheme, voltage level and period. **Do not hard-code a curah rate.** Model it as `Q × base`, make Q a per-tenant configurable, and make the base itself versioned.

### 3.7 The general PLN tariff table, Q3 2026

Tariffs were **held flat** for Q3 2026 (July–September) — Minister Bahlil: *"Pemerintah memutuskan tarif listrik Triwulan III Tahun 2026 tetap atau tidak naik"* ([CNBC Indonesia](https://www.cnbcindonesia.com/news/20260727084544-4-753968/daftar-resmi-tarif-listrik-pln-per-kwh-berlaku-juli-september-2026)). No tariff adjustment was applied despite macro parameters supporting one.

| Group | Capacity | Rp/kWh |
|---|---|---|
| R-1/TR | 900 VA | 1,352 |
| R-1/TR | 1,300 / 2,200 VA | 1,445 |
| R-2/TR | 3,500–5,500 VA | 1,700 |
| R-3/TR | ≥ 6,600 VA | 1,700 |
| **B-2/TR** | 6,600 VA – 200 kVA | **1,445** |
| **B-3/TM** | > 200 kVA | **1,122** |
| I-3/TM | > 200 kVA | 1,122 |
| I-4/TT | ≥ 30,000 kVA | 997 |
| P-1/TR | 6,600 VA – 200 kVA | 1,700 |
| P-2/TM | > 200 kVA | 1,533 |
| P-3/TR | Street lighting | 1,700 |
| **L/TR, TM, TT** | Special services | **1,645** |

Note the **L tariff of Rp 1,645** against the Permen 7/2024 base of Rp 1,650 — the actual figure is likely Rp 1,644.52, i.e. the base is subject to quarterly tariff adjustment. Another reason to treat the base as a versioned, dated value rather than a constant.

**The 200 kVA boundary between TR and TM is the key threshold** and it drives everything in §4.

### 3.8 The tax and levy stack on a session

A single retail charging session can carry **five separate layers**:

```
1. Energy       kWh × (N × 1,650)          — regulated ceiling
2. Service fee  per session                — Rp 25,000 / Rp 57,000 ceiling
3. Admin fee    operator discretion        — e.g. Voltron Rp 4,000
4. PBJT         up to 10%, set per region  — e.g. Voltron applies 5%
5. PPN          11% effective              — §7
```

**PBJT (Pajak Barang dan Jasa Tertentu) atas Tenaga Listrik** replaced the old PPJ (Pajak Penerangan Jalan) under **UU No. 1/2022 (HKPD)**, Pasal 52 et seq., implemented by **PP 4/2023** ([DDTC](https://news.ddtc.co.id/berita/nasional/44010/begini-ketentuan-tarif-pbjt-atas-konsumsi-tenaga-listrik-di-uu-hkpd)):

| Category | Max rate |
|---|---|
| General consumption | **10%** |
| Industry & oil-gas mining from external supply | **3%** |
| Self-generated electricity | **1.5%** |

Rates are set by **kabupaten/kota perda** within these caps, so **PBJT varies by municipality**. Exemptions cover government, diplomatic missions, places of worship and social facilities.

> 💡 **Product implication — significant.** PBJT is a **per-municipality variable tax**. A CPO operating in Jakarta, Bandung, Surabaya and Bali faces four potentially different PBJT rates. The tariff engine needs **geography-aware tax resolution keyed to kabupaten/kota** — and the SPKLU identity number conveniently already encodes the municipality code (§1.4). Do not model tax as a single national rate. This is another feature a foreign CPMS will not have.

### 3.9 Demand-side and peak-shaving value

Two mechanisms create real peak-shaving value even without energy-price time-of-use:

1. **Rekening minimum: `RM = 40 × kVA × block cost`.** The minimum monthly bill is set by *connected capacity*, equivalent to 40 hours of full-capacity running. A site that subscribes 200 kVA pays as if it consumed 8,000 kWh/month regardless of actual use. **Load management that lets an operator subscribe less kVA directly reduces the floor on the monthly bill** — this is the strongest quantifiable ROI argument for PlugSure's load-management feature.
2. **The 200 kVA TR/TM threshold.** Staying under it avoids the far more expensive and complex TM connection (§4).

**PLN's night discount** demonstrates policy appetite for temporal price signals: **30% tariff discount for charging 22:00–05:00 WIB**, under "Promo PLN Home Charging Services 2.0" (1 July 2025 – 30 June 2026), extended for the discount element **through 31 December 2026** ([Republika, 2 Aug 2026](https://ekonomi.republika.co.id/berita/tj5a3g451/gandeng-giias-2026-pln-beri-harga-spesial-pemasangan-home-charging-kendaraan-listrik); [Ecobiz Asia](https://ecobiz.asia/spklu-pln-melonjak-44-persen-sepanjang-2025-layanan-home-charging-naik-dua-kali-lipat/)). Note this applies to **home charging**, not public SPKLU.

Also active: **50% discount on new connection / capacity upgrade (tambah daya)** for EV owners, e.g. 1-phase 7,700 VA at Rp 7,461,300 → **Rp 3,730,650**; 3-phase 13,200 VA at Rp 12,790,800 → **Rp 6,395,400** ([Masko Electrical](https://www.maskoelectrical.com/post/biaya-pasang-home-charger-mobil-listrik-2026)).

---

## 4. Grid realities

### 4.1 Connection topology

- **Low voltage (TR):** 220 V phase-to-neutral, **380–400 V phase-to-phase**, 3-phase 4-wire (R, S, T + N). Standard Indonesian LV is nominally 380 V, converging on 400 V. Three-phase is **readily available** commercially and in mid-to-upper residential tiers.
- **TR/TM boundary: 200 kVA.** Above this, connection moves to **TM at 20 kV**, requiring the customer to provide their own transformer, switchgear (cubicle), and metering at MV.
- Standard PLN 3-phase steps run roughly 3.9 / 6.6 / 10.6 / 13.2 / 16.5 / 23 / 33 / 41.5 / 53 / 66 / 82.5 / 105 / 131 / 147 / 197 kVA, with MCB protection to ~41.5 kVA (3×63 A) and MCCB above ([CalcPanel](https://calcpanel.com/guides/tabel-daya-listrik-pln-3-phase)). **197 kVA is the practical top of the TR range.**

### 4.2 Sizing and the power-factor trap

Excellent modelling from [Masko Electrical's TR vs TM analysis](https://www.maskoelectrical.com/post/biaya-dan-potensi-bisnis-spklu-tr-vs-tm):

| Scenario | Peak load (kW) | kVA @ PF 0.95 | kVA @ PF 0.80 |
|---|---|---|---|
| Small | 39.6 | 41.7 | 49.5 |
| Medium | 83.2 | 87.6 | 104.0 |
| Large | 168.0 | 176.8 | **210.0** |

**The large scenario crosses the 200 kVA TR/TM boundary purely on power factor.** At PF 0.95 it is a 177 kVA TR connection; at PF 0.80 it is a 210 kVA TM connection, with a step change in cost, complexity and lead time.

**Indicative economics by route:**

| | TR route | TM route |
|---|---|---|
| Typical scope | 1–2 chargers, ≤ ~200 kVA | Multi-charger |
| Energy cost | ~Rp 1,600/kWh (L scheme), up to ~Rp 2,400 | **~Rp 700/kWh (curah)** |
| Connection cost | Lower, simpler process | Substantially higher |
| Example revenue | 1× 22 kW AC + 1× 60 kW DC → **~Rp 15.5m/month** | 1× 120 kW DC ultrafast → **~Rp 47m/month** |

### 4.3 Why load management matters — the Indonesian case

1. **The 200 kVA cliff.** Load management that caps aggregate site draw below 200 kVA keeps a site on TR — avoiding transformer purchase, cubicle, MV protection, and a much longer PLN process. For a site with several DC chargers this is the difference between a viable and a stalled project.
2. **Rekening minimum is capacity-based** (`40 × kVA`). Every kVA of subscribed capacity carries a monthly floor cost whether used or not. Dynamic load management directly converts into a lower kVA subscription and a lower bill floor.
3. **Shared building circuits.** In malls, offices and apartments, chargers are almost never on a dedicated supply — they share the building's existing connection with HVAC, lifts and lighting. Without dynamic load balancing against the building's real-time load, chargers either trip the main or must be throttled to a uselessly conservative static limit.
4. **Capacity upgrade is slow and expensive.** *Tambah daya* into TM territory involves cost, civil works and PLN scheduling — load management is the cheap alternative to a physical upgrade.
5. **Weak-grid and archipelagic sites.** Outside Java, wide input-voltage tolerance and energy-storage integration are called out as regional requirements ([Joint Charging](https://jointcharging.com/sea-ev-charging-market-2026-analysis/)). Genset backup is common in Indonesian commercial buildings; **chargers must be capable of curtailment or shutdown when a site transfers to genset**, since gensets are sized for building essentials, not for 120 kW of DC charging.
6. **Home charging capacity is the binding national constraint.** Most Indonesian households **lack the electrical capacity to charge an EV at home** — typical residential connections are 1,300/2,200 VA, while a 7 kW charger needs ~7,700 VA. This makes Indonesia a **public-charging-first market**, unlike Europe or China, and raises the strategic importance of public/destination charging software. PLN's 50% *tambah daya* discount is a direct response.

> 💡 **Product implications:** dynamic load management (site-level and building-level, with an external CT/meter input), configurable site kVA ceiling with hard enforcement, genset-transfer detection and curtailment, phase-imbalance awareness on 3-phase AC, and per-site power-factor visibility. Expose "kVA headroom" as a first-class operator metric — it maps directly to money via rekening minimum.

**Environmental specs for hardware compatibility:** IP55+ enclosures for monsoon exposure, 50 °C+ operating tolerance with derating documentation, and **4G connectivity as primary backhaul** because fixed-line reliability is poor. Design the platform for intermittent connectivity — **offline session buffering and store-and-forward on the charger are not optional in Indonesia.**

---

## 5. TKDN / local content

### 5.1 The 2025 reform — TKDN now explicitly covers software

**Permenperin No. 35 Tahun 2025** is the current governing instrument ([BPK](https://peraturan.bpk.go.id/Details/333003/permenperin-no-35-tahun-2025); [official PDF](https://peraturan.go.id/files/permenperin-no-35-tahun-2025.pdf)).

The decisive change: **TKDN scope now extends beyond manufactured goods to "sektor jasa, software (perangkat lunak), dan konten digital"** ([Kontrak Hukum](https://kontrakhukum.com/article/update-aturan-tkdn-terbaru-tahun-2025/)). Reform principles: *"Murah, Mudah, Cepat, dan Transparan."*

Mechanics:
- Everything runs through **SIINas** (Sistem Informasi Industri Nasional) — no paper
- Digital certificates with **e-signature and QR verification**
- **Free certification for IKM** (small-medium industry), funded from APBN
- Shortened SLAs
- Certificate validity: **5 years** ([Konsultan TKDN, Jan 2026](https://konsultantkdn.id/2026/01/13/tkdn-jasa-industri-pengertian-syarat-dan-cara-perhitunganya/))

### 5.2 How services/software TKDN is computed

**Formula:** `TKDN = (Total Service Cost − Foreign Service Cost) / Total Service Cost`

**Cost components:** domestic labour, work equipment/facilities (*alat kerja*), general services (*jasa umum*), and **domestic software** (*perangkat lunak dalam negeri*) as a countable input ([PartnerKita](https://partnerkita.id/cara-menghitung-tkdn-jasa-dan-barang-panduan-lengkap-mudah-dipahami/)).

Value tracing extends to the **second tier**; third-tier domestic industrial services count as 100%.

**Process:**
1. Register company in SIINas and submit industry data
2. Self-assessment with supporting documentation
3. Verification (independent surveyor / authorised verifier)
4. Kemenperin approval, e-certificate issued via SIINas

### 5.3 Why this matters commercially — P3DN and e-Katalog

| Threshold | Consequence |
|---|---|
| **TKDN ≥ 25%** | Product recognised as domestic; government must prioritise it when available |
| **TKDN + BMP ≥ 40%** | **Imported alternatives are legally prohibited** in that procurement |

*(BMP = Bobot Manfaat Perusahaan, a company-benefit weighting added to raw TKDN.)* Legal basis: UU 3/2014 on Industry, Perpres 12/2021 on government procurement, Inpres 2/2022 on P3DN ([UNO Indonesia](https://uno.id/batas-minimal-nilai-tkdn/)).

> 💡 **Strategic implication — this is close to decisive for PlugSure's go-to-market.**
>
> PLN is a **BUMN**. Government agencies and SOEs procure through **LKPP e-Katalog** under P3DN rules. If PlugSure obtains TKDN certification at **TKDN + BMP ≥ 40%**, then in any PLN/SOE/government procurement where PlugSure is listed, **foreign CPMS platforms (Ampeco, Driivz, has-to-be, Monta, etc.) are excluded by law.**
>
> As an Indonesian-incorporated company developing software in Indonesia with Indonesian engineers, PlugSure should score very highly — domestic labour is the dominant cost component in a SaaS business, and the formula is labour-weighted.
>
> **Recommended actions, in priority order:**
> 1. Register in **SIINas** immediately — it gates everything and is free.
> 2. Run a self-assessment of the TKDN computation early; structure hiring, tooling and hosting decisions to maximise the domestic ratio *before* certification rather than after.
> 3. Note the tension with hosting: foreign cloud (AWS/GCP/Azure) is a foreign-service cost line that **dilutes TKDN**. Indonesian cloud providers or local regions with Indonesian-entity billing may improve the score. This interacts directly with §6 — **evaluate hosting for TKDN and data-residency jointly, not separately.**
> 4. Budget for the 5-year renewal cycle.
>
> ⚠️ **Uncertainty flag:** the *"TKDN-IT"* label used in the question does not appear as a distinct formal scheme in current sources. Historically, software TKDN was handled sector-specifically (notably in the 4G handset rules, where software carried a defined weighting — [Kemenperin](https://www.kemenperin.go.id/artikel/12537/TKDN-Perangkat-Lunak-Diatur)). **Permenperin 35/2025 appears to be the consolidating instrument** that brings software into the general TKDN framework. Confirm the precise calculation annex for software with a TKDN consultant — the general "jasa" formula may or may not be the exact one applied to a SaaS product.

### 5.4 TKDN on charging hardware

There is **no confirmed TKDN mandate specific to SPKLU equipment** in the sources I could reach. The Perpres 55/2019 TKDN schedule (Pasal 8) applies to **vehicles**, not chargers:

| Vehicle type | 2019–21 | 2022–26 | 2027–29 | 2030+ |
|---|---|---|---|---|
| 4-wheel+ | 35% | **40%** | 60% | 80% |
| 2-/3-wheel | 40% | **40%** | 60% | 80% |

Converted vehicles are exempt (Pasal 8(2)).

Charging equipment appears on the **incentive** side (Pasal 19(1) provides "charging equipment support") rather than the mandate side. However, PLN and SOE *procurement* of chargers will still apply P3DN preference — so charger vendors with TKDN certificates have an advantage, which indirectly shapes which hardware PlugSure's platform most needs to support well.

> 💡 **Product implication:** prioritise OCPP compatibility testing with **locally-manufactured/TKDN-certified charger brands**, since those are what PLN-channel deployments will use.

---

## 6. Data protection & residency

### 6.1 UU PDP — UU No. 27 Tahun 2022

Indonesia's Personal Data Protection Law ([BPK](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-202)), enacted 17 October 2022, with a **two-year transition period under Pasal 74 — expiring 17 October 2024.** The law is therefore **fully in force and enforceable today.**

**Controller obligations** (relevant to a charging platform holding driver identity, location, payment and travel-pattern data — which is sensitive in aggregate):
- Lawful basis, with **consent** the primary route; consent must be explicit, informed and separable
- Purpose limitation and data minimisation
- Data subject rights: access, rectification, erasure, portability, objection, withdrawal of consent
- **Breach notification** — written notice to affected subjects and the supervisory authority, with **72 hours** the widely-cited timeframe
- **DPO (Pejabat Pelindungan Data Pribadi)** required where processing is for public service, involves **large-scale regular systematic monitoring**, or involves large-scale sensitive data
- Records of processing; DPIA for high-risk processing

**Sanctions** ([Hukumonline](https://www.hukumonline.com/berita/a/ancaman-sanksi-administratif-hingga-pidana-dalam-uu-pelindungan-data-pribadi-lt633c69ce2de5c/)):

*Administrative (Pasal 57):* written warning → temporary suspension of processing → data deletion/destruction → **administrative fine up to 2% of annual revenue.**

*Criminal (Pasal 65–67):*
| Offence | Penalty |
|---|---|
| Unlawfully obtaining/collecting personal data | ≤ 5 years and/or **Rp 5 billion** |
| Unlawful disclosure | ≤ 4 years and/or **Rp 4 billion** |
| Unlawful use | ≤ 5 years and/or **Rp 5 billion** |

Corporate liability applies, with fines multiplied for corporate offenders.

**Supervisory authority status — an important practical nuance:**

The **Badan PDP has still not been established** as of 2026. The implementing Perpres has moved: presidential approval for the initiative March 2025 → inter-ministerial review March–September 2025 → harmonisation at the Ministry of Law from October 2025 → **target enactment 2026**. Kemkomdigi is exercising oversight functions in the interim ([Antara Jatim](https://jatim.antaranews.com/berita/1031282/kemkomdigi-targetkan-pembentukan-badan-pdp-rampung-2026); [Hukumonline](https://www.hukumonline.com/berita/a/menanti-disahkannya-aturan-turunan-uu-pdp-lt68fae7fbe057d/)).

> ⚠️ **Do not read the absent regulator as absent risk.** The statutory obligations and criminal provisions are live regardless of whether the Badan exists — criminal provisions are enforced by police and prosecutors, not by the data authority. The likely 2026 establishment of the Badan means **enforcement capacity is about to increase sharply**, and a platform launching now should be compliant by design rather than retrofitting under a new regulator's first enforcement wave.

### 6.2 PSE registration — PP 71/2019 and Permenkominfo 5/2020

**PP No. 71 Tahun 2019** on *Penyelenggaraan Sistem dan Transaksi Elektronik* ([JDIH Komdigi](https://jdih.komdigi.go.id/produk_hukum/view/id/695/t/peraturan+pemerintah+nomor+71+tahun+2019)) and **Permenkominfo No. 5 Tahun 2020** on PSE Lingkup Privat ([JDIH Komdigi](https://jdih.komdigi.go.id/produk_hukum/view/id/759/t/peraturan+menteri+komunikasi+dan+informatika+nomor+5+tahun+2020)), as amended by Permenkominfo 10/2021.

**PlugSure will be a PSE Lingkup Privat and must register.** The enumerated categories explicitly include operators of systems that process **financial transactions**, deliver digital services, and **process personal data for electronic transactions (SaaS)** ([Legalitas.org](https://legalitas.org/tulisan/tentang-pendaftaran-pse-lingkup-privat)).

**Process:** obtain NIB → register via **OSS (oss.go.id)**, submitting details of system operation, security measures, personal data protection, system feasibility testing, and **data location**.

**Timing:** registration must occur **before the electronic system begins operation.**

**Sanctions:** escalating — written warning → temporary suspension → **permanent access termination (blocking)** and registration revocation. Komdigi has actively cut access to non-compliant private PSEs.

### 6.3 Data residency — the actual rule

This is widely misunderstood, so stated precisely:

| PSE type | Data location rule |
|---|---|
| **PSE Lingkup Publik** (government) | Must manage, process and store **within Indonesia**. Offshore permitted **only** where the storage technology is unavailable domestically |
| **PSE Lingkup Privat** (PlugSure) | **May** manage, process and store **outside Indonesia** |

PP 71/2019 substantially **relaxed** the strict onshore mandate of the earlier PP 82/2012 ([Hukumonline](https://www.hukumonline.com/berita/a/mengenal-pokok-pokok-aturan-baru-pp-pste-lt5de653d86d627/)).

**The binding condition attached:** private PSEs must **guarantee access to their electronic systems and data for government supervision and law enforcement**, and must declare data location at registration.

> ⚠️ **Two important qualifications:**
> 1. **Sector rules can override.** Financial services (OJK/BI) impose stricter onshore requirements. If PlugSure handles payments directly or is deemed to operate a payment system, **BI/OJK localisation rules may bite where PP 71/2019 does not.** Structuring payments through a licensed Indonesian PSP avoids inheriting this.
> 2. **Contracting with PLN or government changes the calculus.** If PlugSure serves a PSE Lingkup Publik, the customer's onshore obligation can flow through contractually even though PlugSure's own obligation is permissive.
>
> Additionally, UU PDP governs **cross-border transfer** separately from PP 71/2019 — requiring the destination country to have adequate protection, or adequate safeguards, or the data subject's consent.

### 6.4 Available in-country cloud regions

All three hyperscalers have Indonesian regions:

| Provider | Region | Notes |
|---|---|---|
| **AWS** | `ap-southeast-3` — Asia Pacific (Jakarta) | Launched December 2021, 3 AZs ([AWS News Blog](https://aws.amazon.com/blogs/aws/now-open-aws-asia-pacific-jakarta-region)) |
| **Google Cloud** | `asia-southeast2` — Jakarta | Live; AI-ready capacity expanded 2025 ([Google Cloud](https://cloud.google.com/blog/products/infrastructure/new-google-cloud-region-in-jakarta-now-open); [TNGlobal](https://technode.global/2025/05/14/google-cloud-expands-ai-ready-data-center-capacity-in-jakarta/)) |
| **Azure** | Indonesia Central | ([Azure Speed](https://www.azurespeed.com/Information/AzureRegions/IndonesiaCentral)) |

> 💡 **Recommendation:** host in an Indonesian region even though PP 71/2019 does not compel it. Four independent reasons converge: (1) latency to chargers and users; (2) removes the residency question from every enterprise and government sales conversation; (3) satisfies any pass-through obligation from public-sector customers; (4) **may improve TKDN scoring** versus offshore hosting (§5.3). The regulatory freedom to host offshore is real, but the commercial and certification case for onshore is stronger.

---

## 7. Tax and invoicing

### 7.1 PPN (VAT) in 2026

| Item | Value |
|---|---|
| **Statutory rate** | **12%** since 1 January 2025 (UU HPP; PMK 131/2024) |
| **Effective rate, non-luxury** | **~11%** |
| **Mechanism** | *DPP Nilai Lain*: `DPP = 11/12 × Harga Jual`, then `PPN = 12% × DPP` ≈ 11% |
| **PKP registration threshold** | Turnover **> Rp 4.8 billion/year** |

Sources: [DDTC](https://news.ddtc.co.id/berita/nasional/1816162/januari-2025-tarif-efektif-ppn-tetap-11-persen-tak-jadi-12-persen), [Kalkulator Pajak](https://kalkulatorpajak.id/blog/ppn/panduan-lengkap-ppn), [Online Pajak](https://www.online-pajak.com/tentang-efaktur-ppn/uu-ppn-terbaru/).

The 12%-headline/11%-effective split is a persistent source of implementation bugs. **Compute it exactly as the regulation specifies** — `12% × (11/12 × base)` — rather than applying 11% directly, because the DPP shown on the faktur pajak must be the 11/12 figure, not the gross price. Getting the arithmetic right but the document wrong still fails an audit.

### 7.2 Is electricity sold at an SPKLU subject to PPN?

**Yes.** Electricity is exempt as a strategic good only for **household customers at or below 6,600 VA**. Above that threshold, electricity is fully taxable ([IKPI](https://ikpi.or.id/en/pln-hanya-pelanggan-di-atas-6-600-va-yang-terkena-ppn-12/); PP 49/2022 on VAT-exempt strategic goods — [Ortax](https://ortax.org/ketentuan-terbaru-fasilitas-pembebasan-pengenaan-ppn-atas-bkp-strategis)).

An SPKLU is a commercial connection far above 6,600 VA. Therefore:
- PLN's supply **to** the CPO is VATable (input VAT, creditable)
- The CPO's sale **to** the EV driver is VATable (output VAT)
- ESDM's own materials confirm the service-fee ceilings are quoted **excluding PPN**, and market examples show 11% PPN applied to the session total

### 7.3 e-Faktur, NPWP and Coretax

- Any CPO above the Rp 4.8bn threshold **must register as PKP** and **must issue e-Faktur**.
- Since the **Coretax DJP** rollout, **all faktur pajak are issued electronically** through Coretax (e-Faktur 4.0). Paper invoices are no longer valid ([Kalkulator Pajak](https://kalkulatorpajak.id/blog/ppn/panduan-lengkap-ppn); [DDTC on Coretax DPP nilai lain](https://news.ddtc.co.id/berita/nasional/1807981/pkp-sudah-bisa-buat-faktur-dengan-dpp-1112-dari-harga-jual-di-coretax)).
- **NPWP** is required for the business entity; since 2024 NPWP has been progressively unified with NIK for individuals.

**The retail-transaction problem:** a public charging session is a high-volume, low-value, often anonymous B2C transaction. Issuing a full e-Faktur per session is impractical. In practice this is handled by issuing e-Faktur on request (B2B/fleet customers, and consumers who need one) while retail sessions are covered by simplified documentation.

> 💡 **Product implications:**
> - The platform must **capture NPWP and legal entity details** on B2B/fleet accounts and support **e-Faktur generation or export in Coretax-compatible format**.
> - **Distinguish B2C sessions from B2B/fleet sessions** at the transaction level, because their invoicing paths differ.
> - Tax fields must be **stored per transaction, not derived at report time** — rates change, and historical invoices must remain reproducible exactly as issued.
> - Support consolidated monthly invoicing for fleet accounts.

### 7.4 PPh 23 — directly relevant to PlugSure as a SaaS vendor

Under **PMK 141/2015**, *"jasa sehubungan dengan software"* (services related to software) and website development/management services are **objects of PPh 23 at 2%** ([Klikpajak](https://klikpajak.id/blog/apa-saja-jasa-lain-yang-dipotong-pph-23-dalam-pmk-141-tahun-2015/); confirmed by DJP's own Kring Pajak account).

**This means PlugSure's Indonesian corporate customers will withhold 2% from its invoices.** Practical consequences:
- Rate is **2% if the vendor has an NPWP, 4% if not** — always provide NPWP.
- The withheld amount is a **prepayment of PlugSure's corporate income tax**, creditable against the year-end liability — it is cash-flow timing, not lost revenue.
- PlugSure must collect **bukti potong** (withholding certificates) from every customer to claim the credit.
- If the contract is characterised as a **software licence/royalty** rather than a service, different rules apply (royalty PPh 23 is 15%) — so **contract characterisation materially affects withholding**. Structure and describe the offering as a service consistently.

> 💡 **Product/finance implication:** model receivables net of 2% withholding, and build bukti potong tracking into the finance process from day one. This is a common cash-flow surprise for first-time Indonesian SaaS vendors.

---

## 8. Market context

### 8.1 Charging infrastructure — current scale

| Metric | Value | As of | Source |
|---|---|---|---|
| **SPKLU units (PLN)** | **5,016** across **3,132 locations** | June 2026 | [NTV News, 7 Aug 2026](https://www.ntvnews.id/ekonomi/01113855/pln-perluas-jaringan-spklu-seiring-lonjakan-konsumsi-listrik-kendaraan-listrik) |
| SPKLU units (ESDM, national) | 4,892 | May 2026 | [Jawa Pos](https://www.jawapos.com/ekonomi/2605110427/esdm-patok-target-fantastis-jumlah-spklu-62-ribu-hingga-2030-saat-ini-baru-4892-unit) |
| SPKLU units, PLN | 4,500 | Jan 2026 | [SWA](https://swa.co.id/read/468023/jumlah-spklu-pln-kian-bertambah-jumlahnya-per-januari-2026-capai-4500-unit) |
| SPKLU units, PLN | 4,655 at 3,007 locations | end-2025 | [Ecobiz Asia](https://ecobiz.asia/spklu-pln-melonjak-44-persen-sepanjang-2025-layanan-home-charging-naik-dua-kali-lipat/) |
| EVSE units for metrology | 4,769 at 3,097 locations | May 2026 | [Kemendag](https://www.kemendag.go.id/berita/siaran-pers/kemendag-luncurkan-layanan-persetujuan-tipe-tera-dan-tera-ulang-alat-ukur-pengisi-daya-kendaraan-listrik) |

**2025 growth: +44%**, adding 4,655 units vs 3,223 added in 2024.

**PLN fleet composition, end-2025** — note how heavily it skews to medium AC:
| Class | Units |
|---|---|
| Ultra-fast | 633 |
| Fast | 482 |
| **Medium** | **2,681** |
| Slow | 859 |

**Home charging:** **70,250** PLN home-charging customers at end-2025, more than double 2024's 32,215.

**EV electricity consumption:** **62.4 million kWh** in Jan–June 2026 alone, versus **48.5 million kWh** for the whole of 2025 — the half-year already exceeds the prior full year.

### 8.2 Government targets

| Target | Figure | Horizon | Source |
|---|---|---|---|
| ESDM SPKLU target | **62,918 units** (4W) | 2030 | [Jawa Pos](https://www.jawapos.com/ekonomi/2605110427/esdm-patok-target-fantastis-jumlah-spklu-62-ribu-hingga-2030-saat-ini-baru-4892-unit) |
| PLN development target | ~31,000 stations | 2031 | [Databoks](https://databoks.katadata.co.id/en/utilities/statistics/e74485fd778f109/pln-targets-development-of-31000-electric-vehicle-charging-stations-by-2031) |
| Realistic near-term | 8,000–12,000 units | 2026–27 | [Joint Charging](https://jointcharging.com/sea-ev-charging-market-2026-analysis/) |

The 2030 target implies roughly **12.9× growth from today** — about 58,000 units in four years, or ~14,500/year against 2025's actual 4,655. **The gap between target and run-rate is the market opportunity**, and it will only be closed by private CPOs at scale, which is precisely PlugSure's customer base.

The **ENTREV** programme is expanding beyond the DKI Jakarta / West Java / Bali pilots into **Yogyakarta, Surabaya, Medan, Makassar, Banjarmasin and Serang** — a useful geographic roadmap for market entry sequencing.

**SPBKLU** (battery swap) is a distinct and substantial adjacent market — ~1,700–1,839 units reported, serving the very large electric-motorcycle segment (Oyika, Swap Energi, Volta). Different unit economics, different session model, same licensing family.

### 8.3 Competitive landscape — charging operators

| Operator | Positioning | 2026 pricing | App |
|---|---|---|---|
| **PLN** | Dominant; ~5,000 units | Rp 2,466/kWh + PPN | PLN Mobile / Charge.IN |
| **Shell Recharge** | Premium, up to 150 kW | Rp 2,400–3,000/kWh (+Rp 25,000/txn) | Shell Asia |
| **Voltron** | End-to-end CPO | Rp 2,475–3,000/kWh + Rp 4,000 admin + 5% PBJT + PPN | Voltron Indonesia |
| **Starvo** | Premium DC network | Rp 2,500–3,000/kWh | Starvo |
| **Casion** | Jakarta | **Rp 1,000/minute** | Own app |
| **Terra Charge** | Japanese-backed | Rp 3,022/kWh | Own app |
| **Utomo Charge+** | Singapore Charge+ JV; targeted 1,000 guns by end-2025; PLN SE Asia roaming MoU | — | Charge+ |
| **Astra Otopower** | Astra group, Java | — | Own app |
| **Medco Power** | SCBD Jakarta | — | — |
| **OEM networks** | Hyundai, Wuling, BYD, BMW dealer chains | Variable/free | Brand apps |

Sources: [Gardu Oto, Aug 2026](https://www.garduoto.com/142917/peta-tarif-fast-charging-non-pln-di-indonesia-mana-paling-praktis); [Otodriver](https://otodriver.com/daftar-harga/2025/daftar-harga-pengisian-daya-spklu-pln-dan-swasta-dafebjdfsta); [Gooto](https://www.gooto.com/read/1844173/berikut-daftar-perusahaan-penyedia-spklu-untuk-mobil-listrik-di-indonesia).

Note the **pricing convergence around the Rp 2,466–2,475 regulated ceiling** with premium operators pushing to Rp 3,000. Payment is universally **cashless via in-app e-wallet**.

### 8.4 EV vehicle market

| Metric | Value | Period |
|---|---|---|
| **BEV wholesales** | **87,758 units** | Jan–Jul 2026 |
| **YoY growth** | **+88.6%** | vs Jan–Jul 2025 |
| Domestic BEV production | 42,363 units (**+237.6%**) | Jan–Jul 2026 |
| Total vehicle market | 517,742 units | Jan–Jul 2026 |
| **BEV share** | **~17%** | Jan–Jul 2026 |

Source: [CNN Indonesia, 18 Aug 2026](https://www.cnnindonesia.com/otomotif/20260818100748-603-1393454/penjualan-mobil-listrik-di-indonesia-melesat-88-persen).

Chinese OEMs dominate: **BYD, Geely, Jaecoo, Denza, GAC Aion, Wuling**, alongside Hyundai's local production.

> ⚠️ **Conflicting figure — flagged.** [Kompas Otomotif (14 July 2026)](https://otomotif.kompas.com/read/2026/07/14/100200215/pangsa-pasar-mobil-listrik-tembus-26-8-persen-semester-i-2026) headlines **26.8% market share for H1 2026** — materially above the ~17% BEV share derivable from CNN's figures. The most likely explanation is that the 26.8% figure counts **all electrified vehicles (BEV + HEV/PHEV)** while 17% is BEV-only. I could not fetch the Kompas article (robots.txt) to confirm. **Use ~17% for BEV-specific planning** — that is the number that drives public charging demand.

**Key demand driver:** BEVs meeting the 40% TKDN threshold receive **PPN reduced from 11% to 1%** (PPN DTP) — an extremely powerful incentive that explains both the sales surge and the rush of Chinese OEMs to localise assembly.

**Domestic production growing at +237.6% versus sales at +88.6%** signals rapid localisation — which in turn strengthens the TKDN ecosystem argument in §5.

### 8.5 Software competition — PlugSure's actual competitive set

> ⚠️ **This was the hardest area to research, and the finding is itself commercially significant.** Extensive searching in both English and Bahasa Indonesia surfaced **no established Indonesian CPMS/charge-point-management software vendor** operating as an independent platform business. Searches returned international vendors (Ampeco, Driivz, Monta, has-to-be), CMMS/maintenance software (a different category the search terms collide with), and academic OCPP work — but no local CPMS player.

Realistic competitive set:

**1. PLN's own platform — the primary competitor.** PLN Mobile / Charge.IN, with the "Electric Vehicle Digital Services" module (trip planning, queue management). Bundled at **2% of revenue** in partnership schemes. *Weakness:* built for PLN's own network and partnership model, not as a multi-tenant platform for independent CPOs; unlikely to serve competitors' commercial needs well; limited depth in load management, fleet billing, and compliance tooling.

**2. In-house builds by large CPOs.** Voltron, Starvo, Shell Recharge and Casion each run their own apps, implying in-house or contracted software. These are captive systems, and each represents either a competitor or — more usefully — **a potential customer who has discovered that maintaining a CPMS is not their core business.**

**3. International CPMS vendors.** Technically mature but carrying real disadvantages in this market: no TKDN certification (legally excludable from PLN/SOE procurement under P3DN — §5.3), no tera-ulang lifecycle tracking, no PBJT-by-municipality tax logic, no `Q × 707` / `N × 1,650` tariff modelling, no SPKLU-ID handling, no Coretax e-Faktur integration, and no local support presence.

**4. Hardware vendors bundling software.** Chinese charger OEMs increasingly ship a bundled cloud platform, typically weak on local compliance and multi-vendor support.

> 💡 **Strategic conclusion.** PlugSure's defensible position is not generic CPMS features — those are commoditised globally. It is the **Indonesian compliance and commercial layer** that no international vendor has and no local player has yet built as a product:
>
> - `Q`/`N` multiplier tariff modelling with versioned, dated bases
> - Per-municipality PBJT resolution keyed off the SPKLU ID's municipality code
> - Tera/tera-ulang certificate lifecycle with connector-level commercial blocking on lapse
> - SLO and SPKLU-ID compliance tracking with expiry alerting
> - Coretax-compatible e-Faktur generation, with B2C/B2B session separation
> - kVA-headroom load management tied to the `40 × kVA` rekening minimum and the 200 kVA TR/TM cliff
> - **TKDN certification**, which can *legally exclude* international competitors from PLN/SOE/government procurement
> - Offline-tolerant operation for 4G-backhauled, weak-grid sites
>
> The market timing is favourable: infrastructure must grow ~13× by 2030, private CPOs will build most of it, the metrology regime just created a brand-new compliance burden (May 2026) that no incumbent tool addresses, and TKDN opened to software only in 2025.

---

## 9. Consolidated open questions

Ranked by impact on the PRD:

| # | Question | Why it matters | How to close |
|---|---|---|---|
| 1 | Is **Single Gateway** integration mandatory for private CPOs? What is its API/schema? | Could be a required compliance feature and a first-mover advantage | Direct contact with Direktorat Pembinaan Pengusahaan Ketenagalistrikan; attend a bimtek |
| 2 | Has **Permen ESDM 1/2023** been amended/replaced 2024–2026? | Foundation of the whole licensing model | JDIH ESDM manual check (site is JS-rendered) |
| 3 | What does **Kepmen ESDM 24.K/TL.01/MEM.L/2025** cover — does it supersede the 182.K/2023 fee ceilings? | Directly affects billing ceilings | Ditjen Gatrik socialisation deck; legal counsel |
| 4 | **Tera ulang interval** and penalties for EVSE | Drives compliance-alerting design | Direktorat Metrologi, Kemendag |
| 5 | Exact **TKDN calculation annex for software** under Permenperin 35/2025 | Determines achievable score and hosting/hiring structure | TKDN consultant + SIINas registration |
| 6 | Is **SNI mandatory (wajib)** for EVSE? | Affects hardware onboarding validation | BSN / Kemenperin |
| 7 | Current **Q and N values** PLN applies by scheme and voltage level | Tariff engine defaults | PLN partnership team |
| 8 | **SLO validity period** for SPKLU installations | Compliance-tracking field | LIT (e.g. Sucofindo) |
| 9 | Reconcile the **17% vs 26.8%** EV market share figures | Demand forecasting | Gaikindo primary data |

**A note on source reliability:** Indonesian government portals — `gatrik.esdm.go.id`, `jdih.esdm.go.id`, `peraturan.bpk.go.id`, `tkdn.kemenperin.go.id` — are heavily JavaScript-rendered and frequently blocked automated retrieval during this research. Several primary regulatory documents were reachable only via secondary reporting or direct PDF links. Where I have relied on secondary sources for a regulatory claim, I have said so. **Before the PRD is finalised, the items in the table above should be confirmed against primary text with Indonesian energy-sector counsel** — particularly items 1–3, where a change would alter product requirements rather than merely refine them.

---

## Sources

**Regulatory**
- [Perpres 79/2023 full text (JDIH Kemenkeu PDF)](https://jdih.kemenkeu.go.id/api/download/2426f667-7c15-4afb-8a52-4efc01da5e9b/2023perpres079.pdf) · [Perpres 79/2023 (BPK)](https://peraturan.bpk.go.id/Details/273447/perpres-no-79-tahun-2023) · [Perpres 55/2019 (JDIH Kemenkeu)](https://jdih.kemenkeu.go.id/dok/perpres-55-tahun-2019)
- [Permen ESDM 1/2023 (BPK)](https://peraturan.bpk.go.id/Details/252409/permen-esdm-no-1-tahun-2023) · [summary, JDIH Kemenko Infrastruktur](https://jdih.kemenkoinfra.go.id/permen-esdm-12023-penyediaan-infrastruktur-pengisian-listrik-kendaraan-listrik-berbasis-baterai)
- [Ditjen Gatrik — Perizinan Berusaha SPKLU IUPTL-PWU (June 2025 PDF)](https://gatrik.esdm.go.id/infogatrik/api//storage/2025/konten/pdf/7QYZeAN2hV_02062025021414.pdf)
- [Ditjen Gatrik — PP 28/2025 & Single Gateway](https://gatrik.esdm.go.id/berita/?slug=pasca-pp-28-2025-pemerintah-sederhanakan-izin-spklu-dan-perkuat-sistem-data-ketenagalistrikan&category=ketenagalistrikan) · [PP 28/2025 (JDIH Bapeten)](https://jdih.bapeten.go.id/id/dokumen/peraturan/peraturan-pemerintah-nomor-28-tahun-2025-tentang-penyelenggaraan-perizinan-berusaha-berbasis-risiko)
- [Prolegal — SPKLU licence types](https://prolegal.id/jenis-jenis-izin-usaha-stasiun-pengisian-kendaraan-listrik-umum-spklu/) · [Prolegal — SLO](https://prolegal.id/sertifikat-laik-operasi-slo-adalah-definisi-manfaat-dan-sanksinya/) · [Sucofindo SLO](https://www.sucofindo.co.id/en/layanan-jasa/sertifikasi-laik-operasi-slo/) · [Ditjen Gatrik IUPTLS FAQ](https://gatrik.esdm.go.id/assets/uploads/download_index/files/0d0f0-faq-izin-usaha-penyediaan-tenaga-listrik-untuk-kepentingan-sendiri-iuptls-.pdf)
- [Bloomberg Technoz — Single Gateway](https://www.bloombergtechnoz.com/detail-news/11380/single-gateway-aplikasi-pencarian-spklu-diluncurkan-akhir-tahun) · [Bloomberg Technoz — Perpres 79/2023](https://www.bloombergtechnoz.com/detail-news/23685/poin-poin-krusial-perpres-79-2023-soal-insentif-kendaraan-listrik) · [CNN — Perpres revision](https://www.cnnindonesia.com/otomotif/20231213110705-603-1036637/jokowi-terbitkan-revisi-perpres-kendaraan-listrik-berikut-isinya)

**Metrology & standards**
- [Kemendag — EVSE tera launch, 25 May 2026](https://www.kemendag.go.id/berita/siaran-pers/kemendag-luncurkan-layanan-persetujuan-tipe-tera-dan-tera-ulang-alat-ukur-pengisi-daya-kendaraan-listrik) · [Koran Jakarta](https://koran-jakarta.com/2026-05-25/pastikan-pengisian-daya-listrik-akurat-dan-adil-kemendag-resmikan-layanan-tera-spklu) · [Antara](https://www.antaranews.com/berita/4105503/pemerintah-sebut-alat-ukur-di-spklu-wajib-ditera) · [Viva](https://www.viva.co.id/bisnis/1901070-kemendag-mulai-uji-tera-spklu-mendag-budi-tegaskan-konsumen-harus-dapat-sesuai-yang-dibayarkan)
- [Permendag 24/2024 (JDIH Kemendag)](https://jdih.kemendag.go.id/peraturan/peraturan-menteri-perdagangan-nomor-24-tahun-2024-tentang-kegiatan-tera-dan-tera-ulang-alat-ukur-alat-timbang-dan-alat-perlengkapan-metrologi-legal-1) · [BPK](https://peraturan.bpk.go.id/Details/305838/permendag-no-24-tahun-2024)
- [BSN — SNI-certified SPKLU](https://www.bsn.go.id/main/berita/detail/17758/ribuan-spklu-standar-sni-beredar-di-indonesia) · [BSN — PLN SNI certification capability](https://bsn.go.id/main/berita/detail/12518/-pln-kini-bisa-terbitkan-sertifikasi-sni-untuk-spklu) · [SNI IEC 61851-21-1:2017](https://pesta.bsn.go.id/produk/detail/12787-sniiec61851-21-12017) · [Pingalax — SPKLU technical standards](https://pingalax.id/spklu-technical-standards/)

**Tariffs & business case**
- [Permen ESDM 7/2024 official PDF (JDIH ESDM)](https://jdih.esdm.go.id/common/dokumen-external/Permen%20ESDM%20Nomor%207%20Tahun%202024.pdf) · [BPK](https://peraturan.bpk.go.id/Details/294347/permen-esdm-no-7-tahun-2024)
- [ESDM — SPKLU tariffs & service fees](https://www.esdm.go.id/id/media-center/arsip-berita/percepat-ekosistem-kendaraan-listrik-pemerintah-resmi-terbitkan-tarif-dan-biaya-layanan-pengisian-listrik-pada-spklu) · [Antara](https://www.antaranews.com/berita/3659736/kementerian-esdm-tetapkan-biaya-layanan-pengisian-listrik-di-spklu) · [Kompas — only fast/ultrafast regulated](https://otomotif.kompas.com/read/2023/07/26/183716515/hanya-tarif-fast-charging-dan-ultrafast-charging-yang-diatur-ini-kata-esdm) · [Indonesia Baik infographic](https://indonesiabaik.id/infografis/tarif-ngecas-cepat-kendaraan-listrik)
- [CNBC — Q3 2026 tariff table](https://www.cnbcindonesia.com/news/20260727084544-4-753968/daftar-resmi-tarif-listrik-pln-per-kwh-berlaku-juli-september-2026) · [Navigasi — 2026 SPKLU tariffs](https://navigasi.co.id/detail/1452319/update-tarif-listrik-spklu-pln-2026-per-kwh-biaya-fast-charging-terbaru)
- [Listrik Indonesia — tarif curah & 50% connection discount](https://listrikindonesia.com/detail/14957/tingkatkan-minat-bangun-spklu-pln-beri-tarif-curah-dan-diskon-penyambungan-50) · [Masko — TR vs TM economics](https://www.maskoelectrical.com/post/biaya-dan-potensi-bisnis-spklu-tr-vs-tm) · [Masko — PLN partnership schemes](https://www.maskoelectrical.com/post/cara-menjalin-kerja-sama-dengan-pln-untuk-membangun-spklu-di-lokasi-anda) · [PLN Partnership SPKLU portal](https://layanan.pln.co.id/partnership-spklu) · [spklu.com — capital requirements](https://spklu.com/modal-buka-usaha-spklu/) · [Kumparan — Rp 400m partnership](https://kumparan.com/kumparanbisnis/pln-buka-kemitraan-bikin-spklu-modal-rp-400-jutaan-tertarik-20ywqMrdhWU)
- [DDTC — PBJT electricity rates under UU HKPD](https://news.ddtc.co.id/berita/nasional/44010/begini-ketentuan-tarif-pbjt-atas-konsumsi-tenaga-listrik-di-uu-hkpd) · [Pajakku — PP 4/2023](https://artikel.pajakku.com/ketahui-aturan-pp-42023-tentang-pungutan-pbjt-tenaga-listrik)

**Grid**
- [CalcPanel — PLN 3-phase tiers](https://calcpanel.com/guides/tabel-daya-listrik-pln-3-phase) · [Masko — 2026 home charger costs & PLN promos](https://www.maskoelectrical.com/post/biaya-pasang-home-charger-mobil-listrik-2026) · [Republika — GIIAS 2026 PLN promo](https://ekonomi.republika.co.id/berita/tj5a3g451/gandeng-giias-2026-pln-beri-harga-spesial-pemasangan-home-charging-kendaraan-listrik)

**TKDN**
- [Permenperin 35/2025 (BPK)](https://peraturan.bpk.go.id/Details/333003/permenperin-no-35-tahun-2025) · [official PDF](https://peraturan.go.id/files/permenperin-no-35-tahun-2025.pdf) · [Kontrak Hukum — 2025 TKDN update](https://kontrakhukum.com/article/update-aturan-tkdn-terbaru-tahun-2025/) · [Konsultan TKDN — TKDN Jasa Industri](https://konsultantkdn.id/2026/01/13/tkdn-jasa-industri-pengertian-syarat-dan-cara-perhitunganya/) · [UNO — minimum TKDN thresholds](https://uno.id/batas-minimal-nilai-tkdn/) · [Kemenperin — software TKDN](https://www.kemenperin.go.id/artikel/12537/TKDN-Perangkat-Lunak-Diatur) · [PartnerKita — TKDN Jasa calculation](https://partnerkita.id/cara-menghitung-tkdn-jasa-dan-barang-panduan-lengkap-mudah-dipahami/)

**Data protection**
- [UU 27/2022 (BPK)](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-202) · [Hukumonline — PDP sanctions](https://www.hukumonline.com/berita/a/ancaman-sanksi-administratif-hingga-pidana-dalam-uu-pelindungan-data-pribadi-lt633c69ce2de5c/) · [Antara — Badan PDP target 2026](https://jatim.antaranews.com/berita/1031282/kemkomdigi-targetkan-pembentukan-badan-pdp-rampung-2026) · [Hukumonline — awaiting PDP implementing rules](https://www.hukumonline.com/berita/a/menanti-disahkannya-aturan-turunan-uu-pdp-lt68fae7fbe057d/)
- [PP 71/2019 (JDIH Komdigi)](https://jdih.komdigi.go.id/produk_hukum/view/id/695/t/peraturan+pemerintah+nomor+71+tahun+2019) · [Permenkominfo 5/2020 (JDIH Komdigi)](https://jdih.komdigi.go.id/produk_hukum/view/id/759/t/peraturan+menteri+komunikasi+dan+informatika+nomor+5+tahun+2020) · [Hukumonline — PP PSTE key points](https://www.hukumonline.com/berita/a/mengenal-pokok-pokok-aturan-baru-pp-pste-lt5de653d86d627/) · [Legalitas.org — PSE registration](https://legalitas.org/tulisan/tentang-pendaftaran-pse-lingkup-privat)
- [AWS Jakarta region](https://aws.amazon.com/blogs/aws/now-open-aws-asia-pacific-jakarta-region) · [Google Cloud Jakarta](https://cloud.google.com/blog/products/infrastructure/new-google-cloud-region-in-jakarta-now-open) · [Azure Indonesia Central](https://www.azurespeed.com/Information/AzureRegions/IndonesiaCentral)

**Tax**
- [DDTC — effective PPN 11%](https://news.ddtc.co.id/berita/nasional/1816162/januari-2025-tarif-efektif-ppn-tetap-11-persen-tak-jadi-12-persen) · [DDTC — DPP 11/12 in Coretax](https://news.ddtc.co.id/berita/nasional/1807981/pkp-sudah-bisa-buat-faktur-dengan-dpp-1112-dari-harga-jual-di-coretax) · [Kalkulator Pajak — PPN guide 2026](https://kalkulatorpajak.id/blog/ppn/panduan-lengkap-ppn) · [IKPI — PPN only above 6,600 VA](https://ikpi.or.id/en/pln-hanya-pelanggan-di-atas-6-600-va-yang-terkena-ppn-12/) · [Ortax — PP 49/2022 strategic goods](https://ortax.org/ketentuan-terbaru-fasilitas-pembebasan-pengenaan-ppn-atas-bkp-strategis) · [Klikpajak — PPh 23 PMK 141/2015](https://klikpajak.id/blog/apa-saja-jasa-lain-yang-dipotong-pph-23-dalam-pmk-141-tahun-2015/)

**Market**
- [NTV News — 5,016 SPKLU June 2026](https://www.ntvnews.id/ekonomi/01113855/pln-perluas-jaringan-spklu-seiring-lonjakan-konsumsi-listrik-kendaraan-listrik) · [Ecobiz Asia — 2025 growth & breakdown](https://ecobiz.asia/spklu-pln-melonjak-44-persen-sepanjang-2025-layanan-home-charging-naik-dua-kali-lipat/) · [Jawa Pos — 62,918 target](https://www.jawapos.com/ekonomi/2605110427/esdm-patok-target-fantastis-jumlah-spklu-62-ribu-hingga-2030-saat-ini-baru-4892-unit) · [SWA](https://swa.co.id/read/468023/jumlah-spklu-pln-kian-bertambah-jumlahnya-per-januari-2026-capai-4500-unit) · [Databoks — PLN 31,000 by 2031](https://databoks.katadata.co.id/en/utilities/statistics/e74485fd778f109/pln-targets-development-of-31000-electric-vehicle-charging-stations-by-2031)
- [CNN — EV sales +88.6% Jan–Jul 2026](https://www.cnnindonesia.com/otomotif/20260818100748-603-1393454/penjualan-mobil-listrik-di-indonesia-melesat-88-persen) · [Kompas — H1 2026 share](https://otomotif.kompas.com/read/2026/07/14/100200215/pangsa-pasar-mobil-listrik-tembus-26-8-persen-semester-i-2026)
- [Gardu Oto — non-PLN fast charging map Aug 2026](https://www.garduoto.com/142917/peta-tarif-fast-charging-non-pln-di-indonesia-mana-paling-praktis) · [Otodriver — operator price list](https://otodriver.com/daftar-harga/2025/daftar-harga-pengisian-daya-spklu-pln-dan-swasta-dafebjdfsta) · [Gooto — SPKLU providers](https://www.gooto.com/read/1844173/berikut-daftar-perusahaan-penyedia-spklu-untuk-mobil-listrik-di-indonesia) · [Joint Charging — SEA market 2026](https://jointcharging.com/sea-ev-charging-market-2026-analysis/) · [Kontan — Utomo Charge+/PLN roaming](https://pressrelease.kontan.co.id/news/utomo-chargeplus-pln-kembangkan-integrasi-jaringan-akses-mobilitas-di-asia-tenggara)

agentId: af524a9e1492ec5c4 (use SendMessage with to: 'af524a9e1492ec5c4', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 181558
tool_uses: 126
duration_ms: 1017081</usage>