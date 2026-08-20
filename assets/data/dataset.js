/* ===========================================================================
   THE DATA CONNECTION POINT — empty on purpose.

   This file is where the portal gets its data, and it ships EMPTY. Every
   affiliate, campaign and lead the prototype used to run on has been removed:
   that was a lead export loaded for review, and this dashboard is being built
   against the live system, not against a file.

   Nothing downstream fabricates a replacement. With this file empty every
   screen renders its own empty state, and every number, table and chart
   populates the moment real data arrives. That is the intended behaviour —
   an empty dashboard is correct until it is connected, and it is the only way
   to be sure no fabricated figure ever reaches a partner.

   ---------------------------------------------------------------------------
   TWO WAYS TO CONNECT IT. Either is fine.
   ---------------------------------------------------------------------------

   1. SERVER-RENDER THIS OBJECT (the smaller change)
      Emit `window.FZ_DATASET` from PHP with the shape below, scoped to the
      SESSION'S AFFILIATE ONLY. `assets/js/data.js` already parses it and
      needs no change. Good for a first integration.

   2. REPLACE THE LOADER
      Rewrite `loadDataset()` in `assets/js/data.js` to read from your own
      endpoints. The contract that matters is what it RETURNS —
      `{ partners, campaigns, leads }` in the internal shape — and everything
      above the query layer is unchanged.

   Either way the firewall stays where it is: `queryLeads()` builds each row
   field-by-field from an allowlist, so a column an affiliate may not see is
   never on the object. Do not bypass it by handing the view raw rows.

   ---------------------------------------------------------------------------
   THE SHAPE
   ---------------------------------------------------------------------------

   Leads are POSITIONAL ARRAYS, indexed by `fields`, to keep the payload small
   — 65k rows as objects is several times the size. Keep the order in `fields`
   authoritative; do not assume the literal positions below.

     notes.dateFrom / dateTo   ISO dates. `dateTo` pins TODAY, so every window
                               is measured from the last day you have data for
                               rather than the wall clock.
     notes.noTimeOfDay         true while `Created On` carries no time (A1).
                               Turns the hour-of-day features off rather than
                               plotting a fabricated hour.
     epoch                     ISO date. Lead `recv` / `soldOn` are DAY OFFSETS
                               from it. -1 means null.

     partners[]   { id, name, affiliateId, rows }
     campaigns[]  { cid, name, partnerId, comp:'revshare'|'cpl', revSharePct,
                    cplRate, product, lastLead, active }

     states[] subids[] rejects[] rejectsRaw[] soldTypes[] assetBands[]
       Lookup tables. Lead rows store an INDEX into these, or -1 for null.
       `rejects` must use the controlled vocabulary in REJECT_REASONS
       (ADMIN-MAPPING §3a) — the affiliate-facing list IS the internal list.

     fields[]     Column order for every row in `leads`.
     leads[][]    One array per lead:
                    recv          day offset from epoch
                    partner       index into partners[]
                    campaign      index into campaigns[]
                    paid          1 accepted, 0 rejected
                    reject        index into rejects[], -1 if accepted
                    soldType      index into soldTypes[], -1 if unsold
                    soldOn        day offset, -1 if unsold
                    revenueCents  integer cents, 0 if unsold
                    shareCents    the AFFILIATE'S share in cents
                    state         index into states[]
                    assetBand     index into assetBands[]
                    subid         index into subids[], -1 if none
                    returned      1 if the pixel was unfired, else 0
                    attempts      call attempts (internal; never projected)
                    leadId        string
                    rejectRaw     index into rejectsRaw[], -1 if none

   NEVER EMIT consumer PII, `lead_cost`, `margin`, `buyer_name`, `csr_name`,
   `call_result`, `ipqs_score`, `ipqs_rules_fired`, `clawback_reason` or
   `campaign_cost`. Those are absent from the column registry entirely, and
   absence is the enforcement — see the firewall note in data.js.

   Full field-by-field spec: ADMIN-MAPPING.md, "THE CONNECTION LIST".
   =========================================================================== */

window.FZ_DATASET = null;
