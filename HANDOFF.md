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
| `partnership.html` | 0 | Partnership summary — who they are, active campaigns with CID and comp model, account terms, our operating hours |
| `index.html` | A | Performance overview — date range, headline tiles, daily charts, campaign and sub-ID breakdown, rejection reasons |
| `leads.html` | B | Lead table — every column available to that affiliate, exact system values, CSV export |
| `duplicate-check.html` | C | **Duplicates & suppression** — the suppression file leads the page, then the 365-day Priority/Hot lookup, single and bulk |
| `health.html` | D | Health scorecard — the score dial as the hero, pillar breakdown, 90-day trend, and a collapsible "how the score is built" |
| `targeting.html` | — | Call-centre hours, ideal send windows and day split, lead criteria, and the top-10 states we need |
| `setup.html` | E | **Setup & docs** — a hub: new/edit campaign (both placeholders), the document library, and who to contact |
| `account.html` | — | Account, users and contacts |

Plus **three temporary, internal, non-partner-facing** pages under an "Internal — temporary"
heading in the nav:

| File | What it is for |
|---|---|
| `admin-preview.html` | **Admin settings.** The build list — every setting the portal needs, what it controls, the storage it needs, and why it matters. Then previews of the screens themselves. |
| `data-source.html` | **Data connections.** Every live value on the portal, the field behind it, whether we have it today, and how it needs to connect. Plus the data-quality blockers. |
| `assets/js/handoff.js` | The registry **both of those pages render from**, so the field side and the settings side cannot drift apart. |

**Delete all three, and the `INTERNAL_NAV` entry in `app.js`, before anything ships.** The
long-form reasoning stays in **[ADMIN-MAPPING.md](ADMIN-MAPPING.md)**, which is the document to
keep current as fields are added.

The revenue-share vs CPL difference is demonstrated with the **"Viewing as"** selector in the
header. That selector is a **mock-up affordance only** — see the next section.

---

## The one thing I most want the build to copy

**Visibility is a query-layer rule, not a UI toggle.**

`assets/js/data.js` → `queryLeads()` builds every returned row field-by-field from an
**allowlist**. A column an affiliate may not see is never copied onto the object, so it cannot be
read out of the DOM, the CSV export, or the browser console. In PHP that means two different SELECT
lists, not one SELECT plus an `if` in the template:

```php
// Lead from a REVENUE-SHARE campaign
SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status, l.reject_reason,
       l.sold_type, l.sold_at, l.days_to_sale,
       l.sale_amount, ROUND(l.sale_amount * c.rev_share_pct, 2) AS partner_share
  FROM leads l JOIN campaigns c ON c.id = l.campaign_id
 WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

// Lead from a FLAT / TIERED CPL campaign — sale_amount is not in the statement AT ALL
SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status, l.reject_reason,
       l.sold_type, l.sold_at, l.days_to_sale
  FROM leads l
 WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?
```

Columns that appear in **neither** list, for **any** comp model including revenue share:

```
lead_cost · margin · margin_pct · buyer_name · csr_name · call_result
ipqs_score · ipqs_rules_fired · clawback_reason · campaign_cost
```

**In production there is no partner selector.** The partner comes off the session and cannot be
chosen. The selector exists here only so reviewers can see both views.

### COMP MODEL IS A PROPERTY OF THE CAMPAIGN, NOT THE ACCOUNT

This changed in August. A partner can run revenue-share and CPL campaigns side by side, so the
projection is resolved **per row**, from that row's campaign. A mixed account gets revenue columns
on its rev-share rows and no revenue field at all on its CPL rows, in one table.

Both current partners happen to run a single comp model across all their campaigns — Heritage all
revenue share, OptiLabX all CPL, on their real terms. The schema does not assume that and neither
does the query layer. **Do not reintroduce a single per-account branch.**

### Which columns are available is admin-configurable, per comp model

Two pieces, both in `data.js`:

- **`LEAD_COLUMNS`** — the registry. One entry per affiliate-visible column, declaring which comp
  models *may* see it. **Adding a column later is one entry here and nothing else** — the lead
  table, the CSV export and the admin screen all read this list.
- **`ADMIN_COLUMN_CONFIG`** — what an admin screen writes: per comp model, which registry columns
  are switched on.

The registry is a **hard constraint, not a default.** An admin cannot switch on a revenue column
for a CPL campaign, because the registry does not list `cpl` on those entries. Columns marked
`locked` — identity, status, and the rejection reason — cannot be switched off at all. A partner
cannot fix what they cannot see, and hiding the rejection reason recreates the exact complaint this
dashboard replaces.

Storage, and the rest of the admin surface, is specified in **[ADMIN-MAPPING.md](ADMIN-MAPPING.md).
Keep that document current** — a feature that renders but has no row there is a feature nobody
knows how to populate in production.

### This report is read BY THE AFFILIATE — the framing rule

Everything in the portal is written for the partner, not for us. That is not a copy
preference; getting it wrong leaks commercial position.

The health score originally used the internal Scale / No-Scale vocabulary verbatim. A partner
scoring below 45 was shown the word **"Intervene"**, and the action text read *"Two options:
pause, or move CPL to the level that restores a 45%+ margin."* That tells a partner our margin
floor, names our pricing lever, and reads as a threat rather than as feedback.

The bands are now named for what is true of **their traffic**, and every action is something
**they** can do:

| Score | Internal (ours) | What the affiliate sees |
|---|---|---|
| 80–100 | Scale | **Excellent** |
| 60–79 | Healthy | **Healthy** |
| 45–59 | Watch | **Needs attention** |
| 0–44 | Intervene | **Lead quality issue** |

Thresholds are unchanged, so this still reconciles with the Scale/No-Scale scorecard — only the
words differ. `TIERS[].internal` keeps our own label for internal tooling.

The same sweep removed, from every affiliate-facing page: the margin floor, "allocation",
"clawback / over-unfire", the sold-type **point system** (a partner learns nothing from "0.02
points per paid lead" — it now reads *"Share of sales in the top tiers: 78.4%"*), "What we do at
this tier", and the note admitting the score includes a hidden margin input they cannot see.
Pillar names changed too: *Economics* → **Conversion & value**, because "economics" reads as
**our** economics, which is exactly what a partner must not be scored against in public.

**When adding any copy to a partner-facing page, the test is: would I be comfortable if the
affiliate read this line aloud on a call?**

One more vocabulary fix, Aug 6: a scoring pillar we have not built yet used to render as
**"Parked"**. To us that means "excluded from the weighting, coming later"; to a partner it reads
like their account has been shelved. It now reads **"In development."**

---

### The descriptor pattern — say less on screen, explain on hover

Added Aug 6, and it is the main tool for keeping affiliate-facing pages readable.

Anything that needs explaining carries a small **i** button to its right; hovering it shows a
short box. The label stays short. `FZApp.tip(text)` renders the button, and `app.js` manages one
shared box for the page.

This replaced a habit of writing the explanation *into* the label — the rejection reason
`Duplicate` used to render as *"Duplicate — sold as Priority/Hot in last 365 days"*, which is
accurate, unscannable in a table, and still not enough to explain the exclusivity window. Now the
cell says `Duplicate` and the hover says the rest.

It also resolves a real tension with the fidelity rule below. A cell has to show the system's own
value **and** a partner has to be able to understand it; those two requirements fight each other
until the explanation moves off the label.

### The fidelity rule — cells show what the system recorded

Also Aug 6. **A table cell renders the value the system actually stored, verbatim.** The rejection
reason column shows `Duplicate`, `IPQS`, `Age Filter` — the exact strings, not paraphrases.

This is about reconciliation, not pedantry. An affiliate querying an invoice, or Zakira diffing
this portal against a report cut straight from the database, must be able to match rows cell for
cell. A portal that translates values into friendlier prose cannot be used as evidence in either
conversation.

The one exception is documented: the ~2,700 rows whose reject reason is a raw XML filter payload
have no usable value to show, so they fall back to a plain-language bucket label. Fixing the
reject-reason column at source retires that fallback.

---

### DECISION — sold type is visible to BOTH comp models, with one asymmetry

Confirmed by Logan, Aug 6. This is the rule, and it is already enforced at the query layer:

| | CPL campaigns | Revenue-share campaigns |
|---|---|---|
| Sold type on **accepted** leads | **Visible** — they need to see which of their leads reached Priority or Hot | **Visible** |
| Sold type on **rejected** leads | **Blank.** They must never learn we work or sell a lead we declined | **Visible** — they are paid on it |
| Sale amount / revenue | **Never** | **Visible on every lead** |
| Exportable for their own analysis | Yes, minus revenue | **Yes, everything** |

Verified against the real export: OptiLabX (CPL) — all 2,094 accepted leads carry a sold type,
625 of them sold and **440 reached Priority or Hot**; all 2,528 rejected rows carry **no
sold-type key and no revenue key at all**, and zero revenue fields exist anywhere on that
projection. Heritage (revenue share) — all 56,309 rows carry both sold type and revenue,
including **43 rejected-but-sold leads**, each showing its $500 sale and $200 share.

The revenue-share export deliberately includes sold type on every row so the partner can run
their own analysis on what converts and retarget against it.

---

### DECISION — rejected-but-sold leads ARE visible to RevShare partners

**This overrides the affiliate context document.** That doc (§16) lists "rejected-but-sold rows"
under *never exposed to any partner, rev-share included*, and cites the July 31 Heritage
spreadsheet as the failure mode. **Logan ruled on August 5 2026 that the doc is wrong on this
point:** RevShare partners do get to see that rejected leads are being worked and which of them
convert.

The reasoning holds up. A RevShare partner is paid 40% of any sale, accepted or not. Hiding those
rows would understate what we owe them and make their invoice impossible to reconcile — Madrivo's
framing of the whole point is *"to make sure our revenue and lead amounts match up."* What made
the July 31 leak a leak was the **Profit column, Buyer Name, CSR Name and Call Result**, all of
which remain forbidden to everyone.

In the mock data this is **262 rejected-but-sold leads worth $6,791 — about 11.5% of revenue-share
earnings.** Not a rounding error.

**For CPL campaigns nothing changes: the affiliate must never learn these exist.** See the row rule
below.

---

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

**Revenue share is the exact opposite** — they are paid 40% of any sale, accepted or not, so hiding
rejected-but-sold leads would understate what we owe them. Real money, and it was invisible in the
first version of this prototype because the generator never let a rejected lead sell.

Verified on the mock: across **1,680** rejected rows in the CPL projection, **zero** carry any
outcome or revenue field, and all 1,680 retain their rejection reason. A sold-date query returns
**zero** rejected rows. The CPL projection exposes 15 columns and the revenue-share projection 18,
with none of the forbidden fields present on either. Those are the properties the build needs to
preserve.

### Acceptance means different things to the two comp models

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

## Partner-specific criteria exceptions — must be carried everywhere

The two demo partners are the real ones, on their real terms:

| | Comp | Products | Integration | Accepted age band |
|---|---|---|---|---|
| **Annuity Heritage Group** | 40% revenue share | Annuity | Their funnel → our API | 45–75 (standard) |
| **OptiLabX Media** | Tiered CPL $102 / $90 / $27 | Annuity + Life | Our landing pages | **45–79 (negotiated)** |

OptiLabX's band is a **commercial term, not a data error.** It has already cost us twice — a
$5,194 invoice variance and 55 leads (~$4,000) wrongly flagged on a July unfire list.

Every criteria label in this UI renders through `rejectLabel(reason, partnerType)`, so an
OptiLabX lead reads *"Age outside 45–79 criteria"* and a Heritage lead reads *"45–75"*. **If the
build ever computes acceptance or eligibility, it has to be exception-aware the same way** — a
hardcoded 45–75 anywhere will misreport our largest partner.

---

## New sale tiers — POINTS NEED MICHAEL'S SIGN-OFF

Appointment booking (~$750) and Live transfer (~$1,000) launched this month. Both are modelled,
both appear in the tier mix, and both sit above Priority. The point values are **my proposal, not
a decision**:

| Tier | Price | Points | Source |
|---|---|---|---|
| Live transfer | ~$1,000 | **14** | proposed |
| Appointment | ~$750 | **12** | proposed |
| Priority | ~$500 | 10 | Michael |
| Hot | ~$400–475 | 8 | Michael |
| Auction | low | −3 | Michael ("negative") |
| Marketplace | ~$10–20 | −4 | Michael ("negative") |

The North Star metric deliberately still counts **Priority + Hot only** — that is Michael's KPI
and I did not redefine it. The new tiers are reported alongside rather than folded in. If they
should count toward the headline number, that is a one-line change and his call.

Also: the revenue-share rate is now per-partner rather than hardcoded at 40%, because
annuity.org runs at 85%.

---

## Spend & volume targets — CPL only, NOT BUILT, needs an admin screen

**Revenue-share partners get no target at all — confirmed by Logan, Aug 2026.** They can send as
much or as little as they want; the lead health score is what governs them. This whole feature is
CPL-only, and it's built that way from the query layer up: every function returns `null`
immediately for a revenue-share partner.

The affiliate-facing half is mocked (targets card on Performance, per-day dashed reference on
Leads by day) and the admin side is mocked as a **read-only illustration** on `admin-preview.html`.
**Neither has real storage or a working input form yet — full spec in `ADMIN-MAPPING.md` §4,**
including the schema, the day-of-week weighting, and the internal `R` figure the math runs on.
The short version:

- **Margin and CPL are the same lever, twice.** `CPL = R × (1 − margin)`, where `R` is our
  trailing revenue per accepted lead — internal only, exactly like margin itself. Admin sets
  either one and the other is derived.
- **Volume and spend are the second either/or pair**, linked through CPL: `Spend = Volume × CPL`.
  Volume is defined in **accepted** leads, matching how CPL is invoiced.
- **Weekly, not monthly** — Sunday–Saturday, matching the real Friday-night budget-distribution
  cadence. An earlier version of this mock assumed calendar months; that was wrong.
- **The daily chart reference varies by day of week and defaults Sunday to 0%,** rather than one
  flat number — a partner who is told "0 on Sunday" should be able to see that on the chart, not
  just read it in a sentence.

Two things the mock settled that are worth keeping:

- **Pace, not just progress.** "209 / 1,500" on day 1 of 7 is not useful on its own. The card
  shows expected-by-today, ahead/behind, and the daily rate needed to close the gap.
- **Severity is judged against pace, not against the period total.** Flagging 14% of a weekly
  target as critical on day 1 would be nonsense if day 1 is actually on track. Severity compares
  actual against expected-to-date within the week.

---

## Gating data dependencies — for Zakira

Nothing below is a nice-to-have; each one blocks a specific thing already drawn in the mock-up.

| Field | Blocks | Status |
|---|---|---|
| **`sold_type`** as distinct labels — Priority / Hot / Auction / Marketplace | The North Star metric, the entire scorecard, the sold-type column. The current lead table cannot separate Priority from Hot. | **Blocking.** Nothing affiliate-facing is worth shipping without it. |
| **`subid`, `click_id`, `utm_campaign`, `utm_medium`** | Sub-ID drilldown, publisher-level scoring, Madrivo's core requirement | **Blocking** for Module A drilldown |
| **`speed_to_lead`** (seconds, receipt → first dial) | Operations pillar | Pillar is **parked** in the mock until this lands |
| **Unfire feed** — lead id, unfire timestamp, affiliate-safe reason code, amount credited *(Sagar to connect)* | The Clawback report on the Compensation page. The export carries only a `returned` flag — no date, reason, or amount, so those columns render as absent rather than invented | **Blocking** for the Clawback report. The reason code must be the affiliate-safe `RETURN_REASONS` vocabulary, never the internal `clawback_reason` |
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

**Partnership summary.** The landing screen. Affiliate name and status, every active campaign with
its CID, name, product and comp model, and a **View details** button that carries that campaign
onto Performance with the filter already applied — the same query-string state the filter row
writes, not a special-case route. Below that, the commercial terms (comp model, products,
integration, **the negotiated age band**, billing, exclusivity) and our call-centre hours.

**Lead table.** Renamed from "Leads" and stripped of its summary tiles — Performance is where
aggregates belong, and having them in both places invited the two screens to disagree. It is now a
direct table showing **every column available to that affiliate**, rendered from the registry, with
the rejection-reason grouping kept underneath. Defaults to Last 30 days rather than 7, deliberately:
at 7 days every row's sold column is still blank, which is the exact complaint this replaces. Export
covers the full filtered set, not the visible page — this is the file currently assembled by hand
every day, and it serialises the same projected rows, so it cannot carry a column the table is not
allowed to show.

**Export — CSV works, Google Drive is mocked.** The CSV path is real. The Drive path shows the
confirmation an affiliate would see and **nothing leaves the browser**. Wiring it up needs a
Drive OAuth scope per partner plus a service account and a destination folder convention; none
of that exists. Do not assume that half is built.

**Three affiliate-facing stats were added** beyond the original spec, each because the context
made the case for it:

- **Investable-asset band performance**, with $100K–$250K flagged. It converts materially better
  and holds across months — the highest-leverage targeting change most partners can make.
- **Arrival-window performance**, against the two ideal reception windows. See the correction
  below — an earlier version of this asserted a 6–9a "golden window" that was invented.
- **Tier mix and average sale price**, explicitly requested by Heritage. Revenue share sees the
  earnings column; CPL sees the mix and share only, because sale price is revenue.

### CORRECTION — the 6–9a "golden window" was invented, and is gone

Earlier versions of this mock asserted that 6–9a arrivals converted far better, and both the
Performance arrival card and the health score's coverage pillar were built on it. **It was
fabricated, it predated the real call-centre hours, and it contradicted them — the floor does not
open until 9a.** A lead arriving at 6:30a sits for two and a half hours before anyone can dial it.

The real hours, which everything about timing now derives from:

| | |
|---|---|
| Monday–Friday | 9:00 AM – 7:00 PM local time in every timezone we cover (9:00 AM – 10:00 PM ET end to end) |
| Saturday | 9:00 AM – 8:00 PM ET, lighter staffing |
| Sunday | Closed |

**Ideal reception windows**, consumer local time, Mon–Fri: **9:00–11:00 AM** and **3:00–7:00 PM**.

The mock's arrival-window distribution and conversion lifts were reshaped to match, so the
Performance card and the coverage widgets now agree rather than starring different hours. **This
changes every conversion figure quoted in this document from earlier versions.**

### Coverage asks are now three widgets

Replacing the old two-row table on the scorecard:

1. **States we need** — the states we want more volume in.
2. **Ideal send windows** — the two windows where contact is fastest.
3. **Ideal daily split** — Mon 20% / Tue 19% / Wed 19% / Thu 19% / Fri 15% / Sat 8% / **Sun 0%**.

**Amended Aug 6 — the states widget is now a top-10 list of state names and nothing else.** It
previously showed unused budget in dollars and the implied leads needed. That is our unspent
budget: it tells a partner exactly how much room we have and how badly we need them, which is our
negotiating position and not theirs. The ranking is still computed from budget internally; only
the ranked names are projected. **It also changes often, so it needs to be genuinely easy to
reorder in the admin** — a stale list is worse than none, because partners will chase states we
no longer need.

**All three are asks, not rules, and the framing is not optional.** Every rendering carries the
note: we accept leads any day and any hour; these are the windows where our team is working hardest
and where leads convert best, so weighting sends this way gets faster contact and a better read on
their traffic. A partner who reads these as gates sends less, not better.

Sunday is 0% because nothing sent Sunday is worked until Monday morning. In the current mock the
demo partner sends 8% on Sunday, which is the single biggest deviation and exactly the kind of
free improvement this widget exists to surface.

**Two consequences still open with Courtney**, both flagged in ADMIN-MAPPING.md §5b:

- **Saturday closes early out west.** 8 PM ET is 5 PM Pacific, so a Saturday afternoon California
  lead has a much shorter working window than the same lead on a Tuesday. Given Pacific and
  Mountain are already the standing coverage gap, that argues for weighting the Saturday 8% toward
  Eastern and Central rather than spreading it evenly.
- **The 3–7 PM local window does not hold on Saturdays** — it collapses to 3–5 PM Pacific and
  3–6 PM Mountain. For a partner running western states the Saturday *morning* window is the one
  that works cleanly. The dashboard shows this as a caveat, but only to partners actually running
  western states.

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

Everything numeric. ~10,000 leads across seven campaigns and 20 sub-IDs over 120 days, generated
deterministically so every reviewer sees identical figures. Rejection-reason mixes, sold-type rates
and sales-cycle distributions are shaped to look like real traffic, not to flatter anybody. The
per-state budgets and fill rates behind the coverage widget are invented, though the shape is real:
Pacific and Mountain are genuinely where we are short. Credentials, API keys and tracking URLs on
the setup screen are invented.

What is **not** fake: the metric definitions, the redaction rules, the attribution model, the
scoring weights, the tier thresholds, the field list above, the call-centre operating hours, and
the ideal send windows and daily split. Those are the deliverable.

Because the data is deterministic, **changing the seed, `TODAY`, or `HOUR_YIELD` in `data.js`
changes every figure quoted in this document.** The current numbers were re-verified against the
running mock on Aug 5 2026.
