# Affiliate Dashboard — mock-up handoff

**From:** Logan Randall
**For:** Sagar Farid and Zakira (build), Michael McMillan and Courtney Barrett (review)
**Date:** August 5, 2026

---

## What this is

Six clickable screens showing what the partner portal dashboard should look like and how it
should behave. Static HTML, CSS and vanilla JavaScript with fabricated but internally consistent
data — no framework, no build step, nothing that implies a stack change. **The system is PHP and
stays PHP.** Every interaction here is a form GET and a query-string state change, which is the
shape a PHP build takes anyway.

Open `index.html` in a browser. No server needed.

---

## The four Heritage defects, and where each is fixed

These are the minimum bar. Everything else is upside.

| Defect | Fix | Where |
|---|---|---|
| Date ranges don't work | Eight working presets plus custom, all recomputing every figure on the page | Filter row, every screen |
| Only current-month total renders | Today / Yesterday / Last 7 / 14 / 30 / This month / Last month all work; **Last 7 days is the default** | `data.js` → `resolveRange()` |
| Accept counts are visibly wrong | Accepted = `COUNT(status='paid')`, acceptance = paid ÷ raw, shown side by side so the arithmetic is checkable on sight | Performance tiles |
| Can't tell which leads sold | Sold-type column on every lead, plus counts and rates at campaign and sub-ID level | Leads table, Performance |

---

## Screens

| File | Module | What it covers |
|---|---|---|
| `index.html` | A | Performance overview — date range, headline tiles, daily charts, campaign and sub-ID breakdown, rejection reasons |
| `leads.html` | B | Per-lead detail, plain-language rejection reasons, CSV export |
| `duplicate-check.html` | C | 365-day Priority/Hot phone lookup, single and bulk |
| `health.html` | D | Health score, tier badge, four pillar sub-scores, 90-day trend, coverage asks |
| `setup.html` | E | New-affiliate first-login walkthrough |

The RevShare vs CPL difference is demonstrated with the **"Viewing as"** selector in the header.
That selector is a **mock-up affordance only** — see the next section.

---

## The one thing I most want the build to copy

**Visibility is a query-layer rule, not a UI toggle.**

`assets/js/data.js` → `queryLeads()` builds every returned row field-by-field from a per-partner-
type **allowlist**. A column a partner may not see is never copied onto the object, so it cannot
be read out of the DOM, the CSV export, or the browser console. In PHP that means two different
SELECT lists, not one SELECT plus an `if` in the template:

```php
// RevShare partner
SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status, l.reject_reason,
       l.sold_type, l.sold_at, l.days_to_sale,
       l.sale_amount, ROUND(l.sale_amount * p.rev_share_pct, 2) AS partner_share
  FROM leads l JOIN partners p ON p.id = l.partner_id
 WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

// Flat / tiered CPL partner — sale_amount is not in the statement AT ALL
SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status, l.reject_reason,
       l.sold_type, l.sold_at, l.days_to_sale
  FROM leads l
 WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?
```

Columns that appear in **neither** list, for **any** partner type including RevShare:

```
lead_cost · margin · margin_pct · buyer_name · csr_name · call_result
ipqs_score · ipqs_rules_fired · clawback_reason · campaign_cost
```

**In production there is no partner-type selector.** Partner type comes off the session and
cannot be chosen. The selector exists here only so reviewers can see both views.

### The row rule: for CPL partners, a rejected lead dies at the door

This is a **row-level** rule on top of the column allowlist, and it is the more important half.

A lead we decline can still sell — at auction, at marketplace, occasionally at Hot or Priority —
and it costs us nothing because we never paid for it. A CPL partner must never learn that
happens. From their side a rejected lead shows **its reason and nothing further**: no sold type,
no sold date, no days-to-sale, no price, no buyer, no call result.

Two things this requires that a column allowlist alone will not give you:

```php
// 1. Null the outcome columns on rejected rows
CASE WHEN l.status = 'paid' THEN l.sold_type END AS sold_type   -- and sold_at, days_to_sale

// 2. Any query that filters BY sold_at must ALSO exclude rejected rows outright
AND l.status = 'paid'
```

Point 2 is easy to miss and it leaks on its own: if a CPL partner can run a sold-date report,
the **row count alone** tells them we work leads we declined, even with every column nulled.

**RevShare is the exact opposite** — they are paid 40% of any sale, accepted or not, so hiding
rejected-but-sold leads would understate what we owe them. In the mock data that is **158
rejected-but-sold leads worth $3,562, about 8.8% of total RevShare earnings.** Real money, and
it was invisible in the first version of this prototype because the generator never let a
rejected lead sell.

Verified on the mock: across 1,560 rejected rows in the CPL projection, **zero** carry any
outcome or revenue field, and all 1,560 retain their rejection reason. A sold-date query returns
**zero** rejected rows. Those are the properties the build needs to preserve.

### Acceptance means different things to the two partner types

| | CPL | RevShare |
|---|---|---|
| Paid on | accepted leads | any lead that sells, accepted or not |
| Acceptance rate is | **the invoice** | a **quality signal** to optimise against |
| Conversion rate denominator | matured **accepted** leads | **all** matured leads submitted |

The denominator matters. Dividing a RevShare partner's sales by accepted leads alone overstates
their conversion rate and understates the value of the volume they send. `computeMetrics()` takes
a `rateBasis` of `'paid'` or `'all'` for exactly this.

One deliberate exception: the **health score always uses the accepted basis**, for every partner
type. Its tier thresholds are calibrated that way, and rescoring RevShare partners on the lower
all-leads rate would drop them a tier for no reason other than a change of denominator. The
scorecard labels that component "of accepted" so the two pages read as two different questions
rather than a contradiction.

---

## Brand palette

Themed to the Financialize mark — navy `#1E2739`, coral `#F0604A`, white. The navigation rail
is navy in **both** light and dark mode, because it is the strongest brand signal on the page.
Dark mode is effectively the brand image: navy plane, navy cards, white ink, coral accent.

Every colour that touches a chart was run through the palette validator against the surface it
actually renders on. Two results worth carrying into the build:

- **Brand coral is used as-is in light mode, but steps to `#E4573D` in dark.** The brand value
  sits at lightness 0.67 — exactly on the dark-mode band ceiling — and fails. `#E4573D` is the
  nearest passing step.
- **Coral sits close to status-critical red** (ΔE 9.7 light, 6.8 dark, against a floor of 15).
  This is accepted, not overlooked — the reference palette carries the same situation at ΔE 4.8.
  The mitigation is that **no status in this UI is ever colour-alone**: every one is a dot plus a
  text label. If a bare coloured dot with no label ever ships, that rule breaks and the two reds
  become genuinely ambiguous.

Meter bars are the one component that *does* carry meaning by colour alone, so they use their own
contrast-safe ramps rather than the status tokens — `#fab219` is only 1.83:1 on white and cannot
legally anchor an ordinal ramp there. All eight track/fill pairs are validated. The exact hexes
and the re-validation command are documented at the top of `assets/css/dashboard.css`.

Charts resolve their colours from CSS variables **at render time**, not at mount, so a light/dark
flip repaints with that theme's own validated step.

> **The logo is a placeholder.** `BRAND_MARK` in `assets/js/app.js` is a geometric stand-in drawn
> to match the real mark's colours and proportions. **Drop in the actual SVG asset before this
> goes in front of a partner.**

---

## Attribution — please read this one, it is the easiest thing to get wrong

Leads take 9–12 days to cook. That single fact decides how three different kinds of number have
to be windowed, and mixing them up is what makes a report look broken.

| Question | Attributed to | Example |
|---|---|---|
| "What did I send, did it get accepted?" | the **received** date | Leads submitted, accepted, acceptance rate, rejection reasons |
| "What sold this week, what did I earn?" | the **sold** date | Priority/Hot counts, earnings, median sales cycle |
| "How good is my traffic?" | trailing **30-day matured cohort** | Priority/Hot conversion **rate**, health score |

My first pass attributed outcomes to the received date. The default 7-day view then reported
**0.0% Priority/Hot and $0 earnings** — not because nothing sold, but because nothing sent that
recently has had time to. A partner reads that as "the numbers are wrong again," and they would
be right. `queryLeadsBySold()` in `data.js` exists for exactly this reason, and the column bases
are labelled in the footer of every table that mixes them.

Rates are the third case and cannot use either window: a rate needs a cohort that has finished
maturing, so it is always the trailing 30 days with a 10-day buffer — the same basis the health
score uses, so the Performance page and the scorecard can never disagree.

---

## Spend & volume targets — NOT BUILT, needs an admin screen

The affiliate-facing half is mocked (targets card on Performance, plus a dashed target line on
Leads by day). **The admin side does not exist and needs building.** What it needs to store:

| Field | Notes |
|---|---|
| `partner_id` | required |
| `campaign_id` | optional — targets should be settable per campaign or account-wide |
| `period` | calendar month to start with |
| `volume_target` | integer, nullable |
| `spend_target` | decimal, nullable |

**Either, or, or both.** A null target means *not set*, not zero — it must not render at all, and
must not count as a missed target. The mock shows both states: the RevShare partner has volume
and payout targets, the CPL partner has volume only.

Two things the mock settled that are worth keeping:

- **Pace, not just progress.** "209 / 1,500" on day 5 of 31 is not useful on its own. The card
  shows expected-by-today, ahead/behind, and the daily rate needed to close the gap.
- **Severity is judged against pace, not against the monthly total.** My first pass flagged 14%
  of a monthly target as critical on day 5, which is nonsense — it was on track. Severity now
  compares actual against expected-to-date.

Note that a RevShare payout target must be measured on the **sold** date, not the received date,
or it reports $0 for the first ten days of every month. CPL spend stays on the received basis
because we owe on acceptance. Same attribution rule as everything else below.

---

## Gating data dependencies — for Zakira

Nothing below is a nice-to-have; each one blocks a specific thing already drawn in the mock-up.

| Field | Blocks | Status |
|---|---|---|
| **`sold_type`** as distinct labels — Priority / Hot / Auction / Marketplace | The North Star metric, the entire scorecard, the sold-type column. The current lead table cannot separate Priority from Hot. | **Blocking.** Nothing affiliate-facing is worth shipping without it. |
| **`subid`, `click_id`, `utm_campaign`, `utm_medium`** | Sub-ID drilldown, publisher-level scoring, Madrivo's core requirement | **Blocking** for Module A drilldown |
| **`speed_to_lead`** (seconds, receipt → first dial) | Operations pillar | Pillar is **parked** in the mock until this lands |
| **`call_attempts_to_convert`** | Operations pillar, Courtney's internal view | Parked |
| `campaign_id` + received/sold timestamps | — | Already on the table |

The Speed & operations pillar is **excluded and the remaining three renormalised to 100**, rather
than scored zero. Scoring a missing pillar as zero would silently cap every partner at 90 and
make the model look broken. The UI shows it as parked. When the two fields land, set
`parked: false` in `health.js` and the weights snap back on their own.

### Two data-integrity problems that will corrupt the score if not fixed first

1. **The $1/lead phantom COGS on rev-share campaigns.** Every accepted rev-share lead is billed
   at $1 in Lead Cost though we owe $0 per lead — roughly $4,013 of fabricated cost on Heritage
   alone across two weeks, and about 16,000 rev-share leads system-wide. **Any margin-based
   pillar computed on this data is wrong.** Must be set to $0 before the Economics pillar means
   anything.
2. **Placeholder birth years on the aged-lead import.** 1,923 of 1,932 accepted leads on the
   Heritage aged-leads campaign carry a YOB of 2000 or 1992 — ages 26 and 34, well outside the
   45–75 criteria, accepted and billed anyway. The age filter is not catching it. Any quality
   pillar reading that campaign is reading noise.

---

## Notes on specific screens

**Performance.** Campaigns are broken out natively. Blended, a small excellent campaign and a
large low-yield one read as one mediocre campaign — the fresh-vs-aged Heritage split is the live
example, where 3.6% of volume produced 82% of revenue. The dashboard must never reproduce that
blending for the affiliate.

**Leads.** Defaults to Last 30 days rather than 7, deliberately: at 7 days every row's sold
column is still blank, which is the exact complaint this replaces. CSV export covers the full
filtered set, not the visible page — this is the file currently assembled by hand every day.

**Duplicate check.** Returns a boolean and at most the month it last sold. Nothing else. This is
a suppression-list API in disguise, so the containment has to be in the design: rate-limit per
partner per day, log every query with the partner ID, and reject oversized bulk jobs rather than
truncating them silently. A partner who can query without limit can enumerate the database one
number at a time. The 365-day window is the Priority/Hot exclusivity period, so the feature is
internally consistent with the existing rules.

**Health scorecard.** Tiers reconcile with the Scale / No-Scale scorecard: 45–59 "Watch"
corresponds to yellow. One number, not two. Rolling 30-day window, refreshed weekly on the Monday
allocation cycle, gated at 100 matured paid leads — below that it renders as **Provisional**
rather than pretending to be precise.

**Setup flow.** Scope is reconstructed and **needs confirming with Michael**. It must also be
scoped against Marc Heberling's automated pixel-validation work — this should be the affiliate-
facing front end to his backend, not a second implementation. The first test post deliberately
fails with a reason and a fix, because that is what actually happens and seeing the reason is the
point of the step.

---

## Open questions I still owe answers on

1. **Portal vs PostHog.** Michael told Heritage that PostHog plus Looker is the affiliate exposure
   point and told me to fix the portal. My read: the portal is for partners who will not build
   their own consumption layer, and the API/PostHog path is the same data served differently for
   sophisticated partners like Heritage. Needs confirming so we don't build the wrong surface.
2. **Age range vs exact date of birth.** Jake says asking for DOB is high-friction and costs him
   lead production; Courtney says an exact year of birth makes the call fluid and confirmable.
   I owe Heritage an answer on whether the API supports custom fields for ranges. This is a
   product decision, not just a technical one.
3. **Does the affiliate see the same score we do?** In this mock, **yes** — same number, pillar
   sub-scores shown, but the margin input and its weight are not displayed, so it cannot be
   reverse-engineered into our economics. Michael's Jul 7 read leaned this way: "all you're doing
   is you're giving them a number." Flagging it because it is a real decision.
4. **Setup-flow scope** — see above.
5. **Heritage's metrics wishlist** never arrived. Chasing Brayden; it is free requirements-
   gathering from our most engaged partner.
6. **TOPS / API access from Mark B** — open since Jul 29. Not needed for this mock-up, definitely
   needed for the build.

---

## What is fake

Everything numeric. ~4,700 leads across four OptiLabX campaigns and 13 sub-IDs over 120 days,
generated deterministically so every reviewer sees identical figures. Rejection-reason mixes,
sold-type rates and sales-cycle distributions are shaped to look like real traffic, not to
flatter anybody. Credentials, API keys and tracking URLs on the setup screen are invented.

What is **not** fake: the metric definitions, the redaction rules, the attribution model, the
scoring weights, the tier thresholds, and the field list above. Those are the deliverable.
