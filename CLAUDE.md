# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **prototype / spec artifact**, not production code. It is a mock-up of the Financialize
affiliate-facing partner portal, built to hand to the dev team (Sagar, Zakira) for implementation
into the existing **PHP** system, and to review with Michael McMillan and Courtney Barrett.

The deliverable is the *rules*, not the code: metric definitions, redaction rules, the attribution
model, scoring weights, tier thresholds, and the gating field list. All numeric data is fabricated.

**`HANDOFF.md` is the primary document.** It is the actual handoff memo and carries the reasoning
behind every decision below. Read it before changing anything that touches visibility, attribution,
or scoring — several rules in it override an earlier internal context doc, and the overrides are
deliberate.

**`ADMIN-MAPPING.md` is its companion**, mapping every dashboard element to the admin setting and
data field behind it. **When a field or feature is added to the dashboard, add its row there in the
same change.** A feature that renders but has no row there is a feature nobody knows how to
populate in production.

## Running it

No build step, no dependencies, no server. Open `index.html` in a browser — it forwards to
`partnership.html`, the landing screen. The Performance overview lives at `performance.html`.

If you do serve it over HTTP, **use a server that does not rewrite URLs.** All state in this
prototype lives in the query string, and `npx serve` 301-redirects `/index.html` → `/index` while
**dropping the query string**, which silently breaks every filter link and every "View details"
button. `.claude/launch.json` uses `http-server` for this reason.

There are no tests, no linter, and no package manager. `.gitignore` mentions Node/Next.js
artifacts but nothing in the repo uses them.

The CSS header documents a re-validation command (`node scripts/validate_palette.js ...`).
**That script does not exist in this repo** — the palette was validated externally and the results
are recorded in comments at the top of `assets/css/dashboard.css`.

## Architecture

Five static pages, each loading the same four scripts in this fixed order:
`data.js` → `health.js` → `charts.js` → `app.js`. Each script is an IIFE attaching one global:
`FZData`, `FZHealth`, `FZCharts`, `FZApp`. Page-specific rendering lives in an inline `<script>`
at the bottom of each HTML file.

| File | Module | Screen |
|---|---|---|
| `index.html` | — | Redirect stub only — forwards `/` to `partnership.html`, preserving the query string |
| `partnership.html` | 0 | Partnership summary — landing screen and the default page |
| `compensation.html` | — | Compensation — earnings for the window, billing terms, monthly statements, pixel unfire report |
| `performance.html` | A | Performance overview |
| `leads.html` | B | Lead table + CSV export |
| `duplicate-check.html` | C | Duplicates & suppression — one card, the affiliate's own suppression file |
| `health.html` | D | Health scorecard |
| `setup.html` | E | Setup & docs hub — campaign list with setup status, document library, contact |
| `campaign-setup.html` | E2 | Per-campaign setup tracker (onboarding steps 6–10, LP vs API paths). The pixel URL here is the only affiliate-editable field in the portal |

`admin-preview.html` is **temporary, internal and not partner-facing** — it previews the admin
settings for the dev team, under an "Internal — temporary" nav heading. Delete it and the
`INTERNAL_NAV` entry in `app.js` before shipping. Nothing on it saves, on purpose.

Module F (internal Lead Activation view for Courtney) is Phase 2 and not built.

Each page has `<aside data-shell="sidebar">` and `<header data-shell="topbar">`, filled by
`FZApp.shell()`.

### Constraints that shape the code — do not "modernise" these

- **The system is PHP and stays PHP.** Vanilla JS, plain CSS, no framework, no build step, no
  charting library (charts are hand-rolled SVG in `charts.js`).
- **Filter state lives in the query string**, and the filter row is a real `<form method="get">`
  that reloads the page. This is intentional: it is the shape a server-rendered PHP view takes.
  Do not introduce a client-side router or a JSON API.
- **Charts read colours from CSS variables at render time**, not at mount, so a light/dark flip
  repaints with that theme's own validated colour step.

## The rules that matter most

### 1. Visibility is a query-layer rule, not a UI toggle

`queryLeads()` in `data.js` builds each returned row **field-by-field from an allowlist**. A field
an affiliate may not see is never copied onto the object, so it cannot be read from the DOM, a CSV
export, or the console.

In PHP this means **two different SELECT lists**, not one SELECT plus an `if` in the template.

**Comp model is a property of the campaign, not the account**, so the projection is resolved **per
row** from that row's campaign. A partner running both models gets revenue columns on their
rev-share rows and no revenue field at all on their CPL rows, in one table. Do not reintroduce a
single per-account branch. **Two real accounts are already mixed — Ignite Media Group and CX3
each run CPL campaigns alongside a rev-share campaign** (low volume, easy to miss). HANDOFF.md
carries "THE MIXED-ACCOUNT CONTRACT", six verified per-row rules (per-row projection and row
rule, `rateBasis: 'mixed'` per-row denominators, CPL targets counting CPL leads only via
`cplScopeIsPure()`, per-campaign share) that any change touching visibility or rates must keep.

**Which columns are available is admin-configurable per comp model**, via two pieces in `data.js`:
`LEAD_COLUMNS` (the registry — one entry per affiliate-visible column, declaring which comp models
*may* see it) and `ADMIN_COLUMN_CONFIG` (what an admin screen writes). The registry is a **hard
constraint, not a default** — an admin cannot enable a revenue column for a CPL campaign. Columns
marked `locked`, including `rejectReason`, cannot be switched off. **Adding a column is one
registry entry**; the table, the CSV export and the admin preview all read it.

Columns forbidden to **every** comp model, revenue share included:
`lead_cost · margin · margin_pct · buyer_name · csr_name · call_result · ipqs_score ·
ipqs_rules_fired · clawback_reason · campaign_cost`. These are **absent from the registry entirely
— absence is the enforcement.** In the mock they are the `_`-prefixed fields on the internal lead
objects and they never leave `runQuery()`.

The **"Viewing as" partner selector is a mock-up affordance only.** In production the partner comes
off the session and cannot be chosen. Build it from `PARTNERS`, never from hardcoded strings — it
previously drifted and mislabelled which partner was on which comp model.

### 2. The row rule — on a CPL campaign a rejected lead dies at the door

On top of the column allowlist, `runQuery()` enforces a **row-level** rule. A lead we decline can
still sell (auction, marketplace, occasionally Priority/Hot), and it costs us nothing. On a CPL
campaign the affiliate must never learn that happens: a rejected row shows its reason and nothing
after it.

Two halves, both required — the second is the one that is easy to miss:

1. Null the outcome columns (`soldType`, `soldAt`, `daysToSale`) on rejected rows.
2. Any query filtering **by** sold date must also exclude rejected rows outright. The row count
   alone leaks the practice even with every column nulled.

**Revenue share is the exact opposite and this is a deliberate override of the affiliate context
doc (§16).** Logan ruled on Aug 5 2026 that revenue-share partners **do** see rejected-but-sold
leads — they are paid 40% of any sale, accepted or not, so hiding those rows understates what we
owe them and makes their invoice impossible to reconcile. In the mock that is 262 leads / $6,791,
~11.5% of revenue-share earnings. What made the July 31 Heritage leak a leak was the Profit, Buyer
Name, CSR Name and Call Result columns, which stay forbidden to everyone.

### 3. Attribution — three windows, and mixing them up is what makes a report look broken

Leads take 9–12 days to mature.

| Question | Attributed to | Function |
|---|---|---|
| "What did I send, was it accepted?" | **received** date | `queryLeads()` |
| "What sold, what did I earn?" | **sold** date | `queryLeadsBySold()` |
| "How good is my traffic?" (any *rate*) | trailing **30-day matured cohort** | `cohort()`, `health.js` |

Attributing outcomes to the received date makes the default 7-day view report 0.0% conversion and
$0 earnings — not because nothing sold, but because nothing sent that recently has had time to.
Rates use neither window: a rate needs a finished cohort, so it is always the trailing 30 days with
a 10-day buffer (`MATURITY_DAYS`) — the same basis the health score uses, so Performance and the
scorecard can never disagree.

A revenue-share **payout target** must be measured on the sold date; CPL spend stays on the
received basis because we owe on acceptance. See `targetProgress()`.

### 4. Acceptance means different things to the two comp models

`computeMetrics(rows, asOf, {rateBasis})` takes `'paid'` (CPL — of leads we accepted and paid for)
or `'all'` (revenue share — of every lead submitted, since they are paid on any sale). Dividing a
revenue-share partner's sales by accepted leads alone overstates conversion and undervalues their
volume. `rateBasisFor(partnerId)` picks the basis.

**One deliberate exception:** the health score always uses the accepted basis for every comp model,
because its tier thresholds are calibrated that way. The scorecard labels that component
"of accepted" so the two pages read as two questions, not a contradiction.

### 4a. Timing claims must match the real call-centre hours

Mon–Fri 9:00 AM – 7:00 PM local time in every timezone we cover (9 AM – 10 PM ET end to end);
Saturday 9:00 AM – 8:00 PM ET on lighter staffing; closed Sunday. **Ideal reception windows,
consumer local time, Mon–Fri: 9–11 AM and 3–7 PM.** Ideal daily split: Mon 20 / Tue 19 / Wed 19 /
Thu 19 / Fri 15 / Sat 8 / **Sun 0**.

An earlier version asserted a **6–9a "golden window"** across the data generator, the health pillar
and the Performance arrival card. It was invented and contradicted these hours — the floor does not
open until 9a. It has been removed. **Do not reintroduce it.** `OPERATING_HOURS`, `IDEAL_WINDOWS`,
`IDEAL_DOW_SPLIT` and `HOUR_YIELD` in `data.js` are the single source; anything on screen about
timing derives from them.

All three coverage widgets are **asks, not rules**, and `COVERAGE_NOTE` must ride along with every
rendering — we accept leads any day and any hour. A partner who reads them as gates sends less,
not better.

### 5. Partner-specific criteria exceptions must be carried everywhere

OptiLabX Media has a **negotiated 45–79 age band** rather than the standard 45–75. This is a
commercial term, not a data error — it has already cost a $5,194 invoice variance and 55 leads
wrongly flagged on a July unfire list. Every criteria label renders through
`rejectLabel(reason, partnerId)`. **A hardcoded 45–75 anywhere will misreport our largest
partner.**

### 4b. Nothing affiliate-facing may mention the lead export

**The dashboard is built against a backend, not against a file.** While it is in testing it happens
to read a lead export, but that is a temporary source and it must not appear anywhere a partner can
see. A partner reading *"the lead export does not carry this"* learns our plumbing and hears a
permanent limitation; the same gap phrased as **"not connected yet"** reads as a field that will
fill in — which is what it is.

So a field with no source renders **blank plus a not-connected note** — never a zero, never an
invented value, never an explanation of where our data currently comes from. When the field is
wired on the backend it simply populates and the note disappears, with no copy change anywhere.

- Use **`FZApp.notConnected(what)`** for the cell treatment (muted em dash + hover note) and
  `FZApp.NOT_CONNECTED_TEXT` where markup is not possible. One helper, so the wording is
  consistent and there is a single place to change it.
- **Do not branch partner copy on `usingRealData()`.** Production is neither the mock nor the
  export; ask whether the *data* is present (e.g. "did any row come back with an unfire date"),
  not which source is loaded.
- Data with no connection is **`null` in `data.js`**, not a placeholder string. `sinceISO`,
  `integrationNote` and the placeholder contact's `title` are all null for this reason.
- **Exempt, and deliberately so:** `admin-preview.html`, `data-source.html` (Data connections),
  `HANDOFF.md`, `ADMIN-MAPPING.md`, and any card carrying the `.is-internal` treatment. Naming the
  export is exactly their job.
- Build state — who is connecting what, and by when — belongs in ADMIN-MAPPING and HANDOFF, never
  in a card a partner reads. "Build note", "HANDOFF.md", and individual dev names had all leaked
  onto partner screens and were removed on Aug 18.

### 5a. Which page a card belongs on — the date filter decides

Reorganised Aug 18. **If a card responds to a date range it belongs on Performance; if it is
scored on the fixed trailing 30-day matured cohort it belongs on Targeting.**

Performance keeps counts, by-day charts, rejections, lead tier mix, campaigns and sub-ID, and
filters on `range · campaign · subid`. Targeting carries top conversion windows, investable assets
and states, and filters on `campaign · subid` **with no range** — same set, same reason, as the
Health scorecard: a rate needs a finished cohort, so a range picker there is a control that
changes nothing.

Investable assets and Geography moved off Performance for exactly this reason — the range picker
never reached them. **Arrival window was deleted, not moved**: it had become a duplicate of the Top
conversion windows hour-of-day grain. Its analysis now lives in that card's **Detail** view, which
draws two series per bucket — share of volume sent, and conversion rate — because the mismatch
between them is the actionable fact and neither series alone carries it. That view is a **table
sorted best-converting first, with a headline sentence** naming the mismatch ("Most of your volume
— 59% — goes to Thursday, which converts at 0.1%") — the sentence is the feature; the table is the
working. It was first built as a two-series bar chart and that failed: each series was scaled to
its own unshown maximum, so the bars carried nothing, and the numbers sat 800px from their labels
in 12px type. Don't rebuild it as a chart.

### 5b. Conversion cells say the comparison in words, not with a bar

The **Converted to Priority/Hot** column on the States and Investable assets cards renders the
number plus one sentence against that affiliate's own average — *★ your best · above your average ·
about your average · below your average*, or *too few to tell* under the `CW_MIN_BUCKET` /
`CW_MIN_SALES` guards. **Do not put the bar back.** It was drawn with two different meanings on the
two cards (scaled-to-best on States, true-proportion on Investable assets), and neither was
readable without a legend the card did not have.

The **States** card is one table with three sorts behind a toggle — budget room (default), your
volume, best converting — and rows are the **union** of states we want and states they send from,
so "you send nothing here and we have room" stays visible. Budget renders as a band (`budgetRoom()`:
High / Moderate / Some / Fully covered), never as a figure — the dollars are internal (§5a).

### 6. Rejection reasons are one vocabulary, ours and theirs

`REJECT_REASONS` in `data.js` is the affiliate-facing catalogue **and** the proposed internal
vocabulary — deliberately the same list, so a reason added internally needs no mapping layer here.
It is a proposal pending the tech team; ADMIN-MAPPING §3a is the spec.

- The *Why leads were rejected* card lists only reasons with leads in the window, flat and
  biggest-first. The full catalogue is the spec for the tech team and lives in ADMIN-MAPPING §3a,
  not on a partner's screen.
- **`ipqs` is a temporary aggregate.** It carries 52% of rejections as one unactionable label.
  `ipqs_phone` / `ipqs_email` / `ipqs_other` are in the registry at zero; when the split lands,
  `ipqs` is **removed**, not renamed.
- **`filter_error` is not a rejection.** It is a manual pixel unfire after acceptance. It is pinned
  last, excluded from the rejected total and every share (`n/a`, never a percentage), and left out
  of the chart. Do not let it sort into the list by volume.
- `missing_fields` (blank/null) is distinct from `contact` (present but unusable) — different fix.
- Adding a reason is one registry entry: the table, the chart and the lead-table filter all read
  `REJECT_ORDER`.

## The scoring engine (`health.js`) — v2, redesigned Aug 7 2026

Four pillars, affiliate-visible, built **only from what the affiliate controls**: Conversion &
value 40%, Delivered quality 35%, Compliance & trust 15% (**also a gate** — a critical failure
caps the score at 45), Consistency & coverage 10%. Tiers: Scale 80+, Healthy 60+, Watch 45+,
Intervene below (affiliate-facing labels differ; `TIERS[].internal` keeps ours). Below 100
matured paid leads it renders as **Provisional**.

**Naming follows scope, and the label is never hardcoded** — every surface reads
`FZApp.healthScoreLabel(state)`. Unfiltered it is the **Affiliate health score**; filtered to a
campaign it is the **Campaign health score**. A sub-ID filter alone does not rename it, because a
sub-ID cuts across campaigns. Per-campaign scores are itemised in the Health score column of the
Active campaigns table (Partnership summary) and in the Health scorecard's own per-campaign table;
both read `FZHealth.score().campaigns[]` from the same engine run that draws that page's dial, so
they cannot drift. A **campaign score is the two campaign-grain pillars only**, renormalised — it
does not average up to the affiliate score, which adds the account-level pillars on top.

**Delivery timing** lives in Delivered quality (0.15 of the pillar): hour of day 0.060 (**parked**
on A1 — no timestamp on the export), day of week 0.050 against `IDEAL_DOW_SPLIT`, week of month
0.040. **Same-day conversion** lives in Conversion & value at 0.10. Within-pillar weights are
defined once, in `CONV_PARTS` / `QUAL_W`, because the per-campaign path and the account rollup both
build these lists and used to carry separate copies.

**There is no ideal week of the month and we do not invent one** — in the SCORE, week-of-month is
evenness across the four weeks, never a preferred week. Same trap as the 6–9a "golden window"; see
§4a. The **Targeting card is the opposite case**: `conversionWindows()` derives each affiliate's
best hours, days and weeks from their own trailing 30-day matured cohort, which is an observation
about their traffic rather than a preference of ours. Precedence is **override → derived →
default**, the override (`ADMIN_CONVERSION_WINDOWS`) is a required failsafe, and a window is only
called a standout at 25+ matured leads, 3+ Priority/Hot sales, and 20% above that affiliate's own
average. ADMIN-MAPPING §5b-i.

The two are **different measurements and must not be conflated**: the card says when *your* leads
convert best; the pillar says how much of your volume lands while *our floor* is staffed.

Two deliberate deletions — **do not rebuild either**:

- The v1 **Speed & operations pillar is deleted, not parked.** Speed-to-lead and call attempts
  measure OUR call floor, not their traffic. They are internal ops diagnostics (Module F).
- The v1 **hidden margin input is out of the score.** Margin lives in the internal overlay on
  the Data connections partner table (score × volume-tier grid), beside the score, never in it.
  The affiliate-visible number and the internal number are the same number.

Mechanics the build must copy: **percentile calibration** against our own book per **campaign
class** (fresh annuity / aged annuity / life — the campaign is the scoring unit, rolled up
volume-weighted; class pools win over the global pool even when tiny), **shrinkage** of
small-sample rates toward the class median, **banded** acceptance (never continuous),
missing data **excluded and renormalised** (never scored zero), and **early-warning flags**
computed separately from the score (fast signals vs the partner's own baseline — detection,
not judgment). Calibration is a stored table recomputed quarterly in production, never
per-request. Compliance inputs come through `D.complianceFor()` — all null in the mock on
purpose (real affiliate names; nothing is fabricated against them), which parks the pillar
and disarms the gate.

## Things flagged as open, not done

- **Sale-tier point values need Michael's sign-off.** Live transfer (14) and Appointment (12) are a
  proposal; Priority 10 / Hot 8 / Auction −3 / Marketplace −4 are his. The North Star metric
  deliberately still counts **Priority + Hot only** — his KPI, not redefined here.
- **Spend & volume targets have no admin screen.** `TARGETS` in `data.js` is hardcoded. A null
  target means *not set*, must not render, and must not count as missed. Severity is judged against
  expected-to-date pace, never against the monthly total.
- **The logo is a placeholder.** `BRAND_MARK` in `app.js` is a geometric stand-in. Drop in the real
  SVG before this goes in front of a partner.
- **Google Drive export is mocked** — nothing leaves the browser. The CSV path is real.
- **Blocking data dependencies** (Zakira): `sold_type` as distinct Priority/Hot/Auction/Marketplace
  labels, and `subid` / `click_id` / `utm_campaign` / `utm_medium`.
- **Three data-integrity problems that corrupt the score if not fixed first:** the $1/lead phantom
  COGS on rev-share campaigns, placeholder birth years on the aged-lead import, and (A12) the
  **import date standing in for the consumer's submission timestamp on bulk-loaded aged leads** —
  Heritage's aged campaign is 55,481 of 56,309 cohort leads and lands on three weekdays, 100% in
  the last third of the month, so the new Delivery timing components score our load schedule
  rather than their delivery. Fresh drip traffic reads normally, which is how we know the metric
  itself is sound.
- **The admin side does not exist at all.** `ADMIN_COLUMN_CONFIG`, `TARGETS`, `STATE_DEMAND`,
  `OPERATING_HOURS` and `IDEAL_DOW_SPLIT` are all hardcoded constants standing in for settings.
  `ADMIN-MAPPING.md` specifies the storage each one needs.
- **Open with Courtney:** Saturday closes at 8 PM ET (5 PM Pacific), so the 3–7p local window does
  not hold out west on Saturdays, and the Saturday 8% may want weighting toward Eastern and Central.

Full detail and the remaining open questions are in `HANDOFF.md`.

## Conventions

- **`TODAY` comes from the loaded dataset** — with the current export that is **Aug 6 2026**
  (its last lead date), so every reviewer sees identical figures. Re-ingesting a newer export
  moves `TODAY` and with it every number quoted in `HANDOFF.md` and the README. The
  deterministic generator (`mulberry32`, seed `20260805`, `TODAY` pinned Aug 5 2026) is only
  the fallback when no dataset file is present.
- ES5-style code throughout (`var`, `function`, IIFEs) — match it.
- **No status is ever colour-alone.** Every status ships as a dot plus a text label, because brand
  coral sits close to status-critical red (ΔE 9.7 light / 6.8 dark, against a floor of 15). This is
  a known, accepted condition whose entire mitigation is the text label. A bare coloured dot breaks
  it. Meter bars are the one component carrying meaning by colour alone, so they use their own
  validated contrast-safe ramps rather than the status tokens.
- Do not substitute chart series colours without re-validating — slot order is the
  colourblind-safety mechanism, not decoration.
