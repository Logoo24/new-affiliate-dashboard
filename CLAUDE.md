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
| `compensation.html` | — | Compensation — earnings for the window, billing terms, monthly statements, clawback report |
| `performance.html` | A | Performance overview |
| `leads.html` | B | Lead table + CSV export |
| `duplicate-check.html` | C | 365-day phone lookup |
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
single per-account branch.

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

## The scoring engine (`health.js`)

Four pillars, weighted, normalised 0–100: Economics ~50%, Delivered quality ~30%, Speed &
operations ~10% (**parked**), Volume & coverage ~10%. Tiers: Scale 80+, Healthy 60+, Watch 45+,
Intervene below. Below 100 matured paid leads it renders as **Provisional**.

- The **parked pillar is excluded and the remaining three renormalised to 100**, not scored zero —
  scoring it zero would silently cap every partner at 90 and make the model look broken. When
  `speed_to_lead` and `call_attempts_to_convert` land, set `parked: false` and the weights snap
  back on their own.
- The **margin input is read here and converted to a sub-score here**. It is never attached to any
  object the view layer touches, so the affiliate sees the same number we do without being able to
  reverse-engineer our economics. `D._internalAggregates()` exists for this and is deliberately not
  part of `queryLeads()`.

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
- **Two data-integrity problems that corrupt the score if not fixed first:** the $1/lead phantom
  COGS on rev-share campaigns, and placeholder birth years on the aged-lead import.
- **The admin side does not exist at all.** `ADMIN_COLUMN_CONFIG`, `TARGETS`, `STATE_DEMAND`,
  `OPERATING_HOURS` and `IDEAL_DOW_SPLIT` are all hardcoded constants standing in for settings.
  `ADMIN-MAPPING.md` specifies the storage each one needs.
- **Open with Courtney:** Saturday closes at 8 PM ET (5 PM Pacific), so the 3–7p local window does
  not hold out west on Saturdays, and the Saturday 8% may want weighting toward Eastern and Central.

Full detail and the remaining open questions are in `HANDOFF.md`.

## Conventions

- Data is generated deterministically (`mulberry32`, seed `20260805`) and `TODAY` is pinned to
  Aug 5 2026, so every reviewer sees identical figures. Changing the seed or `TODAY` changes every
  number quoted in `HANDOFF.md` and the README.
- ES5-style code throughout (`var`, `function`, IIFEs) — match it.
- **No status is ever colour-alone.** Every status ships as a dot plus a text label, because brand
  coral sits close to status-critical red (ΔE 9.7 light / 6.8 dark, against a floor of 15). This is
  a known, accepted condition whose entire mitigation is the text label. A bare coloured dot breaks
  it. Meter bars are the one component carrying meaning by colour alone, so they use their own
  validated contrast-safe ramps rather than the status tokens.
- Do not substitute chart series colours without re-validating — slot order is the
  colourblind-safety mechanism, not decoration.
