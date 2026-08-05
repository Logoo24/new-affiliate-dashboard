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

I verified this on the mock: across 3,610 rows in the CPL projection, zero revenue or internal
fields are present on any row object. That is the property the build needs to preserve.

**In production there is no partner-type selector.** Partner type comes off the session and
cannot be chosen. The selector exists here only so reviewers can see both views.

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
