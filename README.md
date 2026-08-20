# New Affiliate Dashboard

A mock-up of a new affiliate-facing dashboard for **Financialize**, built to hand off to the
dev team for implementation into the existing system. It replaces the current affiliate
dashboard.

## Status

Prototype complete — **nine affiliate-facing screens**, clickable, shipping empty — all data was
removed on Aug 20 and `assets/data/dataset.js` is the documented connection point. Ready for review by Michael and Courtney, and for
handoff to Sagar and Zakira.

## Purpose

This repo is a **prototype / spec artifact**, not production code. Its job is to show the dev
team exactly what the affiliate dashboard should look like and how it should behave, so
implementation into the current system is unambiguous.

**Read in this order:**

1. **[HANDOFF.md](HANDOFF.md)** — *why it is like this.* Visibility rules, the attribution model,
   decisions and what was rejected. Start here.
2. **[ADMIN-MAPPING.md](ADMIN-MAPPING.md)** — *what connects to what.* Every dashboard element
   mapped to the field or setting behind it. **The connection list at the top is the work list**,
   cut by who supplies each value: automatic, admin setting, or auto-with-override.
3. **[IMPROVEMENTS.md](IMPROVEMENTS.md)** — the forward plan, phased by value per unit of effort.
4. **[CLAUDE.md](CLAUDE.md)** — rules an AI agent editing this repo must not break. Also the
   fastest summary of the non-obvious constraints.

## Running it

No build step, no dependencies, no server. Open `index.html` — it forwards to the Partnership
summary.

If you do serve it over HTTP, **use a server that does not rewrite URLs**. All state lives in the
query string, and `npx serve` 301-redirects `/index.html` → `/index` while dropping the query
string, which silently breaks every filter link. `.claude/launch.json` uses `http-server` for
this reason.

## Repo layout

```
index.html              Redirect stub — forwards / to partnership.html

  Affiliate-facing
partnership.html        Partnership summary          (landing screen, default page)
performance.html        Performance overview         (Module A)
leads.html              Lead table + CSV export      (Module B)
health.html             Lead health scorecard        (Module D)
targeting.html          Targeting — windows, assets, states, criteria, creatives
duplicate-check.html    Duplicates & suppression     (Module C)
compensation.html       Compensation, statements, pixel unfire report
setup.html              Setup & docs hub             (Module E)
campaign-setup.html     Per-campaign setup tracker   (Module E2)
account.html            Account & users

  INTERNAL — TEMPORARY. Delete all three, and the INTERNAL_NAV entry in
  app.js, before anything ships.
admin-preview.html      Preview of the admin settings page that still needs building
data-source.html        Data connections — every value, and whether it is wired
assets/js/handoff.js    The connection registry both internal pages read

assets/css/dashboard.css   All styling; light and dark, validated colour tokens
assets/js/data.js          The dataset loader, the redaction query layer, all registries
assets/js/health.js        Lead Health Score engine + coverage widgets
assets/js/charts.js        Dependency-free SVG charts
assets/js/app.js           Shell, filter state, formatting, shared components
assets/js/tables.js        Sortable / resizable / column-configurable tables
assets/img/                The Financialize mark
assets/data/dataset.js     THE CONNECTION POINT — ships null, contract documented inside
```

## Constraints this was built under

- **The system is PHP.** Static HTML, CSS and vanilla JS only. Filter state lives in the query
  string and the filter row is a real `<form method="get">`, so every screen maps directly onto
  a server-rendered PHP view. Nothing here implies a stack change.
- **Redaction is a data-layer rule, not a UI toggle.** `queryLeads()` projects each row from an
  allowlist resolved from that row's campaign comp model, so a column an affiliate may not see is
  never on the object at all. Which columns are available is admin-configurable per comp model,
  but the registry is a hard constraint on what an admin may enable.
- **No charting library.** Charts are hand-rolled SVG so there is nothing to vendor.
- **No build step, and this one is load-bearing.** Logan owns iterations to this portal after
  handoff and needs to edit it directly. Plain HTML/CSS/vanilla JS is what makes that possible; the
  moment a change needs `npm install` and a compile, that access is theoretical. See the write-access
  section at the top of HANDOFF.md.
- **Nothing affiliate-facing names the lead export.** The dashboard is built against a backend;
  the export is a temporary source. An unconnected field renders blank with a "not connected yet"
  note, never a zero and never an explanation of our plumbing.

## Before this ships

- Delete `admin-preview.html`, `data-source.html`, `assets/js/handoff.js`, and the `INTERNAL_NAV`
  entry in `app.js`.
- The **"Viewing as"** partner selector is already removed. In production the affiliate comes off
  the session and cannot be chosen — `?partner=` must be ignored, not honoured.
- The **admin settings page does not exist** and is not in this repo. Section 2 of the connection
  list in ADMIN-MAPPING is its build spec.

## Not yet built

Module F, the internal Lead Activation view for Courtney — call attempts, dispositions, queue
state, and affiliate-submitted nurture leads. Phase 2, deliberately, so it does not delay the
affiliate-facing prototype.
