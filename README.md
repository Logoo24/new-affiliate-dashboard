# New Affiliate Dashboard

A mock-up of a new affiliate-facing dashboard for **Financialize**, built to hand off to the
dev team for implementation into the existing system.

## Status

Prototype complete — six screens, clickable, with fabricated data. Ready for review by Michael
and Courtney, and for handoff to Sagar and Zakira.

## Purpose

This repo is a **prototype / spec artifact**, not production code. Its job is to show the dev
team exactly what the affiliate dashboard should look like and how it should behave, so
implementation into the current system is unambiguous.

**Read [HANDOFF.md](HANDOFF.md) first** — it covers the visibility rules, the data attribution
model, and the field list the build is waiting on.

## Running it

Open `index.html` in any browser. No server, no build step, no dependencies.

## Repo layout

```
index.html              Performance overview      (Module A)
leads.html              Lead detail + CSV export  (Module B)
duplicate-check.html    365-day phone lookup      (Module C)
health.html             Lead health scorecard     (Module D)
setup.html              New-affiliate onboarding  (Module E)

assets/css/dashboard.css   All styling; light and dark, validated colour tokens
assets/js/data.js          Mock dataset + the redaction query layer
assets/js/health.js        Lead Health Score engine
assets/js/charts.js        Dependency-free SVG charts
assets/js/app.js           Shell, filter state, formatting
```

## Constraints this was built under

- **The system is PHP.** Static HTML, CSS and vanilla JS only. Filter state lives in the query
  string and the filter row is a real `<form method="get">`, so every screen maps directly onto
  a server-rendered PHP view. Nothing here implies a stack change.
- **Redaction is a data-layer rule, not a UI toggle.** `queryLeads()` projects rows from a
  per-partner-type allowlist, so a column a partner may not see is never on the object at all.
- **No charting library.** Charts are hand-rolled SVG so there is nothing to vendor.

## Not yet built

Module F, the internal Lead Activation view for Courtney — call attempts, dispositions, queue
state, and affiliate-submitted nurture leads. Phase 2, deliberately, so it does not delay the
affiliate-facing prototype.
