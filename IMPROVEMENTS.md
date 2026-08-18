# Improvement plan — making the portal more valuable to the affiliate

*Logan Randall · drafted Aug 6 2026 · companion to `HANDOFF.md` (what exists) and
`ADMIN-MAPPING.md` (how it connects)*

This is the forward plan: what would make this dashboard genuinely useful to a partner, beyond
reporting what already happened. Ordered by the affiliate's own priorities, not ours — the test
for every item is **"does this help a partner send more volume that makes us both money, with
less back-and-forth?"**

Everything here respects the standing constraints: the redaction rules in `HANDOFF.md` are not
loosened by any of it, comp-model visibility stays exactly as decided, and it all has to be
buildable in the existing PHP system.

---

## 1. Money questions first — the affiliate's #1 job is reconciling what we owe them

The portal reports performance well, but a partner's accounting team lives in a different
question: *"what will the check be, and does it match our numbers?"*

| Improvement | What it looks like | Why it matters |
|---|---|---|
| **Earnings statement page** | A monthly statement view per partner: opening period, leads accepted (CPL) or sales attributed (rev-share), rate applied per campaign, returns/adjustments, total due, payment date, payment status. Downloadable as CSV/PDF. | Today the partner reconstructs their invoice from the lead table. A statement that matches the wire, line for line, removes the single largest source of support email — and the OptiLabX $5,194 variance shows what reconstruction errors cost. |
| **Payment history** | Past statements with paid date and amount. | "Did the June payment go out?" should never be an email. |
| **Pending vs settled earnings** | Rev-share: sales inside the current period marked *pending* until the statement closes; CPL: accepted-lead spend to date vs the weekly target. | Partners plan media buys against expected cash. Pending/settled removes the guesswork about what is real yet. |
| **Returns & adjustments visibility** | When a lead is returned/credited, it shows on the statement with its reason (from the affiliate-safe vocabulary — never the internal `clawback_reason`). | An unexplained deduction reads as us shorting them. An explained one reads as bookkeeping. |

*Depends on: billing terms per partner (B3), statement storage. The attribution rules are already
built — statements are the sold-date basis for rev-share and received-date for CPL, which
`targetProgress()`/`queryLeadsBySold()` already model.*

## 2. Tell them when something changes — alerts instead of archaeology

Everything in the portal today requires the partner to come looking. The highest-value moments
are exactly the ones they won't catch by browsing.

| Improvement | Trigger | Channel |
|---|---|---|
| **Rejection-spike alert** | Rejection rate on any campaign runs ≥2× its trailing 30-day norm for 24–48h | Email + a banner on Performance |
| **Health-tier change** | Score crosses a band boundary in either direction, after the Monday refresh | Email digest |
| **Target pace alert (CPL)** | Weekly volume pace falls behind the day-of-week expected curve by a threshold | Email + the existing pace chip |
| **Criteria/terms change notice** | We change their criteria, rates, targets, or the states list | Email, mandatory — a criteria change they discover via rejections is a relationship cost |
| **Weekly digest** | Monday, after the score refresh | One email: score, WoW volume/quality deltas, top rejection reason, states list changes |

Design rule: **alerts link to the filtered view that explains them** (the query-string
architecture makes every state linkable already — that is the payoff). No alert without a
click-through that lands on the evidence.

*Depends on: an email pipeline and per-user notification preferences on `affiliate_users` (B2).
All of the triggers are computable from data the portal already derives.*

## 3. Close the loop before the lead is sent — pre-send tooling

The duplicate check and suppression file are the start of a genuinely differentiating idea:
**move quality control to before the affiliate spends money, not after.**

| Improvement | What it looks like |
|---|---|
| **Pre-send validation API** | One endpoint an affiliate can call before acquiring a lead: duplicate status + criteria pass/fail (age band, state, assets threshold) against *their* account's terms. Returns pass/fail per rule, never internal data. Rate-limited and logged like the duplicate lookup. |
| **Criteria as machine-readable spec** | Their negotiated criteria (the Targeting page) exposed as JSON from the same admin-managed source, so their form validation can be generated from it and never drift from what we actually enforce. |
| **Suppression adoption feedback** | A small card on Duplicates & suppression: *your duplicate rejection rate, 30d, vs the 30d before you started pulling the file.* The file's value, proven with their own number. (Same measurement proposed to Sagar internally.) |
| **Pixel test tool** | A tool in Setup & docs that verifies the affiliate's tracking pixel fires correctly on their landing page. (A test-lead sandbox was tried here Aug 6–7 and removed — checking a hand-typed lead against acceptance criteria isn't an affiliate need; confirming their integration works is. Build as the front end to Marc Heberling's pixel-validation work.) |

*This is the section with real competitive weight: most networks tell affiliates what got
rejected; almost none help them not buy the lead in the first place.*

## 4. Explain performance, don't just report it — insights the affiliate can act on

The data to answer "what should I change?" is already computed; it's just not framed as advice.

| Improvement | Built from |
|---|---|
| **"What to fix first" card** | Rank the partner's controllable losses by dollar impact: e.g. *"Duplicates cost you ~$1,900 in unpayable acquisitions last 30d — screen before you buy"* vs *"3% asset-band drift"*. The rejection mix, asset-band yields and CPLs are all already in the engine. |
| **Sub-ID scorecards** | Where sub-IDs exist, per-source acceptance / P&H rate / trend, with the same health framing as the account score. This is the single feature media buyers ask for first — it decides where *their* budget goes. (Blocked on A2 fill for the big accounts — which is itself an argument to partners: pass sub-IDs, get source-level intelligence.) |
| **Benchmark context** | "Your acceptance rate: 71% — network median for annuity: 64%." Aggregated, anonymized, never naming another partner. Makes a good score feel earned and a weak one feel fixable rather than punitive. |
| **Best-performing profile** | Which of *their own* segments (state × asset band × day) convert best to P&H, framed as "send more like this." The cohort engine already slices all three. |

*Framing rule from `HANDOFF.md` applies to every sentence: nothing that reveals margin, buyer
behaviour, or how we work leads. Benchmarks are of affiliate-visible metrics only.*

## 5. Self-serve account operations — remove the email round-trips

| Improvement | Notes |
|---|---|
| **Campaign flows (already stubbed)** | The new/edit campaign placeholders on Setup & docs become real forms → a request queue on our side, not direct writes. Partner sees request status. |
| **User management** | Invite/deactivate their own users, set who gets which alerts. The `affiliate_users` table (B2) already specs this. |
| **Postback / pixel self-config** | Let them configure their S2S postback URL and test-fire it. Pairs with Marc's pixel-validation work rather than duplicating it. |
| **W-9 / banking docs upload** | With the documents library now built, add a *their-side* slot: agreement countersign, W-9, banking form. One place, not email attachments. |
| **Criteria-change requests** | "Request a band change" button on Targeting → ticket to Logan with the current terms attached. Negotiations happen anyway; this way they start from the actual numbers. |

## 6. Workflow quality-of-life — small, cheap, high-frequency wins

| Improvement | Notes |
|---|---|
| **Saved views** | The query string *is* the view state, so "save this view" is just naming a URL. Per-user, on `affiliate_users` (extends B10). |
| **Scheduled exports** | The CSV the partner pulls every Monday, emailed automatically on their schedule instead. |
| **Comparison ranges** | "vs previous period" deltas on the Performance tiles (the engine already computes any window — this is presentation only). |
| **Multi-account switcher** | Several contacts run more than one affiliate entity; one login, an account dropdown. The session-partner model should anticipate it now — it is expensive to retrofit. |
| **Timezone choice** | Dates render in the partner's chosen timezone, labelled. Attribution windows stay ET internally; display-only conversion. |
| **Real mobile pass** | The layout is responsive; the next step is workflow: media buyers check pace from a phone. The weekly-target chip, health dial and alerts are the mobile surface — a cut-down "today" view, not the full table. |

## 7. Trust & polish — the portal as evidence

The fidelity rule (cells show system values verbatim) made the portal usable as evidence in a
dispute. Extending that posture:

- **Data freshness stamp** on every page: *"Data as of 09:41 ET."* A partner who can see freshness
  never wonders whether a missing sale is a lag or a loss.
- **A change log they can see**: criteria, rates, targets and states-list changes, dated, on the
  Account page. Pairs with the change alerts in §2 — the alert is the push, this is the record.
- **Status page for the post endpoint**: if our API drops leads for 20 minutes, the partner's
  traffic didn't fail — we did. Saying so first is worth more than the incident costs.
- **Descriptor coverage audit**: every metric label on every page should have its hover
  descriptor. The pattern exists; finishing coverage is an editorial pass, not engineering.

---

## Suggested sequencing

Phased by *value to the affiliate per unit of build effort*, taking dependencies into account:

| Phase | Items | Rationale |
|---|---|---|
| **1 — with the current build** | Earnings statement + pending/settled (§1), weekly digest + rejection-spike alert (§2), comparison ranges + saved views (§6), freshness stamp (§7) | Statement and digest are the two features partners will *feel* immediately; most of the computation already exists in the engine. |
| **2 — needs the admin build** | Change notices + change log (§2, §7), criteria as JSON + suppression adoption card (§3), campaign request flows + user management (§5) | All keyed on the admin tables `ADMIN-MAPPING.md` already specs — build once, several features light up. |
| **3 — needs new plumbing** | Pre-send validation API + pixel test tool (§3), sub-ID scorecards (§4, blocked on A2), scheduled exports, postback self-config (§5) | Real engineering, and the pre-send API is the one to design carefully — it inherits every containment rule from the duplicate lookup. |
| **4 — strategic** | Benchmarks + what-to-fix-first (§4), multi-account, mobile "today" view | Differentiators once the fundamentals are trusted. |

**The one-line version:** the dashboard currently tells a partner what happened. Phase 1 makes it
tell them what they're owed; Phase 2, what changed; Phase 3, what to check *before* spending;
Phase 4, what to do next. Each phase earns the trust the next one spends.
