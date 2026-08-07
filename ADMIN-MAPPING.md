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

> **The same list is browsable in the prototype.** `assets/js/handoff.js` holds it as data, and
> two internal pages render from it: **Data connections** (`data-source.html`) for the field
> side, **Admin settings** (`admin-preview.html`) for the settings side. They read one registry
> so the two halves cannot drift apart. Delete all three before shipping.

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
| A9 | **Unfire feed** — unfire date, affiliate-safe reason code, amount credited *(Sagar)* | Clawback report on the Compensation page | **MISSING.** The export carries only the `returned` flag |

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
| B10 | **Per-user table preferences** | Which columns a user shows/hides, column widths, and their chosen sort | Every table is sortable, resizable and column-configurable. The mock persists this to `sessionStorage`, so it survives paging but dies with the tab. In production it should be a **stored user preference** on `affiliate_users` (see §1a) — a media buyer who hides six columns expects them to stay hidden next login |
| B11 | **`documents` table** | The Helpful documents section on Setup & docs | Must support adding and re-linking documents **without a deploy**. §7c |
| B12 | **Per-affiliate agreement URL** | The "Your agreement" card | A Google Doc URL on the affiliate record, different for every partner. An affiliate with none set renders "not linked yet", never a dead button. §7c |
| B13 | **Per-affiliate lead criteria** | Every criteria line on Targeting, and the age wording in rejection labels | The OptiLabX 45–79 band already proves criteria are negotiated per account. **Any** criteria value may differ, not just age. §1 |
| B14 | **Comp model as a real campaign column** | The entire column projection | Currently parsed out of the campaign *name*. This is the most load-bearing value in the system and it is being inferred from a string. §2 |
| B15 | **Monthly lead-statement URL per affiliate** | Lead statements on the Compensation page | A Google Sheet URL per affiliate per month, pasted by the admin after the statement is generated (first business day after month close, give or take). A month with none renders "Not linked yet", never a dead button. §7e |

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

### The fidelity rule — a cell shows the system's own value

Added Aug 6, and it applies to **every table in the portal, not just this one.**

**A cell renders the value the system actually recorded, verbatim.** Rejection reason shows
`Duplicate`, `IPQS`, `Age Filter` — the exact strings out of the reject-reason column, not a
prettied-up paraphrase. Same for state, campaign, sold type, dates and amounts.

The reason is reconciliation. An affiliate disputing an invoice, or Zakira comparing this portal
against a report cut straight from the database, has to be able to match rows **cell for cell**.
The moment the portal renders "Failed contact validation" where the system says `IPQS`, every
comparison becomes a translation exercise and the portal stops being usable as evidence.

**Where a value needs explaining, the explanation goes in a hover descriptor, not in the cell.**
See the descriptor rule below.

**The one documented exception** is the XML-payload rows described in §7b: those have no usable
system value, so they fall back to a plain-language bucket label. When the reject-reason column is
cleaned up at source, that fallback stops firing on its own.

### The descriptor rule — explain on hover, not in the label

Also Aug 6, also portal-wide. Anything that needs explaining — a column header, a status badge, a
metric name, a rejection reason, a pillar name — carries a small **i** button to its right.
Hovering or keyboard-focusing it shows a short box. The label itself stays short.

`FZApp.tip(text)` returns the button; `wireTips()` in `app.js` manages one shared, fixed-position
box for the whole page. Fixed positioning is deliberate — descriptors live inside horizontally
scrolling tables, and an absolutely-positioned box gets clipped by them.

This exists because the alternative loses both ways: labels long enough to explain themselves make
tables unscannable, and labels short enough to scan leave partners guessing. It also keeps the
fidelity rule above workable — the cell can say `IPQS` *and* the partner can find out what that
means, without the two requirements fighting.

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

## 4. Spend & volume targets — CPL ONLY

**Confirmed by Logan, Aug 2026: revenue-share partners get no target at all.** They can send as
much or as little volume as they want — more is generally better to us, but nothing here governs
them. Their only governance mechanism is the lead health score, which already exists. Every
function in the engine (`assets/js/data.js`) returns `null` immediately for a revenue-share
partner rather than computing a number nobody asked for. This table, and everything below it,
applies to CPL campaigns only.

Affiliate-facing half is mocked (targets card on Performance, per-day dashed reference on Leads by
day) and the admin side is mocked as a read-only illustration on `admin-preview.html`. **Neither
half has real storage or a real input form yet.**

### The core relationship: margin and CPL are the same lever, twice

```
margin = (R − CPL) / R          CPL = R × (1 − margin)
```

`R` is our expected revenue per **accepted** lead — a trailing, internal-only figure computed from
matured sold outcomes (`revenuePerAcceptedLead()`). It never reaches the affiliate side of the
query layer, same as margin itself never does. Admin sets **either** a target margin **or** a
target CPL; whichever field was last edited is treated as the source of truth and the other is
recomputed from it — never the reverse, which is what makes "either/or" well-defined instead of a
fight over which stale number wins.

Volume and spend are the **second** either/or pair, linked through the derived CPL:
`Spend = Volume × CPL`. **Volume is defined in accepted leads**, matching how CPL is actually
invoiced — not raw submitted, which would need a separate acceptance-rate assumption this design
deliberately avoids. (`R` and target CPL are internal/derived; `target_cpl` is a *planning* figure
and is a distinct field from a campaign's actual contracted `cpl_rate` — the admin screen shows
both side by side so a gap between "what we're planning to" and "what we're actually paying" is
visible, not silently absorbed.)

### Mixed accounts (added Aug 7)

Targets are a CPL construct, and on an account that also runs revenue-share campaigns the
counting must respect that: `cplWeeklyProgress()` **filters its accepted-lead counts to CPL
campaigns**, and the per-day target ticks on the volume chart render only when the scope is
pure CPL (`cplScopeIsPure()`), because the chart compares the target against its own
scope-wide accepted counts. A rev-share lead must never make a CPL target look on-pace. The
full set of mixed-account rules is in HANDOFF.md ("THE MIXED-ACCOUNT CONTRACT").

### Cadence: weekly, not monthly

Targets are **Sunday–Saturday weeks**, matching the real Friday-night budget-distribution cadence
— not calendar months, which the first version of this mock incorrectly assumed.

### Daily figure: day-of-week weighted, Sunday defaults to 0

The reference mark on the affiliate's "Leads by day" chart is **not one flat number**. It is the
weekly volume target × that day's share of a day-of-week split, so the day pattern is visible on
the chart itself — Sunday sits at zero unless a partner's split is explicitly overridden, every
other day gets its own dashed tick rather than a single misleading horizontal line. Default split
is the company-wide `IDEAL_DOW_SPLIT` already used on the Targeting page (Sun 0% / Mon 20% / Tue–Thu
19% / Fri 15% / Sat 8%), overridable per partner.

### Storage this needs

```
partner_targets                              (CPL comp model only)
  partner_id             required
  campaign_id            optional — NULL = account-wide; per-campaign targets share this shape
                          but the mock only builds the account-wide picker
  week_start             DATE, the Sunday the week begins
  target_margin_pct      NUMERIC  NULL = not set — INTERNAL ONLY, never affiliate-visible
  target_cpl             NUMERIC  NULL = not set — affiliate-visible; synced with margin via R
  target_volume          INT      NULL = not set — ACCEPTED leads; either/or with spend
  target_spend           NUMERIC  NULL = not set — either/or with volume
  revenue_per_lead_override  NUMERIC NULL — admin override of the auto-computed R
                                            (e.g. an anticipated price change), INTERNAL ONLY
  updated_by, updated_at

partner_dow_weights                           (optional override; default = company IDEAL_DOW_SPLIT)
  partner_id             required
  weights                NUMERIC[7]           index 0 = Sunday, matching Date#getDay()
```

| Rule | Why |
|---|---|
| Revenue share gets no target, ever | Confirmed above — they are governed by the health score only |
| A null target means *not set*, not zero | Must not render at all, and must not count as a missed target |
| Target margin is never shown to the affiliate | Same redaction rule as margin everywhere else in this system |
| `R` (revenue per accepted lead) is internal only | It is derived from `saleAmount`, deliberately **not** `lead_cost` — see the $1 phantom COGS problem below, which would corrupt any figure that touched it |
| Severity is judged against **pace within the week**, not the weekly total | 14% of a weekly target on day 1 of 7 can still be on track |
| A minimum matured sample gates `R` | Below ~20 matured accepted leads the trailing average is not reliable enough to derive a CPL from — the mock's threshold is `MIN_SAMPLE = 20`, tune with real volume |

Status: **NEEDS BUILDING** — both the storage and a real (non-inert) admin form.

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

**The affiliate sees state names only — a top-10 list, nothing else.** Changed Aug 6. The unused
budget, the fill rate and the implied "leads needed" are all internal: they tell a partner how
much money is sitting unspent, which is our negotiating position, not theirs. The ranking is
computed from them; only the ranked names are projected.

**This list changes often.** It needs to be genuinely easy to reorder in the admin — a deploy per
change means it will go stale, and a stale list is worse than none because partners will chase
states we no longer need.

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

## 6. Health score inputs — v2 (redesigned Aug 7 with Logan, against Michael's criteria)

Defined in `assets/js/health.js`. The design decision and the reasoning are in HANDOFF.md
("DECISION — Lead Health Score v2"); this section is the connection list.

**Four pillars, affiliate-visible, built ONLY from what the affiliate controls:**
Conversion & value 40% · Delivered quality 35% · Compliance & trust 15% (also a **gate** — a
critical failure caps the score at 45) · Consistency & coverage 10%.

**Deleted from v1, permanently:** the Speed & operations pillar (`speed_to_lead`,
`call_attempts`) — those measure OUR call floor, not their traffic; they are internal ops
diagnostics for Module F. And the hidden margin input — margin moved to the **internal overlay**
(rendered beside the score on the Data connections partner table), never in the score. Do not
rebuild either into the affiliate-facing number.

| Input | Pillar (weight within) | Status |
|---|---|---|
| Priority/Hot conversion, of accepted, matured cohort | Conversion (45%) | **EXISTS** |
| Share of sales in top tiers | Conversion (20%) | **EXISTS** |
| Sold rate of accepted | Conversion (20%) | **EXISTS** |
| Median sales cycle | Conversion (15%) | **EXISTS** |
| Bad-contact rate | Quality (24%) | **NEEDS BUILDING** — the call-outcome feed (wrong number / disconnected / unreachable per lead → rate). The strongest leading indicator in the score; parked until it lands |
| Contact-validation (IPQS) reject rate | Quality (22%) | **EXISTS** |
| Duplicate rate | Quality (20%) | **EXISTS** |
| Acceptance rate — **banded** | Quality (20%) | **EXISTS.** Banded (≥p50 full credit, steps down), never continuous — a continuous score invites trimming profitable volume for a vanity rate |
| Acceptance stability (8-week std-dev) | Quality (14%) | **EXISTS** — account-level only; campaign-grain is too noisy to judge anyone on |
| Consent-cert coverage | Compliance (30%) | **NEEDS BUILDING** — §6a |
| Complaint incidents (90d) | Compliance (30%) + gate | **NEEDS BUILDING** — §6a |
| Creative-review currency | Compliance (25%) + gate | **NEEDS BUILDING** — §6a |
| Unsubscribe compliance | Compliance (15%) + gate | **NEEDS BUILDING** — §6a |
| Day-to-day pacing (CV) | Consistency (55%) | **EXISTS** |
| Volume in needed states | Consistency (45%) | **EXISTS** — feeds off §5a |
| Send-window fit | Consistency (parked) | **BLOCKED on A1** (time of day) |

### The scoring mechanics the build must copy exactly

1. **Percentile calibration.** Every metric scores as a percentile of our own book, per
   **campaign class** (fresh annuity / aged annuity / life) — never one global benchmark, or
   partners get punished for running the aged campaigns we asked for. Pools come from a
   **stored calibration table recomputed quarterly by a job** — never per request; a partner's
   score must not move because someone else's traffic shifted mid-week. Small class pools
   still win over the global pool (a self-referential benchmark is honest; a cross-class one
   is unfair).
2. **The campaign is the scoring unit.** Conversion + quality are scored per campaign against
   its class, the account rolls up volume-weighted. Consistency and compliance are
   account-level.
3. **Shrinkage.** Rates are pulled toward the class median — (n·v + K·median)/(n + K), K=100
   on conversion (matured-accepted denominator), K=50 on quality (raw denominator) — so small
   partners aren't whipsawed by variance.
4. **Missing data is excluded and renormalised, never scored zero.**
5. **Provisional** below 100 matured accepted leads (account and per campaign).
6. **Early-warning flags are separate from the score**: last-7-days duplicates / IPQS /
   acceptance vs the partner's own trailing 8-week baseline. Flags detect fast; the score
   judges slow. Never blend them.

### 6a. Compliance system — spec for the tech team (Logan is handing this off)

The pillar and gate run on four inputs, all null in the mock (deliberately — these are real
affiliate names; nothing is fabricated against them). `D.complianceFor(partnerId)` is the read
interface the engine already calls; build the storage behind it:

```
compliance_incidents
  id, affiliate_id, campaign_id NULL, type            -- 'tcpa','dnc','platform','other'
  severity ENUM('critical','minor'), occurred_at, resolved BOOL, notes, entered_by

affiliate record additions
  creatives_current  BOOL NULL     -- running set on file with Jefanie; set FALSE when they
                                   -- change creatives without re-sending (setup-flow policy)
  unsub_ok           BOOL NULL     -- email affiliates: opt-out links live and correct

lead record addition
  consent_cert_url   VARCHAR NULL  -- capture xxTrustedFormCertUrl through from the post;
                                   -- LP-path leads carry it from our own forms
```

Rules: **manual admin entry first** — an incident Logan types in caps the score the same week;
enforcement does not wait for automation. NULL means *not collected* and parks the component;
FALSE means *failing* and arms the gate. The gate caps the total score at **45** and is not
launderable by any other pillar.

### Two data-integrity problems that corrupt the score if not fixed first

1. **The $1/lead phantom COGS on rev-share campaigns.** Every accepted rev-share lead is billed at
   $1 in Lead Cost though we owe $0 per lead — roughly **$4,013** of fabricated cost on Heritage
   alone across two weeks, and about **16,000** rev-share leads system-wide. Any margin figure
   computed on this data is wrong. Must be set to $0 before the **internal margin overlay**
   (margin no longer feeds the score itself — see above) means anything.
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
| Targeting — states-we-need widget | §5a state demand, **top 10, names only** | **NEEDS BUILDING** |

---

## 7c. Documents — Setup & docs page

Added August 6. The Setup page is a hub: two campaign actions (both **placeholders** pending
Logan's spec), a document library, and the account-manager contact.

| Element | Source | Status |
|---|---|---|
| Document list | `DOCUMENTS` in `data.js` | **NEEDS BUILDING** — `documents (key, label, description, url, scope, sort_order, featured)` |
| Affiliate onboarding, Lead criteria, Annuity API, Life API | one global URL each | **NEEDS BUILDING** as rows in that table. Lead criteria already has its real URL — see below |
| **Full-criteria doc URL** | `CRITERIA_DOC_URL` in `data.js` — **one constant read by both** the Targeting page's "View full criteria" link and the document library's Lead criteria card, so the two cannot point at different versions | **LIVE URL in the mock** (Logan's Google Doc). Note the doc is the **standard** criteria — negotiated per-account terms (the OptiLabX 45–79 band) render in the Targeting chips, which is why the chips stay even though the doc exists |
| **Creatives (Targeting page)** | `CREATIVE_LINKS` in `data.js` — three admin-set URLs: example annuity creatives, example life creatives, creative guidelines | **NEEDS BUILDING** — three URL settings (or rows in the `documents` table with a `creatives` scope). All three are **null in the mock** and render a "not linked yet" modal, never a dead button |
| **Your agreement** | a **different URL per affiliate** | **NEEDS BUILDING** — a Google Doc URL field on the affiliate record |
| New / edit campaign flows | — | **NOT SPECIFIED.** Placeholder modals pointing at Logan until he defines the flow |
| ~~Test lead sandbox~~ — **REMOVED Aug 7** | was `sandboxCheck()` in `data.js` | Built Aug 6, removed on Logan's call the next day: checking a hand-typed lead against acceptance criteria is not something affiliates need. **What Logan actually wants in this slot is a PIXEL TEST** — a tool that verifies the tracking pixel fires correctly on the affiliate's landing page. Not built; when it is scoped it should be the affiliate-facing front end to Marc Heberling's pixel-validation work (see §8), not a second implementation |
| Contact block | Logan Randall, logan@financialize.com | constant; should join from the CRM like §1's account manager |

Two rules the implementation has to keep:

1. **Adding a document must not require a deploy.** The page renders whatever rows exist. If the
   team has to file a ticket to publish a PDF, the library will not be maintained.
2. **A document with no URL renders "not linked yet", never a dead button.** `scope: 'partner'`
   documents are unset for most affiliates on day one, and a button that 404s reads as a broken
   portal rather than an unfinished record.

---

## 7d. Campaign setup flow — `campaign-setup.html`

Added August 7. Onboarding steps 6–10 as a **per-campaign tracker**. The framing decisions, all
Logan's:

- **Steps 1–5 (traffic type, comp model, integration method, agreement, campaign IDs) happen in
  conversation with Logan before portal access exists.** Access is granted after step 5, so the
  portal only ever *reflects* those decisions and the tracker starts at "complete setup for your
  integration method."
- **The flow is per campaign** — an affiliate running three campaigns places three different
  pixels. Each campaign's tracker branches on its own integration method.
- **The ONE affiliate-editable field in the entire flow is the conversion pixel URL** (landing-page
  campaigns). CPL, comp model, targets, product, traffic source — all read-only, changed only
  through Logan.
- **Zero campaigns** renders one plain sentence — *"There are no active campaigns on this
  account."* — no setup prompt, since Logan sets campaigns up before login exists.
- **Every step carries an owner** (you / us / both) and the UX contract is: a partner glancing at
  the tracker knows whose court the ball is in.

Steps per path (sources: Onboarding packet V7.16.26, LP & Pixel Guide V7.14.26, the two API docs):

| Path | Steps |
|---|---|
| Landing pages | Tracking link (with parameter picker) → **place pixel** (required for rev share, skippable for CPL) → creatives review → test leads (**one accepted AND one deliberately rejected** — pixel must fire on the first and stay silent on the second; testing through the affiliate's own tracking link is fine so long as it lands on the test URL with test values filled; first name `dev_test`, ZIP 99996, unique email+phone; both-sides confirmation) → go live |
| API | CID + docs → build integration (headers, exact option text, Consumer Blocked) → creatives review → test lead (posts to production; response says accepted/rejected) → go live |

| Field / element | Source in mock | Status |
|---|---|---|
| `campaign.integration_method` (`lp` / `api`) | deterministic stand-in in `integrationMethodFor()` | **NEEDS BUILDING** — admin field on the campaign. Not in the export. The tracker branches entirely on it |
| `campaign.traffic_source` (`email` / `non_email`) | parsed off the campaign name (`[Non-email …]`) | **NEEDS BUILDING** as a real field; name-parsing is the same fragility as comp model |
| `campaign.tracking_url` / `test_url` | placeholder URLs built from product domain + CID | **NEEDS BUILDING** — admin generates these today via the campaign listing's Tracking URL button; the portal needs them stored on the campaign record |
| **`campaign.pixel_url`** — the affiliate-writable field | sessionStorage via `saveSetupState()` | **NEEDS BUILDING** with an **audit trail**. We install it as the 1×1 iframe on the thank-you page (Pixel Code → Thank You Page), gated to accepted leads. Changing it after go-live notifies Logan and is re-verified with a test lead before taking effect. Multiple pixels = multiple iframes, added by us |
| `campaign_setup` step states | `campaignSetup()` + sessionStorage | **NEEDS BUILDING** — `(campaign_id, step_key, state, updated_by, updated_at)`. Admin sets every state except the pixel submission and the affiliate's "sent" claims; test-lead confirmation can auto-set from an actual received test lead (first name `dev_test`, ZIP 99996) |
| **Tracking-URL parameter list** | `TRACKING_PARAMS` in `data.js` — 25 keys in 5 groups, checkbox picker on the tracking step; **all off by default**, ticking a key adds it to the generated URL | **NEEDS CONNECTING** — the key list belongs to the **tracking system**: the admin's Tracking URL generator (campaign listing → Tracking URL button) selects from the same set. The portal must read that source, not carry its own copy, or the portal will offer keys the system drops. Per-affiliate selection is a client-side convenience; nothing needs storing |
| **Test-lead conventions** | `TEST_LEAD` in `data.js` — first name `dev_test`, ZIP `99996`, unique email+phone per test | **LIVE VALUES**, but they are SYSTEM routing values — if the test ZIP or the dev_test convention ever changes in the intake system, this constant must change with it. Should live in config, one source for both sides |
| **API required-field lists** | `API_SPECS[product].required` — every required field per product, rendered as a table on the integrate step | Transcribed from Lead Submission API V5.22.26 and the Life Lead POST API doc. **The linked doc is the spec** — when either doc revs, this list must rev with it. Ideally generated from the same source as the docs |
| Unsubscribe links | `UNSUB_LINKS`, CID substituted per campaign | **LIVE VALUES** (global per product line). Rendered only on email-traffic campaigns |
| API endpoints + required-field summaries | `API_SPECS` | **LIVE VALUES** from the two API docs. The summary is orientation; the linked doc is the spec — keep them from drifting |
| Compliance contact | `COMPLIANCE_CONTACT` — Jefanie Genilla, jgenilla@financialize.com, CC Logan | constant; creative policy: build and iterate freely, every creative reviewed before running, **re-send the current set on every change** |
| Demo campaigns | `SETUP_CAMPAIGNS` — one synthetic in-setup campaign each for Heritage (LP path) and OptiLabX (API path) | **MOCK ONLY.** Not in `CAMPAIGNS`, so queries, filters and metrics never see them. Delete when real setup records exist |

---

## 7e. Compensation page

Added August 6. Money in one place: what the window earned, the billing terms, the monthly
statements, and the clawback record. Reached from the sidebar or by clicking the Billing details
card on the Partnership summary.

| Element | Source | Status |
|---|---|---|
| Earned this period | `payoutForWindow()` — rev-share summed on the **sold** date (rejected-but-sold included, per the Aug 5 ruling), CPL on the **received** date × the campaign rate | Computed from the lead table; CPL needs the **rate card on the campaign record** (A4 / B14 adjacent) or it reports "not on file" rather than $0 |
| "Subject to change" caveat | static copy + hover descriptor | The number is provisional until the statement closes; audits run weekly |
| Billing details card | same fields as the Partnership summary — `billing_period` / `billing_basis` (B3) + billing contacts | duplicated rendering, single source |
| Lead statements list | one Google Sheet URL per affiliate per month, admin-pasted | **NEEDS BUILDING** — B15. Generated on the first business day after month close; unlinked months show "Not linked yet" |
| Clawback report | `queryClawbacks()` — unfire date, affiliate-safe reason, credited amount | **NEEDS BUILDING** — A9, the unfire feed (Sagar). Reason must map to the `RETURN_REASONS` vocabulary; the internal `clawback_reason` stays forbidden |

Rules the implementation must keep:

1. **Membership comes from the unfire record itself, never inferred.** In the export that is
   the `returned` flag — and unfiring flips the lead's paid flag back off, so an unfired lead
   renders as *Rejected* in the lead table with no visible trace of ever having been billed.
   That silent disappearance is the reconciliation gap the report closes. Heritage alone
   carries 335 returned rows, none sold — the flag is our audit's removal, not a buyer's
   return. Leak check: a row here says only "removed from billing"; no sold-derived field is
   projected, so the CPL row rule holds.
2. **The affiliate-facing reason is a controlled, affiliate-safe vocabulary** (`RETURN_REASONS`
   in `data.js`): outside criteria, duplicate, invalid contact, consumer request. Never the
   internal clawback reason, never anything about margin, buyers, or call outcomes.
3. **Statement months attach to the partner record, not a deploy** — same pattern as the
   per-affiliate agreement URL (B12).

---

## 7b. Data quality found in the real export

Every item here is a real finding from `Lead-Report-08-06-26.csv`, not a mock-up artefact.
They are rendered in-app on the Data source page.

| Finding | Evidence | Consequence |
|---|---|---|
| **$1 phantom COGS — confirmed live** | All **41,627** accepted rows carry a non-zero Lead Cost with a median of exactly **$1.00** | Margin is fabricated. The health score's margin input is **excluded** rather than computed on it |
| **Reject Reason is not a controlled field** | **2,917 distinct values**, of which only **21 are clean labels**. The tail is raw XML filter responses written into the reason column — **2,713 rows** | Two fields are now emitted: the **exact system string** (rendered verbatim in the lead table and CSV so an affiliate's export reconciles 1:1 against ours) and a **bucket** for grouping. The XML rows have no usable exact value and fall back to the bucket's plain-language label — they are surfaced as *"Filter error — our side"* so the affiliate is not blamed for our fault. Needs a controlled vocabulary at source |
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
