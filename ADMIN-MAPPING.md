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
| A5 | **Controlled `reject_reason` vocabulary** | The whole rejection breakdown, the reason filter on the lead table, every drill-down link | **BROKEN — and now specified.** 2,917 distinct values; the tail is raw XML filter responses. `REJECT_REASONS` in `data.js` is the proposed target vocabulary — see §3a. **The affiliate-facing list must become the internal list, exactly**, so a reason added or renamed internally needs no translation layer here |
| A10 | **Split `IPQS` into the check that actually failed** — phone / email / other | The largest single reason on the book being actionable at all | **MISSING.** IPQS is one undifferentiated bucket carrying **12,178 of 23,430 rejections (52%)**. IPQS returns the specific failing check and we discard it on ingest. Three keys are already in the registry (`ipqs_phone`, `ipqs_email`, `ipqs_other`) rendering at zero until this lands |
| A12 | **A true consumer-submission timestamp, distinct from the import/`Created On` date** | The three Delivery timing components in Delivered quality, and the Top conversion windows card | **BROKEN — and it currently scores US.** On bulk-imported aged leads `Created On` is the date WE loaded the file, not when the consumer submitted. Heritage campaign 600 is **55,481 of that account's 56,309 leads in the trailing cohort and lands 0/0/0/30/59/12/0 across Sun–Sat, 100% in the last third of the month.** That is our import schedule, not their delivery behaviour. Fresh drip traffic reads normally by comparison — OptiLabX 0/17/17/23/21/15/6, phases 39/31/30 — which is how we know the metric itself is sound. **Two fixes needed:** carry the real submission timestamp, and flag bulk-imported rows so timing scoring can exclude them |
| A11 | **A distinct reason for blank / null required fields** | Telling "nothing was posted" apart from "a value was posted and failed a check" | **MISSING.** `missing_fields` is in the registry at zero. The two have different fixes — one is a required-field rule at the form, the other is validation — so collapsing them makes the fix column wrong |
| A6 | **`lead_cost` = $0 on rev-share** | Any margin metric | **BROKEN.** All 41,627 accepted rows bill $1.00 — the phantom COGS, confirmed live |
| A7 | **Normalised `assets` band** | Asset-band targeting widget | **PARTIAL.** 29 free-text variants; 81.6% collapse into one band |
| A8 | **`sold_type` on the 16 Sold rows missing it** | Tier metrics completeness | **PARTIAL** |
| A9 | **Unfire feed** — unfire date, affiliate-safe reason code, amount credited *(Sagar)* | Pixel unfire report on the Compensation page | **MISSING.** The export carries only the `returned` flag. Related: the `filter_error` rows in A5 are manual pixel unfires and belong on this feed, not in the rejection list |

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
| B12 | **Per-affiliate agreement URL** | The "Your agreement" card | A Google Drive URL on the affiliate record, different for every partner, pasted by the admin when the agreement is signed. An affiliate with none set renders "not linked yet", never a dead button. **Restricted sharing — the Drive share list, not the link, is the access control.** Workflow and rules in §7c |
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
| **Geography (state) performance** | The **States** card on the Targeting page (merged with per-state demand, §5a) | **EXISTS** | Built from `state` on the lead, scored on the matured cohort like every other rate on that page. Ranked by **volume, not rate** — a 100% rate on three leads is noise and must not head the list. *Room for more* is `isCoverageState()`, an ask and never a gate, so `COVERAGE_NOTE` rides with it |
| **Campaign health score** | Health score column in the Active campaigns table (Partnership summary) | **COMPUTED — no storage** | Not a stored field. Read from `FZHealth.score().campaigns[]`, the same engine run that draws the account dial on that page, so the itemised column and the dial can never disagree. Needs the score-calibration table (§6) like every other score surface; nothing extra. A campaign in setup, or one with no matured leads, renders `—` and must **never** render `0`. **Rendering:** the number alone, coloured from the **meter ramp** (`--meter-fill*`, picked with `FZHealth.meterClass()` — the same function that colours the dial), with the band name in a hover bubble beside it. No band badge in the cell. Two constraints on any change: the number stays **≥18.66px bold** so WCAG's large-text 3:1 floor applies (`--meter-fill-warning` is 4.10:1 on white and fails the 4.5:1 body-text floor), and the bubble stays a real focusable control so the band is reachable without colour or hover |

---

## 2b. "Not connected yet" — how the UI says it has no data

Added Aug 18. **Every field in this dashboard is a backend connection.** The prototype currently
reads a lead export because that is what exists during testing, but production connects to the
system directly, and **no partner-facing surface may mention the export.**

The rule for the build: a field with no source **renders blank with a not-connected note**, and
populates on its own once the field is wired. No copy change is needed at connection time, and
nothing renders a zero or an invented value in the meantime.

| Surface | Before | Now |
|---|---|---|
| Partnership summary — Partner since | "not in the export" | blank + *"not connected yet…"* |
| Compensation — unfire date / reason / amount | "The lead export carries only a returned flag" | blank columns + one note saying the feed is not connected |
| Compensation — CPL rate not on file | "No rate card is on file for this campaign in the mock" | *"not connected yet… ask your account manager"* |
| Targeting — hour of day | "Our lead export records the date but not the time" | *"Not connected yet… fills in on its own"* |
| Setup — document list | "Build note. This list is admin-managed…" | what a partner does about a missing document |
| Account | "Mock-up — edits persist in this browser tab" | *"Changes here are not saved yet"* |

Implementation notes for the dev team:

- `FZApp.notConnected(what)` is the shared cell treatment; `FZApp.NOT_CONNECTED_TEXT` is the plain
  string. Use them rather than writing new wording.
- **Do not branch partner copy on `usingRealData()`** — production is neither source. Test whether
  the *data* is present. The unfire columns now do this: `feedLive` checks whether any row came
  back with a date or reason.
- Unconnected values are **`null` in `data.js`**, not placeholder strings.
- Exempt: this document, HANDOFF, `admin-preview.html`, `data-source.html`, and any `.is-internal`
  card. Those exist to name the source.

---

## 2c. Priority & Hot by month — the long view

Added Aug 19, from the team's existing month-over-month workbook so the two reconcile.

**Twelve calendar months, always — this card ignores the date picker on purpose and says so in its
own subtitle.** Every other rate on the Performance overview is bounded by the filter or by the
fixed 30-day matured cohort; this one answers "is the account trending up or down", which needs a
horizon no picker on that page offers. Campaign and sub-ID scope still apply. This is the one
allowed exception to §5a — it works because the card names its own window rather than silently
ignoring the filter.

| Field | Source | Status |
|---|---|---|
| Leads per month | `receivedAt`, per calendar month | **EXISTS** |
| Priority / Hot conversions per month | `sold_type` | **EXISTS** — but see the blocking dependency on distinct tier labels |
| More than ~3 months of history | the backend | **NEEDS CONNECTING.** The test export spans 66 days, so the card renders what it has and says how much that is |

### Three conventions the build must copy

1. **Denominator is every lead received that month, accepted or not.** Deliberately the workbook's
   definition, so the dashboard and the spreadsheet reconcile line for line. It is *not* the
   matured-cohort basis the health score uses — different question.
2. **Month-over-month change is in PERCENTAGE POINTS.** A rate moving 5.8% → 12.7% is
   **+6.9 points**, never "+119%". The second is arithmetically true, unreadable, and explodes on
   small denominators.
3. **A month with no leads is absent, not zero.** Plotting 0% for a month we hold no data on draws
   a collapse that never happened. Leading empty months are trimmed from the chart; gaps *between*
   months with data are kept, because those are real.

**The current month is marked "still in progress"** — drawn dashed, and given no month-over-month
figure. It is still taking leads and its recent ones have not had time to sell, so its rate is a
floor rather than a result.

**Rates are the lines; change is a number.** Plotting the change itself would oscillate around zero
and hide the level — you could not tell a good month from a bad one, only that it moved. The two
rate lines carry the level and the slope between points *is* the change; the exact figure lives in
the table view and the hover.

## 3a. Rejection reasons — the vocabulary, and who owns it

Added Aug 18. Source of truth in the prototype: **`REJECT_REASONS` in `assets/js/data.js`**,
rendered by the *Why leads were rejected* card on the Performance overview.

**The rule: the affiliate-facing list IS the internal list.** One code, one meaning, both sides.
No mapping table, no display-name layer — those drift, and a drifted reason is one an affiliate
argues with an invoice about. If a reason is added, renamed or retired internally, it changes here
and nowhere else. The registry in `data.js` is a **proposal for that internal vocabulary**, not a
mirror of one; it needs the tech team's sign-off before it is real.

**The catalogue is the spec, not the screen.** The table on the Performance overview lists only
reasons with leads in the selected window, biggest first, flat — a partner reading it wants to know
what went wrong with the traffic they actually sent, not a tour of checks that did not fire. This
table below is the full target vocabulary and is what the tech team builds against.

| Key | Affiliate label | Group | Populated today? |
|---|---|---|---|
| `ipqs_phone` | Phone did not validate | Contact validation | **No — A10** |
| `ipqs_email` | Email did not validate | Contact validation | **No — A10** |
| `ipqs_other` | Other validation failure | Contact validation | **No — A10** |
| `ipqs` | Contact validation (unsplit) | Contact validation | Yes — **retire once A10 lands**, do not rename |
| `missing_fields` | Required field blank | Lead data | **No — A11** |
| `contact` | Lead data not valid | Lead data | Yes |
| `age` | Age | Campaign criteria | Yes |
| `assets` | Investable assets | Campaign criteria | Yes |
| `income` | Household income | Campaign criteria | Yes |
| `state` | State | Campaign criteria | Yes |
| `advisor` | Financial advisor | Campaign criteria | No |
| `interest` | Not interested | Campaign criteria | No |
| `consent` | Consent missing | Compliance | No |
| `duplicate` | Duplicate | Exclusivity | Yes |
| `filter_error` | Pixel manually unfired | **Not a rejection** | Yes — see below |

### Three things the implementation must not get wrong

1. **`IPQS` must be split (A10).** It is 52% of all rejections and, as one label, tells an
   affiliate nothing about whether to fix phone capture, email capture, or their traffic source.
   IPQS already returns the failing check; we collapse it on ingest. The aggregate `ipqs` bucket
   exists only as the landing pad until the split is wired — when it is, `ipqs` **disappears from
   the list**, it is not renamed into one of the children.

2. **`filter_error` IS NOT A REJECTION.** 2,713 rows on the current export carry an unmappable
   value in the reason column. It is us manually unfiring the pixel on a lead we had already
   accepted, after the fact. On screen it renders as *"Pixel manually unfired"*, in its own
   row pinned to the bottom of the list, **excluded from the rejected total and from every share** —
   the share cell reads `n/a`, not a percentage, and it is left out of the chart entirely. Logan expects it to vanish once the reason column is
   controlled; if it survives into the new database it belongs on the **unfire feed (A9)** and the
   Pixel unfire report, not here. Never present it as a lead-quality failure.

3. **Blank is not invalid (A11).** A field that arrived empty and a field that arrived with an
   unusable value are different reasons with different fixes. `missing_fields` vs `contact`.

### Where the reasons are used

| Surface | Behaviour |
|---|---|
| *Why leads were rejected* table | Non-zero reasons only, flat, biggest first. `filter_error` is pinned last with an `n/a` share. Every row links into the lead table filtered to it |
| *Why leads were rejected* chart | Ranked horizontal bars, real rejections only, name + count + share drawn on each row. Clicking a bar drills through the same way |
| Lead table **Rejection reason filter** | `?reason=<key>`, built from `REJECT_ORDER` — a reason added to the registry appears in the filter with no other change. Implies rejected rows; CSV export honours it |
| Lead table **cell** | Still renders the **exact system string** verbatim (§3 fidelity rule), with the bucket's explanation on hover |

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

### 5a-ii. Page split — where a card lives, and why

Reorganised Aug 18. The rule is **does the card respond to a date range**:

| | Page | Filters |
|---|---|---|
| "How did I do in this window?" — counts, by-day charts, rejections, tier mix, campaigns, sub-ID | **Performance overview** | range · campaign · sub-ID |
| "Which slice of my traffic converts best?" — conversion windows, investable assets, states | **Targeting** | campaign · sub-ID (**no range**) |

Every card in the second group is scored on the **fixed trailing 30-day matured cohort**, because
a rate needs a finished cohort (§ attribution). They used to sit on the Performance overview,
where the range picker did not reach them — switching that page to "Last 7 days" left three cards
sitting still. Same filter set and same reasoning as the Health scorecard.

**Three moves in that change:**

1. **Investable assets** → Targeting, beside Lead criteria. Criteria carries the $25K floor (our
   rule); this is how the affiliate's own volume performs against it.
2. **Geography** → merged into the demand list as one **States** card (§5a-iii). The decision is
   the intersection — a state where they convert well *and* we have unspent budget — and it used
   to require reading two cards on two pages. States we want that the affiliate sends nothing from
   are appended to the table: "you send nothing here and we have room" is the most actionable row
   on the card and is invisible if the table is built only from their own volume.
3. **Arrival window** → **deleted, not moved.** It had become a straight duplicate of the Top
   conversion windows hour-of-day grain — same `bySegment`, same ph/mature rate, both blocked on
   A1. Its job is done better by the detail view below.

### 5a-iii. The States card — all fifty, ten to a page

Revised Aug 19. **Every one of the fifty states is in the table, always.** It used to build its
rows from the union of "states we hold demand data for" and "states this affiliate already sends
from", which hid the single most actionable row on the card: somewhere they send nothing and we
have room. New York is present too, marked **Not accepted** — a partner who does not know that is
exactly the one who needs telling, and omitting the row means they learn it through a rejection.

**Ten rows a page, and sorting runs across the whole set.** Sorting the ten rendered rows would
reorder page 1 and read as if it had sorted all fifty. The card uses `FZTable.enhance()` in managed
mode — full array in, `sortValue` accessor per column, sorted array back, re-paginate from page 1 —
the same mechanism the lead table uses. **The three-way view toggle is gone**: it switched between
orderings the sortable headers already provide, and it could disagree with the header arrows about
what was sorted.

**Two sources meet in this card and only one of them exists:**

| Column | Source | Status |
|---|---|---|
| Your leads, Converted to Priority/Hot | the affiliate's own leads, `computeMetrics().byState` | **REAL** |
| Buyer budget room | `ADMIN_STATE_DEMAND` in `data.js` | **NEEDS BUILDING** — hardcoded stand-in for the buyer-demand table |

A state with **no demand record renders blank**, not "covered" — no data and no room are different
answers and only one of them is true. `US_STATES` is the canonical fifty; `stateRows()` joins the
two halves and always returns all of them.

### The conversion column — why the bar is gone

Revised Aug 18. One table, three sorts, chosen by a toggle, because a partner arrives with one of
three questions and each wants a different order:

| View | Question | Sort |
|---|---|---|
| **Budget room** *(default)* | "Where do you need volume?" | our unspent budget, high→low |
| **Your volume** | "Where am I already sending?" | their leads, high→low |
| **Best converting** | "Where does my traffic actually work?" | their P/H rate, thin samples last |

Columns never change between views — only the row order and which header is marked — so switching
does not require re-reading what a column means.

**Budget is a BAND, never a figure.** `budgetRoom()` cuts on each state's share of all unspent
budget: **High** ≥10%, **Moderate** ≥5%, **Some** below that, **Fully covered** for states not on
the demand list. The dollar amounts stay internal (§5a) — a band leaks nothing the ranked list does
not already imply, and it answers the question the old binary "Room for more" could not: *how
badly* is this state wanted. Cut on share rather than fixed dollars so the bands do not go stale
as the demand table moves.

**Rows are the UNION of "states we want" and "states they send from."** Either list alone hides a
row that matters: a state we want with no volume is the most actionable row on the card, and a
state they flood that we do not want is the most expensive one.

### The conversion column — why the bar is gone

The **Converted to Priority/Hot** column on this card and on Investable assets used to carry a blue
bar, and the two cards drew it with **different meanings**:

- **States** scaled the bar to the best row in the table. A state at 16.3% against a best of 23.5%
  drew a bar at 69% of the track — and 69% of a track with no axis means nothing.
- **Investable assets** drew a true proportion of the band's own leads. Honest, but conversion runs
  0.1%–20%, so a genuinely strong band rendered as a stub and every band looked equally empty.

Both now render **the number, then one sentence comparing it to that affiliate's own average**:
*★ your best · above your average · about your average · below your average*, or **too few to
tell** when the bucket is under the `CW_MIN_BUCKET` / `CW_MIN_SALES` guards, or **no leads yet**.
That is the comparison a partner actually wants, it needs no legend, and it reads the same on both
tables. The ★ and the wording carry the meaning; colour only reinforces it, so the
no-status-by-colour-alone rule holds.

### 5b-i. Top conversion windows — derived per affiliate, admin-overridable

Added Aug 18. `conversionWindows()` in `data.js`, rendered by the **Top conversion windows** card
on the Targeting page and previewed in `admin-preview.html`.

The card used to show every affiliate the same two hours and the same weekly split. It now answers
*when does **my** traffic convert* from that affiliate's own **trailing 30-day matured cohort**,
across three grains: hour of day, day of week, week of the month.

**Precedence — override → derived → default.**

| Source | When | Storage |
|---|---|---|
| **Override** | An admin has pinned this affiliate's windows | `ADMIN_CONVERSION_WINDOWS[partnerId] = { hours: [], dow: [], week: [] }` — **NEEDS BUILDING**. Each grain independent; empty or absent means derive |
| **Derived** | Default path. Enough matured volume in scope | computed, nothing stored |
| **Default** | Too little matured volume, or the data cannot answer | falls back to §5b operating hours |

**The override is the failsafe and it is not optional.** Derived numbers on a thin or unusual
month can be wrong, and an account manager who knows better needs a way to say so without a
deploy. It must be settable per grain — the common case is pinning hours while letting days derive.

**Four thresholds, all in `data.js`, all needing an admin home:**

| Constant | Value | Why it exists |
|---|---|---|
| `CW_MIN_SCOPE` | 150 matured leads | Below this we do not derive at all, and say we are showing our staffing instead |
| `CW_MIN_BUCKET` | 25 matured leads | Three leads and one sale is not a 33% hour |
| `CW_MIN_SALES` | 3 Priority/Hot sales | **The one that matters on a low-converting account.** With a 0.2% baseline, one sale in a 25-lead bucket reads as a 20× lift |
| `CW_LIFT` | 1.20 | A window is a standout only 20%+ above that affiliate's **own** average. Without a margin a 0.24% day "beats" a 0.20% average and gets recommended, which is worse than recommending nothing |

**"Best" is measured against the affiliate's own average, never a fixed bar** — so a strong account
is not told everything is bad because it fails somebody else's threshold, and the claim on screen
("these convert better than your average") is either true or it is not.

**Hour of day reads Default for every affiliate today** — the export carries no time (A1). It turns
on by itself when that field lands; no code change.

**The Detail view is where the arrival-window analysis went.** Summary answers the question;
Detail shows the working, for all three grains: **share of what you sent** against **how it
converted**, per bucket.

**The mismatch between them is the entire point.** A window converting at 0.4% means nothing until
you know whether it carries 2% or 40% of the send; a window carrying 40% means nothing until you
know whether it converts.

**THE HEADLINE SENTENCE IS THE FEATURE, NOT THE TABLE.** Two columns of numbers still leave the
reader to spot the mismatch themselves, so each grain states it outright above its table:

> Most of your volume — 59% — goes to Thursday, which converts at 0.1%, below your average.
> Your best is Monday at 38.7%, taking under 1%.

It has three forms: the mismatch above; *"Your biggest slot is also your best… nothing to move"*
when they agree; and *"Not enough matured volume here yet to compare these"* when every bucket is
under the guards.

Four rendering rules, all of them things an earlier version got wrong:

1. **Sorted best-converting first**, never by clock or calendar order. Read top to bottom it
   answers "where should more of this go", and a long volume bar sitting at the bottom *is* the
   problem, visible without reading a number.
2. **The volume bar is a true share of the whole (0–100%)**, so its length means one thing. The
   first version drew two bars per row, each scaled to its own series maximum — a number that was
   never shown — which is why they read as decoration.
3. **Numbers sit next to their label**, at body size. The first version pinned them right-aligned
   at the far edge of a 945px SVG in 12px type, ~800px from the row label.
4. **Buckets under `CW_MIN_BUCKET` / `CW_MIN_SALES` say "too few to tell"** and sort last rather
   than being dropped — a thin bucket still tells you that you send there.

Shares under 0.5% render as **"under 1%"**, never "0%": Heritage's 41 Monday leads against 56,309
are a true 0.07% and a real row, and a printed zero beside a lead count reads as a bug.

**Two different timing ideas live in this product and they must not be conflated:**

- **This card** — when *your* leads convert best. Your own results, derived.
- **Delivery timing** in the health score (§6) — how much of your volume lands while *our floor* is
  staffed. Measured against `IDEAL_DOW_SPLIT`.

An affiliate can top this card and still score mid on that pillar. The card foot says so in one
sentence; do not remove it.

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

**What the score is called depends on what it covers**, and the label is never hardcoded — every
surface reads `FZApp.healthScoreLabel(state)`:

| Scope | Label | Where |
|---|---|---|
| No campaign filter | **Affiliate health score** | Partnership summary card, Health scorecard hero, Performance tile, 90-day trend |
| Filtered to a campaign | **Campaign health score** | The same surfaces, once `campaign` is in the query string |
| One row of the Active campaigns table, or the Health scorecard's per-campaign table | **campaign score** | Always campaign-grain, so it needs no scope qualifier |

An affiliate score is the volume-weighted rollup of the campaign scores **plus** the account-level
pillars (consistency, and compliance once it lands), so the two are not interchangeable and a
filtered page must never wear the account's name. Sub-ID alone does **not** rename it — a sub-ID
cuts across campaigns, so the scope is still the account.

A **campaign score covers the two campaign-grain pillars only** — conversion & value and delivered
quality, renormalised to 100%. That is why the itemised column does not average to the affiliate
score, and the hover descriptor on both tables says so.

**Delivery timing (added Aug 18)** sits inside **Delivered quality**, worth **0.15** of that
pillar across three parts. The five parts that were already there keep their relative weights
exactly — each scaled by 0.85 — so nothing was re-argued, only diluted.

| Part | Weight (of pillar) | Measured against | Status |
|---|---|---|---|
| Delivery timing — hour of day | 0.060 | `IDEAL_WINDOWS` | **PARKED** on A1 (no time of day on the export). Excluded and renormalised, never scored zero |
| Delivery timing — day of week | 0.050 | `IDEAL_DOW_SPLIT` — overlap with our staffed days | Live, but see **A12** |
| Delivery timing — week of month | 0.040 | **Evenness only** — see below | Live, but see **A12** |

**Same-day conversion (added Aug 18)** sits inside **Conversion & value** at **0.10**, on the same
rate denominator as Priority/Hot conversion and Sold rate. The other four parts were scaled by 0.90.
It is not a restatement of median sales cycle: the cycle answers *how long do sales take*, this
answers *how often is it immediate*, and a partner can move one without the other.

Three rules the implementation must keep:

1. **There is no ideal week of the month, and we do not invent one.** Hours and weekdays are backed
   by a real, stated fact — when the call floor is staffed. Nothing about our operation prefers the
   3rd to the 23rd. So week-of-month is scored on **evenness across the four weeks**, never on
   conformance to a shape we made up. (The Targeting card is different: there it is derived from
   the affiliate's own results, which is an observation about their traffic, not a preference of
   ours — §5b-i.) The 6–9a "golden window" that had to be unwound across this
   whole prototype is the same mistake; do not repeat it here.
2. **These measure the affiliate's delivery, never our response.** Speed-to-lead and call attempts
   stay deleted (see below) — they measure our floor. Timing measures when a partner sends, which
   is theirs to control. Do not let ops metrics back in through this door.
3. **They are asks, not gates, and every rendering says so.** `COVERAGE_NOTE` rides with the
   Targeting page and the coverage widgets. A partner who reads a window as a requirement sends
   less, not better.

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
| Delivery timing — hour of day | Delivered quality (parked) | **BLOCKED on A1** (time of day). Was *Send-window fit* under Consistency; moved Aug 18 so all three timing grains sit together |
| Delivery timing — day of week | Delivered quality | Live. Overlap with `IDEAL_DOW_SPLIT`. **See A12** |
| Delivery timing — week of month | Delivered quality | Live. **Evenness across the four weeks only — there is no ideal week and none is to be invented.** See A12 |
| Same-day conversion | Conversion & value | Live. `sameDayRate`, same denominator as the other conversion rates |

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

**Rewritten Aug 19, after Logan checked what actually runs. It is simpler than this document
previously claimed.**

It is **one suppression file per affiliate**, and that is the whole feature. It helps an affiliate
keep duplicates out of their own campaigns. There is no lookup endpoint, no bulk screening tool,
no per-affiliate HMAC key, no published manifest — the earlier version of this section specified
all of that, and none of it exists or is planned right now.

### What needs building

| Piece | Drives | Status | Notes |
|---|---|---|---|
| **A file location on each affiliate's record** | the whole card on `duplicate-check.html` | **NEEDS BUILDING** | This is the connection point. One file per affiliate, not one shared file. `ADMIN_SUPPRESSION_FILES[partnerId]` in `data.js` is the hardcoded stand-in |
| Last-updated timestamp | "Updated 19 Aug" under the download | **NEEDS BUILDING** | Optional — the card renders without it |
| Record count | integrity check against a truncated download | **NEEDS BUILDING** | Optional |

`suppressionFileFor(partnerId)` returns all of these as **null until connected**, and the card
renders a *"Not connected yet"* state rather than a sample file or an invented row count (§2b).
When the field is wired the card populates on its own — no copy change.

### What the page may state as fact

Only the **365-day Priority/Hot exclusivity window**, because that is a confirmed commercial term
already on the partner record and in `REJECT_REASONS`.

**Do not re-add format, cadence, hashing or record-count claims** unless someone has confirmed
them against the file that really ships. It is easy to describe a file into existence and much
harder to walk it back once a partner has read it — that is exactly what happened to the previous
version of this section.

### The page is deliberately thin

`duplicate-check.html` is one card. It gets built out later; for now it says one true thing rather
than four speculative ones. Removed in the rewrite: the single-number lookup, the bulk check with
its rate-limit quota, the "what this returns and what it does not" boundary card, and the internal
open-questions card. `checkDuplicate()` went with them and is recoverable from git history.

## 8. Creatives — upload, approval, and the record it leaves

**PROCESS CHANGE, Aug 19 (Logan with Michael). This is the largest new connection point in the
portal.** Creatives no longer travel by email. An affiliate uploads them through the portal, they
sit **Pending review** until someone here reviews them, and then they read **Approved**. That
applies twice over: when a campaign is being set up, and every time an affiliate wants to change
what they are running.

### Two purposes, and only one of them is partner-facing

| | |
|---|---|
| **Told to the affiliate** | Approval is a compliance review. A creative cannot run until it clears. That is the whole partner-facing story, and it is true. |
| **NOT told to the affiliate** | The per-campaign creative record is also what lets us attribute a lead back to the creative that produced it, and gives us a running record of what each affiliate is actually putting in market. This is internal analytics. **No partner screen may describe it**, and no partner-facing copy may imply we retain or analyse their creative beyond the approval itself. |

The second is the reason the record must be **per campaign and time-stamped** rather than a single
"latest creatives" blob per affiliate. A lead that arrived on 3 August has to resolve to the
creative set that was approved and live on 3 August.

### What needs building

| Piece | Drives | Status |
|---|---|---|
| **File storage** — per affiliate, per campaign, versioned | the upload button | **NEEDS BUILDING.** Nothing here stores a file; `submitCreatives()` writes to sessionStorage so the three states can be walked through in review |
| **Review queue** — our side, with approve / request-changes | the Pending → Approved transition | **NEEDS BUILDING.** Affiliates must never be able to approve their own creative: `submitCreatives()` always lands on `pending` |
| **Status write-back** | the badge on both screens | **NEEDS BUILDING** |
| **Effective-dated history** per campaign | lead → creative attribution (internal) | **NEEDS BUILDING.** Keep superseded versions; do not overwrite |
| **File preview / download** of an approved creative | the "View" link | **NEEDS BUILDING** — currently says preview opens once storage is connected |

Accepted upload types in the prototype: images, PDF, HTML, ZIP. Confirm the real list, a size cap,
and virus scanning before this ships — it is an authenticated file upload from an external party.

### States

`CREATIVE_STATUS` in `data.js`: `none` → `pending` → `approved`, plus `changes` (changes needed).
An affiliate can only ever cause `none → pending`.

### Where it renders

| Surface | Behaviour |
|---|---|
| **Targeting → Creatives** | Campaign picker (approval is per campaign) + the upload panel. This is the "I want to change my ads" route |
| **Campaign setup → Creatives step** | Same panel inside the setup tracker. The step's own state follows the submission: nothing uploaded = to-do, uploaded = waiting on us, approved = done |
| **A live campaign's page** | The creatives section defaults **open** and the step is relabelled *Creatives — approved*, because by then it is a record rather than a task and it is the one section a partner returns to |

The email route to compliance was **removed from both screens**, not left alongside. Two routes
means an inbox that bypasses the approval record, and a per-campaign history with holes in it.

## 9. Feedback link

Added Aug 19. One quiet line at the foot of the **Account & users** page:
*"Something not working, or an idea for us? Give feedback."*

| Piece | Status |
|---|---|
| The form itself | **NEEDS BUILDING** |
| `ADMIN_FEEDBACK.url` in `data.js` | **NEEDS BUILDING** — hardcoded stand-in for the setting |

Until the URL is set the link opens a short explanation pointing at the account manager rather than
dead-ending. **Set `ADMIN_FEEDBACK.url` and it becomes an ordinary external link** — no other
change. It is an object rather than a bare string on purpose: exporting a scalar exports a copy, so
assigning to it would change nothing.

**It is deliberately on one page only.** A persistent feedback button on every screen reads as a
beta badge, and a partner looking for one checks their account before a reporting page. If it ever
needs to be more visible, that is a decision to take rather than a default to drift into.

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
| **Your agreement** | a **different URL per affiliate** — a URL field on the affiliate record, pasted by the admin. **Working in the mock:** the Admin settings page has a live per-affiliate paste field (sessionStorage standing in for the record field) so the flow is reviewable end to end | **NEEDS BUILDING** — the record field plus the admin edit box. Full workflow and sharing rules below |
| New / edit campaign flows | — | **NOT SPECIFIED.** Placeholder modals pointing at Logan until he defines the flow |
| ~~Test lead sandbox~~ — **REMOVED Aug 7** | was `sandboxCheck()` in `data.js` | Built Aug 6, removed on Logan's call the next day: checking a hand-typed lead against acceptance criteria is not something affiliates need. **What Logan actually wants in this slot is a PIXEL TEST** — a tool that verifies the tracking pixel fires correctly on the affiliate's landing page. Not built; when it is scoped it should be the affiliate-facing front end to Marc Heberling's pixel-validation work (see §8), not a second implementation |
| Contact block | Logan Randall, logan@financialize.com | constant; should join from the CRM like §1's account manager |

Two rules the implementation has to keep:

1. **Adding a document must not require a deploy.** The page renders whatever rows exist. If the
   team has to file a ticket to publish a PDF, the library will not be maintained.
2. **A document with no URL renders "not linked yet", never a dead button.** `scope: 'partner'`
   documents are unset for most affiliates on day one, and a button that 404s reads as a broken
   portal rather than an unfinished record.

### The agreement — workflow and sharing rules (differs from every other document)

**The workflow (Logan's):** an agreement is signed → Logan logs into the admin and pastes the
Google Drive link on that affiliate's record → the "Your agreement" card on their Setup & docs
page links to it. Until then the card shows "Not linked yet". Re-signing or amending = paste the
new link over the old one; nothing else changes.

**The sharing model is the access control, and it is deliberately different from the public
docs.** Onboarding, criteria, the API docs and the landing-page doc are all *anyone with the
link can view*. The agreement is **shared directly with the email address of each user on that
account** — a stranger with the URL hits Google's request-access wall. Three obligations follow:

1. **The Drive share list must follow the account's user list.** Adding a portal user includes
   sharing the agreement with their email; deactivating a user includes removing their Drive
   access the same day — otherwise the agreement outlives their portal access. Manual for Logan
   at first; scriptable later via the Drive API. The rule matters more than the automation.
2. **The link stays inside the portal.** It renders only on the authenticated account's own
   page, and never goes out in notification emails (link to the portal page instead), CSV
   exports, or query strings.
3. **Expect the request-access wall.** A user signed into the wrong Google account will hit it —
   the card's hover tip already tells them to check which address they're signed in with or ask
   their account manager. That one sentence is the difference between a self-serve fix and a
   support email.

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
statements, and the pixel unfire record. Reached from the sidebar or by clicking the Billing details
card on the Partnership summary.

| Element | Source | Status |
|---|---|---|
| Earned this period | `payoutForWindow()` — rev-share summed on the **sold** date (rejected-but-sold included, per the Aug 5 ruling), CPL on the **received** date × the campaign rate | Computed from the lead table; CPL needs the **rate card on the campaign record** (A4 / B14 adjacent) or it reports "not on file" rather than $0 |
| "Subject to change" caveat | static copy + hover descriptor | The number is provisional until the statement closes; audits run weekly |
| Billing details card | same fields as the Partnership summary — `billing_period` / `billing_basis` (B3) + billing contacts | duplicated rendering, single source |
| Lead statements list | one Google Sheet URL per affiliate per month, admin-pasted | **NEEDS BUILDING** — B15. Generated on the first business day after month close; unlinked months show "Not linked yet" |
| Pixel unfire report | `queryUnfires()` — unfire date, affiliate-safe reason, credited amount | **NEEDS BUILDING** — A9, the unfire feed (Sagar). Reason must map to the `RETURN_REASONS` vocabulary; the internal `clawback_reason` stays forbidden |

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
   internal `clawback_reason`, never anything about margin, buyers, or call outcomes.
3. **Statement months attach to the partner record, not a deploy** — same pattern as the
   per-affiliate agreement URL (B12).

---

## 7b. Data quality found in the real export

Every item here is a real finding from `Lead-Report-08-06-26.csv`, not a mock-up artefact.
They are rendered in-app on the Data source page.

| Finding | Evidence | Consequence |
|---|---|---|
| **$1 phantom COGS — confirmed live** | All **41,627** accepted rows carry a non-zero Lead Cost with a median of exactly **$1.00** | Margin is fabricated. The health score's margin input is **excluded** rather than computed on it |
| **Reject Reason is not a controlled field** | **2,917 distinct values**, of which only **21 are clean labels**. The tail is raw XML filter responses written into the reason column — **2,713 rows** | Two fields are now emitted: the **exact system string** (rendered verbatim in the lead table and CSV so an affiliate's export reconciles 1:1 against ours) and a **bucket** for grouping. The XML rows have no usable exact value and fall back to the bucket's plain-language label — they are surfaced as *"Pixel manually unfired"*, in their own **Not a rejection** section and excluded from the rejected total — that is what those rows actually are (see §3a), and the affiliate is not blamed for our fault. Needs a controlled vocabulary at source |
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
| Google Drive export | Needs a Drive OAuth scope per partner, a service account, and a destination folder convention. **None of it exists**; the CSV path is the only real one |
| Setup-flow scope | Needs confirming with Michael, and scoping against Marc Heberling's automated pixel-validation work — this should be the affiliate-facing front end to his backend, not a second implementation |
| Module F — internal Lead Activation view | Courtney's screen: call attempts, dispositions, queue state, affiliate-submitted nurture leads. Phase 2 |
| Real logo asset | `BRAND_MARK` in `app.js` is a geometric placeholder |
