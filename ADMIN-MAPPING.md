# Admin & data mapping

**From:** Logan Randall
**For:** Sagar Farid and Zakira (build)
**Companion to:** [HANDOFF.md](HANDOFF.md) — read that first for the *why*. This document is
the *where*.

---

## RUNNING ON REAL DATA AS OF AUG 6 2026 — and what that changed

The prototype now loads a real lead export (`Lead-Report-08-06-26.csv`, 71,725 rows,
Jun 1 – Aug 6 2026) instead of generated data. `tools/ingest.py` converts it to
`assets/data/dataset.js`; every affiliate in the export is a selectable partner view.
**Consumer PII and internal cost/margin columns are never emitted by the ingest** — the
script asserts it before writing.

Three things this document listed as **NEEDS BUILDING — blocking** turned out to already
exist in the export. That is good news and it changes the build order:

| Was documented as | Actually |
|---|---|
| `sold_type` — blocking, the whole scorecard waits on it | **EXISTS.** `priority` / `hot_lead` / `auction` / `marketplace`, 1,483 sold rows. Prices confirm it: Priority median **$500**, Hot **$456**, Auction $49, Marketplace $41 |
| `speed_to_lead` — missing, ops pillar parked | **EXISTS but is unusable.** Populated on every row, values run from **−113,426,741 to 4,109,200** with a median of 0. Parked for a different reason than we thought: the field is broken, not absent |
| `call_attempts_to_convert` — missing | **EXISTS and looks sane.** Median 0 (most leads are Pending), p90 4, max 66 |

And one thing we assumed was fine is not:

| Assumption | Reality |
|---|---|
| Leads carry a timestamp | **They do not.** `TimeStamp` is empty on all 71,725 rows and `Created On` is date-only. **Every hour-of-day feature is impossible today** — the arrival-window widget is switched off and the window component is dropped from the health score rather than scored as zero. Adding a time component to the export turns all of it on |

The full list of what the export can and cannot support is rendered in the app on the
internal **Data source** page, so it is reviewable rather than buried here.

---

## ⚑ THE CONNECTION LIST — what the dev team needs to wire up

**This is the hand-off list.** Everything the dashboard needs that the current lead export
cannot supply, in priority order. Each row is a thing that must be added to the export, fixed
at source, or created as an admin-editable field. Detail for each is in the numbered sections
below; this is the summary to work from.

### A. Fields missing from the lead export

| # | Field | Blocks | Status |
|---|---|---|---|
| A1 | **Time of day on `Created On`** (or populate `TimeStamp`) | Every hour-of-day feature: arrival-window analysis, the ideal-send-window comparison, the window component of the health score | **MISSING.** `TimeStamp` is empty on all 71,725 rows; `Created On` is date-only |
| A2 | **`sub_id` on the lead post** | Per-publisher scoring, sub-ID drilldown, per-source pricing | **0.4% fill.** Madrivo 99%, Heritage and OptiLabX **0%** |
| A3 | **`speed_to_lead`** — valid seconds | Operations pillar (60% of it) | **BROKEN.** Populated but values run −113,426,741 to 4,109,200, median 0 |
| A4 | **Rev-share % per campaign** | Correct comp-model inference and Your-share maths | **PARTIAL.** Column holds 40 / 0 / 4 / 1.75%. annuity.org's **85% is absent**, so they wrongly read as CPL |
| A5 | **Controlled `reject_reason` vocabulary** | Clean rejection reporting | **BROKEN.** 2,917 distinct values; the tail is raw XML filter responses |
| A6 | **`lead_cost` = $0 on rev-share** | Any margin metric | **BROKEN.** All 41,627 accepted rows bill $1.00 — the phantom COGS, confirmed live |
| A7 | **Normalised `assets` band** | Asset-band targeting widget | **PARTIAL.** 29 free-text variants; 81.6% collapse into one band |
| A8 | **`sold_type` on the 16 Sold rows missing it** | Tier metrics completeness | **PARTIAL** |

### B. Fields that do not exist anywhere yet

| # | Field | Drives | Notes |
|---|---|---|---|
| B1 | **`partner_since`** | "Partner since" on the Partnership summary | Not derivable from leads — the earliest row is the export window, not the relationship. Backfill from contract date |
| B2 | **`affiliate_users` table** | The whole Account & users page | Full spec in §1a. Multi-user login, primary contact, titles, avatars, away flag |
| B3 | **`billing_period` / `billing_basis`** | Billing details card | Net 7 / 15 / 30, and received vs sold date |
| B4 | **`partner_targets`** | Targets card, target line on Leads by day | Volume and/or spend, per partner per month. §4 |
| B5 | **Campaign `active` lifecycle** | Active-campaign list, inactive count | Today a manual flip. Wanted: auto-active on lead flow, auto-inactive after 6 months idle. §2 |
| B6 | **Per-state demand / budget** | The states-we-need widget | §5a |
| B7 | **Call-centre hours & ideal windows as config** | Targeting page | Currently constants in `data.js`. §5b, §5c |
| B8 | **Account-manager join** | Account manager block | Exists in the CRM, not joined to the portal |
| B9 | **Google Chat deep link** | Chat button on Partnership summary | Currently a generic chat.google.com link |

### C. Confirmed present — no work needed

`sold_type` (priority / hot_lead / auction / marketplace, prices confirm the tiers),
`call_attempts`, `campaign_id` / CID, `state`, `revenue`, `revenue_share_amount`,
`return_reason`, `affiliate_id`.

---

## What this document is

Every element in the affiliate dashboard is driven by something: a field on a table, a setting an
admin controls, or a constant nobody has written down yet. This maps each one, and says whether it
exists today.

**The mock-up is deliberately affiliate-facing only.** There is no admin UI in it, because the
thing being reviewed by Michael and Courtney is what the partner sees.
[admin-preview.html](admin-preview.html) is a **temporary, internal, non-partner-facing** page that
shows the *shape* of the settings this document describes — it is a picture of a screen that needs
building, not the screen itself. Delete it before anything ships to a partner.

### How to keep this current

This document is meant to be appended to, not rewritten. **When a field or feature is added to the
dashboard, add its row here in the same change.** A feature that renders but has no row here is a
feature nobody knows how to populate in production.

Each row carries a status:

| Status | Meaning |
|---|---|
| **EXISTS** | The field or setting is on the current system and can be read today |
| **PARTIAL** | Something is there but it is wrong, incomplete, or not exposed |
| **NEEDS BUILDING** | Nothing exists; this is net-new work |

---

## The one rule that constrains all of this

**Visibility is enforced in the query, not in the template.** Every setting below that controls
what an affiliate can see must change *which columns are selected*, not which columns are hidden
after selection. A field an affiliate may not see must never be on the object that reaches the
view layer, the CSV export, or the browser console.

In the mock this is `queryLeads()` in `assets/js/data.js`. In PHP it is two different SELECT lists.
If any setting here ends up implemented as an `if` in a Blade/Twig template, the setting is wrong
even if the screen looks right.

---

## 1. Partner record

One row per affiliate. Drives the Partnership summary screen and every criteria label.

| Field | Drives | Status | Notes |
|---|---|---|---|
| `partner_id` | everything | **EXISTS** | |
| `name` | Partnership summary, sidebar | **EXISTS** | |
| **Active / Inactive** | Partnership summary badge, sidebar footer | **DERIVED — NEEDS BUILDING** | **Not a stored flag.** Active = at least one **accepted** lead in the trailing month; otherwise the badge turns orange and reads Inactive, with the last-accepted date shown. `SELECT COUNT(*) FROM leads WHERE partner_id = ? AND status='paid' AND received_at >= NOW() - INTERVAL 1 MONTH`. The old stored `status` field is superseded and should not drive anything |
| `rev_share_pct` | Your-share column, earnings tiles | **PARTIAL** | Exists but is hardcoded 40% in places. annuity.org runs at 85% — it must be per partner |
| `age_band_min` / `age_band_max` | every criteria label, **Targeting page** | **NEEDS BUILDING** | See the warning below |
| `products` | per-campaign only now | **EXISTS** | Removed from the Partnership summary — products and integration churn per campaign, so they render only in the campaigns table |
| `integration_type` | per-campaign only now | **EXISTS** | Same |
| `partner_since` | "Partner since" under the badge | **LIKELY MISSING — confirm** | Must reflect the date the partnership was actually added. **Logan flags this may not exist in the admin centre today.** If absent, backfill from contract date or first campaign creation, then store properly |
| `billing_period` | Billing details card (sub-line) | **NEEDS BUILDING** | Net 7 / Net 15 / Net 30, admin-editable per partner. Most run Net 30 |
| `billing_basis` | Billing details card | **NEEDS BUILDING** | Whether invoicing is on received or sold date |
| Next payment date | Billing details card (headline) | **DERIVED** | Third business day after the most recent month close, rolling to the next close once past. Weekends excluded; **company holidays are not modelled in the mock** — production should read a holiday calendar or an explicit payout schedule if one exists |
| Report → invoice cadence | Billing details card (note) | **CONSTANT** | We send the lead report immediately after month close; the affiliate returns their invoice on receipt. Worth an automated email later, but copy is enough for now |
| `account_manager` | Account manager block | **PARTIAL** | Exists in the CRM, not joined to the portal. Shows name, title, email (`logan@financialize.com`), an Email button (`mailto:`), and a **Google Chat button — currently a generic chat.google.com link; production should deep-link into a DM with the manager** |
| Billing contacts | Billing details card | **CONSTANT** | Cassie Jensen `accounting@financialize.com` (billing questions), Christine Aquino `christine.aquino@financialize.com` (invoice reports). Fine as config, not per-partner data |

---

## 1a. Affiliate users — NEEDS BUILDING, whole table

An affiliate is a company; several people at that company sign in as separate **users** of the one
account. **Financialize staff are not users** — admin access covers every account and lives
outside this table.

```
affiliate_users
  user_id      PK
  partner_id   FK — every user belongs to exactly one affiliate
  name         VARCHAR
  email        VARCHAR  UNIQUE — the login
  title        VARCHAR  NULL   — editable by any user on the account
  is_primary   BOOLEAN         — exactly ONE true per partner_id, enforced
  away         BOOLEAN         — the subtle "on vacation" marker
  avatar       BLOB/URL NULL   — profile picture, user-uploaded
  password     via the auth system, self-service reset
```

| Behaviour | Rule |
|---|---|
| Primary contact | Exactly one per affiliate. Shown on the Partnership summary as "Your primary contact." **Any user on the account may change it** — it is their team, not ours to gate |
| Edit titles / emails | Any user on the account |
| Password reset | Self-service for their own; any user may trigger a reset **email** for a teammate (never sets a password directly) |
| Away marker | User-toggled, deliberately subtle — a muted chip, no status colour |
| Add user | Invitation email; invitee sets their own password |

In the mock: `usersFor()` / `saveUsers()` / `setPrimaryContact()` in `data.js`, persisted to
sessionStorage so edits on the Account page show up on the Partnership summary. The Account page
is `account.html`.

> **`age_band_min` / `age_band_max` is the highest-risk row in this document.** OptiLabX runs a
> negotiated **45–79** band rather than the standard 45–75. That is a commercial term, not a data
> error, and treating it as one has already cost a **$5,194 invoice variance** and wrongly flagged
> **55 leads (~$4,000)** on a July unfire list. Any acceptance or eligibility computation must read
> these fields. **A hardcoded 45–75 anywhere will misreport our largest partner.**

---

## 2. Campaign record

**Comp model lives here, not on the partner.** A partner can run revenue-share and CPL campaigns
side by side, and the lead table renders them in one view with different columns per row.

| Field | Drives | Status | Notes |
|---|---|---|---|
| `campaign_id` (CID) | Partnership summary, lead table, all filters | **EXISTS** | |
| `name` | everywhere | **EXISTS** | |
| `partner_id` | scoping | **EXISTS** | |
| **`comp_model`** | **the entire column projection** | **NEEDS BUILDING** | `revshare` \| `cpl`. Today comp model is effectively an account-level assumption |
| `rev_share_pct` override | Your-share column | **NEEDS BUILDING** | Optional; falls back to the partner rate |
| `cpl_tier` / rate card | invoicing | **PARTIAL** | Tiered CPL exists but is not exposed per campaign |
| `active` | Partnership summary listing + inactive count | **PARTIAL — rule change requested** | Today this is a **manual flip** in the admin system. **Logan wants it derived:** a campaign is automatically marked active while leads arrive through its landing page or API, and automatically marked **inactive after 6 months without a single lead**. The Partnership summary shows "this account has X campaigns marked as inactive" from this field. Keep a manual override for hard pauses, but the default lifecycle should be automatic |
| `launched_on` | Partnership summary | **PARTIAL** | Derivable from first lead; better stored |
| `product` | Partnership summary, lead table | **EXISTS** | |

---

## 3. Lead table columns — the admin-configurable part

This is the setting you asked for: **which columns an affiliate can see, chosen per comp model.**

### How it works in the mock

Two pieces in `assets/js/data.js`:

- **`LEAD_COLUMNS`** — the registry. One entry per affiliate-visible column. Each entry declares
  which comp models *may* see it. **Adding a column later is one entry here and nothing else** —
  the lead table, the CSV export and the admin screen all read this list.
- **`ADMIN_COLUMN_CONFIG`** — what an admin screen writes. Per comp model, the set of registry
  columns switched on.

`columnsFor(compModel)` intersects the two. The registry is a **hard constraint, not a default**:
an admin cannot switch on a revenue column for a CPL campaign, because the registry does not list
`cpl` on those entries. Locked columns cannot be switched off.

### Storage this needs

```
affiliate_column_visibility
  comp_model    ENUM('revshare','cpl')   -- the key the setting hangs off
  column_key    VARCHAR                  -- matches the registry key
  enabled       BOOLEAN
  updated_by    user_id
  updated_at    TIMESTAMP
```

Keyed on comp model rather than on partner, deliberately: the rules that matter are properties of
how a campaign is paid, and per-partner overrides would let someone quietly grant a CPL partner a
revenue column.

### The registry today

| Column key | Label | Group | Comp models allowed | Locked | Status |
|---|---|---|---|---|---|
| `receivedAt` | Received | intake | revshare, cpl | ✓ | **EXISTS** |
| `id` | Lead ID | intake | revshare, cpl | ✓ | **EXISTS** |
| `campaignId` | CID | intake | revshare, cpl | | **EXISTS** |
| `campaignName` | Campaign | intake | revshare, cpl | | **EXISTS** |
| `product` | Product | intake | revshare, cpl | | **EXISTS** |
| `subid` | Sub-ID | intake | revshare, cpl | | **NEEDS BUILDING** — blocking |
| `subidLabel` | Sub-ID name | intake | revshare, cpl | | **NEEDS BUILDING** — blocking |
| `state` | State | intake | revshare, cpl | | **EXISTS** |
| `assetBand` | Investable assets | intake | revshare, cpl | | **PARTIAL** |
| `hourSegment` | Arrival window | intake | revshare, cpl | | derived from `received_at` |
| `dow` | Day received | intake | revshare, cpl | | derived from `received_at` |
| `status` | Status | intake | revshare, cpl | ✓ | **EXISTS** |
| `rejectReason` | Rejection reason | intake | revshare, cpl | ✓ | **EXISTS** |
| `soldType` | Sold type | outcome | revshare, cpl | | **NEEDS BUILDING** — blocking |
| `soldAt` | Date sold | outcome | revshare, cpl | | **EXISTS** |
| `daysToSale` | Days to sale | outcome | revshare, cpl | | derived |
| `saleAmount` | Sale amount | revenue | **revshare only** | | **EXISTS** |
| `partnerShare` | Your share | revenue | **revshare only** | | derived |

**Locked columns** are identity and audit columns an admin may not switch off. `rejectReason` is
locked on purpose: a partner cannot fix what they cannot see, and hiding it recreates the exact
complaint this dashboard replaces.

### Columns that are in no list, for any comp model

These are **absent from the registry entirely**, and absence is the enforcement — there is no
toggle for them and there must never be one:

```
lead_cost · margin · margin_pct · buyer_name · csr_name · call_result
ipqs_score · ipqs_rules_fired · clawback_reason · campaign_cost
```

The July 31 Heritage leak was Profit, Buyer Name, CSR Name and Call Result. Those four stay
forbidden to everyone, revenue-share included.

### The row rule the config cannot express

Column configuration alone is not sufficient, and this is the part that is easy to miss:

For a **CPL** campaign, a rejected lead must show its reason and nothing after it. Two things that
requires beyond the column list:

1. **Null the outcome columns on rejected rows** —
   `CASE WHEN l.status = 'paid' THEN l.sold_type END`, and the same for `sold_at` and
   `days_to_sale`.
2. **Any query filtering *by* sold date must also exclude rejected rows outright** —
   `AND l.status = 'paid'`. Without this the **row count alone** tells a CPL partner we work leads
   we declined, even with every column nulled.

For **revenue share** the opposite holds: they are paid on any sale, accepted or not, so those rows
must be visible or their invoice cannot be reconciled. In the current mock data that is **286
rejected-but-sold leads worth $7,694.**

---

## 4. Spend & volume targets

Affiliate-facing half is mocked (targets card on Performance, dashed target line on Leads by day).
**The admin side does not exist.**

```
partner_targets
  partner_id     required
  campaign_id    optional — settable per campaign or account-wide
  period         calendar month to start with
  volume_target  INT      NULL = not set
  spend_target   DECIMAL  NULL = not set
```

| Rule | Why |
|---|---|
| Either, or, or both | The mock shows both states — Heritage has volume + payout, OptiLabX volume only |
| A null target means *not set*, not zero | It must not render at all, and must not count as a missed target |
| Severity is judged against **pace**, not the monthly total | 14% of a monthly target on day 5 of 31 is on track, not critical |
| A revenue-share payout target is measured on the **sold** date | On the received basis it reports $0 for the first ten days of every month |
| A CPL spend target stays on the **received** date | We owe on acceptance |

Status: **NEEDS BUILDING.**

---

## 5. Coverage asks — the three widgets

### 5a. States we need (unused budget)

| Field | Drives | Status |
|---|---|---|
| per-state monthly `budget` | "Unused budget" column | **NEEDS BUILDING** |
| per-state `filled` / consumed | fill rate → unused | **PARTIAL** — spend exists, not aggregated per state |
| blended CPL | converts unused budget → "leads needed" | **PARTIAL** — hardcoded $90 in the mock |
| state timezone | the Saturday western caveat | **NEEDS BUILDING** |

The widget sorts by unused budget and shows the top rows. In the mock this is `STATE_DEMAND` in
`data.js`. Pacific and Mountain dominate because that is the standing coverage gap.

### 5b. Ideal reception windows

**These are real operating facts and must not be invented in code.** They belong in configuration
so a change in staffing changes the dashboard.

```
Call centre hours
  Mon–Fri   9:00 AM – 7:00 PM local time in every timezone we cover
            (9:00 AM – 10:00 PM ET end to end)
  Saturday  9:00 AM – 8:00 PM ET, lighter staffing
  Sunday    closed

Ideal reception windows (consumer local time, Mon–Fri)
  9:00 – 11:00 AM
  3:00 – 7:00 PM
```

Status: **NEEDS BUILDING** as configuration. Currently `OPERATING_HOURS` / `IDEAL_WINDOWS` in
`data.js`.

> **Two consequences worth carrying into the build**, both open with Courtney:
>
> - **Saturday closes early out west.** 8 PM ET is 5 PM Pacific, so a Saturday afternoon California
>   lead has a much shorter working window than the same lead on a Tuesday. Since Pacific and
>   Mountain are already the standing coverage gap, that argues for weighting the Saturday 8%
>   toward Eastern and Central rather than spreading it evenly.
> - **The 3–7 PM local window does not hold on Saturdays.** For Pacific it collapses to 3–5 PM and
>   for Mountain to 3–6 PM. For a partner running western states, the Saturday *morning* window is
>   the one that works cleanly.
>
> The dashboard shows the second of these as a caveat on the windows widget, but only for partners
> actually running western states.

### 5c. Ideal daily volume split

| Day | Ideal share |
|---|---|
| Monday | 20% |
| Tuesday | 19% |
| Wednesday | 19% |
| Thursday | 19% |
| Friday | 15% |
| Saturday | 8% |
| Sunday | 0% |

Status: **NEEDS BUILDING** as configuration. Currently `IDEAL_DOW_SPLIT` in `data.js`.

### The framing, which is not optional

Every rendering of all three widgets carries this note:

> We accept leads any day and any hour, so none of the above is a restriction. These are the windows
> where our team is working hardest and where leads convert best for us, so weighting your sends
> this way gets faster contact and a better read on your traffic. Saturday runs on lighter staffing,
> and anything landing Sunday sits until Monday morning.

A partner who reads these as gates will send less, not better. The widgets are asks.

---

## 6. Health score inputs

Defined in `assets/js/health.js`. Weights and thresholds are the deliverable; see HANDOFF.md.

| Input | Status | Notes |
|---|---|---|
| margin vs 45% floor | **PARTIAL** | See the $1 phantom COGS problem below |
| Priority/Hot conversion | **NEEDS BUILDING** | Blocked on `sold_type` |
| sold-type points per paid lead | **NEEDS BUILDING** | Blocked on `sold_type`; point values need Michael's sign-off |
| median sales cycle | **EXISTS** | |
| acceptance rate | **EXISTS** | |
| duplicate rate | **EXISTS** | |
| contact-validation rejects | **EXISTS** | |
| bad-contact rate | **PARTIAL** | internal only, never shown to the affiliate |
| clawback rate | **PARTIAL** | internal only |
| **`speed_to_lead`** (seconds, receipt → first dial) | **NEEDS BUILDING** | Operations pillar is **parked** until this lands |
| **`call_attempts_to_convert`** | **NEEDS BUILDING** | Operations pillar, parked |
| state / window / day coverage | **NEEDS BUILDING** | Feeds off §5 |

The parked pillar is **excluded and the remaining three renormalised to 100**, not scored zero.
Scoring it zero would silently cap every partner at 90. Set `parked: false` in `health.js` when the
two fields land and the weights snap back on their own.

### Two data-integrity problems that corrupt the score if not fixed first

1. **The $1/lead phantom COGS on rev-share campaigns.** Every accepted rev-share lead is billed at
   $1 in Lead Cost though we owe $0 per lead — roughly **$4,013** of fabricated cost on Heritage
   alone across two weeks, and about **16,000** rev-share leads system-wide. Any margin-based
   pillar computed on this data is wrong. Must be set to $0 before the Economics pillar means
   anything.
2. **Placeholder birth years on the aged-lead import.** **1,923 of 1,932** accepted leads on the
   Heritage aged-leads campaign carry a YOB of 2000 or 1992 — ages 26 and 34, well outside the
   45–75 criteria, accepted and billed anyway. The age filter is not catching it. Any quality
   pillar reading that campaign is reading noise.

---

## 7. Suppression file

**A suppression file already runs today — automatic, per Logan. Nothing in this section is
confirmed against it yet.** The card on `duplicate-check.html` is the *proposed* affiliate-facing
shape, and the open questions are listed on that page in the internal "needs Sagar" section.
**Talk to Sagar before building any of this** — if the live file differs, the affiliate-facing
version must match it, not compete with it.

| Piece | Drives | Status | Notes |
|---|---|---|---|
| The nightly build itself | everything | **EXISTS** (per Logan) | Mechanics unknown — cadence, format, scope, delivery all unconfirmed |
| Per-affiliate access (auth, logging, rate limit) | the download button | **UNKNOWN** | Who can reach it today? |
| Per-affiliate HMAC key | leak attribution + protection | **UNKNOWN / likely NEEDS BUILDING** | A bare SHA-256 of a phone number is rainbow-tableable in hours; only a keyed hash is real protection |
| 365-day expiry of entries | not over-suppressing | **UNKNOWN** | A grow-only file silently costs affiliates volume they were entitled to send |
| Manifest (generated-at, row count, normalization) | affiliate-side integrity check | **NEEDS BUILDING** | Row count is the cheap truncation check |
| Duplicate-rejection → file write, with cause classification | closing the loop | **NEEDS BUILDING** | See the proposal on `duplicate-check.html`: a duplicate rejection should already be in the file, so each one is evidence of a gap — classify which (not using file / stale copy / normalization mismatch / coverage gap) |
| Duplicate-rate before/after file adoption | measuring whether the file works | **NEEDS BUILDING** | Single most useful metric; duplicates are Heritage's largest rejection reason |

In the mock: `SUPPRESSION`, `suppressionSample()`, `suppressionManifest()` in `data.js`. The
download button serves a small sample with fabricated digests so the format is reviewable.

## 7a. Partnership summary metrics & Targeting page

Added August 6. All derived or config — nothing here needs a new admin-editable field beyond
what §1 and §5 already list.

| Element | Source | Status |
|---|---|---|
| Health gauge (Partnership summary) | the existing health engine, account-wide; click-through to the scorecard | **derived** — same inputs as §6 |
| Average weekly volume | raw leads, trailing 28 days ÷ 4 | **derived** |
| Accepted last 30 days | lead table | **derived** |
| Campaign comp-model label | "Revenue share" / "Tiered CPL" / "Flat CPL" — the **model only**, no rates in the summary table; rates live behind View details | derived from campaign `comp_model` + rate card shape |
| Targeting — call-centre hours, ideal windows, day split | §5b / §5c configuration | **NEEDS BUILDING** as config |
| Targeting — lead criteria per product | standard criteria + the partner's `age_band` override (§1) | age band **NEEDS BUILDING**; the rest is constant criteria that should live in config, not code |
| Targeting — states-we-need widget | §5a state demand | **NEEDS BUILDING** |

---

## 7b. Data quality found in the real export

Every item here is a real finding from `Lead-Report-08-06-26.csv`, not a mock-up artefact.
They are rendered in-app on the Data source page.

| Finding | Evidence | Consequence |
|---|---|---|
| **$1 phantom COGS — confirmed live** | All **41,627** accepted rows carry a non-zero Lead Cost with a median of exactly **$1.00** | Margin is fabricated. The health score's margin input is **excluded** rather than computed on it |
| **Reject Reason is not a controlled field** | **2,917 distinct values.** The tail is raw XML filter responses written into the reason column — ~2,400 rows on Heritage alone | Bucketed on ingest into a `filter_error` category, surfaced to the affiliate as *"Filter response error — our side"* so they are not blamed for our fault. Needs a controlled vocabulary at source |
| **Affiliate name mismatch** | Export says `ObtilabX`; the tracker says OptiLabX | Mapped on ingest. Ungrouped it splits one partner into two |
| **Assets1 is free text** | 29 spelling variants, mojibake dashes, duplicate ranges. **81.6% of all rows sit in the single band `$50 000 - $100 000`** | Parsed to bands on ingest. The concentration is worth investigating — it looks like a default rather than a distribution |
| **Sold but no sold type** | 16 rows marked Sold with an empty Sold Type | Invisible to any tier-based metric |
| **Rev-share rate not in the export** | Revenue Share column holds 40% / 0% / 4% / 1.75%. annuity.org's 85% does not appear at all | Comp model is inferred from campaign name plus the Revenue Share column. **annuity.org therefore reads as CPL and is wrong** — it needs its rate on the campaign record |
| **Sub-IDs almost entirely absent** | 0.4% fill overall. Madrivo 99%; **Heritage and OptiLabX 0%** | Per-publisher scoring is impossible for the two accounts that matter most. The sub-ID card switches itself off with an explanation rather than showing an empty table |

---

## 8. Still unmapped

Things the dashboard shows or will show that have no home yet:

| Item | Note |
|---|---|
| Duplicate-check rate limiting | Per partner per day, plus a query log with partner ID. This is a suppression-list API in disguise — a partner who can query without limit can enumerate the database one number at a time |
| Google Drive export | Needs a Drive OAuth scope per partner, a service account, and a destination folder convention. **None of it exists**; the CSV path is the only real one |
| Setup-flow scope | Needs confirming with Michael, and scoping against Marc Heberling's automated pixel-validation work — this should be the affiliate-facing front end to his backend, not a second implementation |
| Module F — internal Lead Activation view | Courtney's screen: call attempts, dispositions, queue state, affiliate-submitted nurture leads. Phase 2 |
| Real logo asset | `BRAND_MARK` in `app.js` is a geometric placeholder |
