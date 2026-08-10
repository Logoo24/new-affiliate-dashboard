/* ---------------------------------------------------------------------------
   FZHandoff — the connection registry.

   TEMPORARY. INTERNAL. Loaded only by data-source.html and admin-preview.html.
   Delete it with them before shipping.

   THIS IS THE SINGLE SOURCE OF TRUTH FOR THE HANDOFF. Two internal pages
   render from it:

     data-source.html   — DATA. Every live value on the portal, which field
                          feeds it, whether we have that field today, and how
                          it needs to connect.
     admin-preview.html — SETTINGS. Everything an admin must be able to change,
                          whether the setting exists today, and the storage it
                          needs.

   Written as data rather than as prose in two HTML files so a field cannot be
   fixed in one place and stay stale in the other. ADMIN-MAPPING.md carries the
   long-form reasoning; this carries the checklist.

   status values, used by both pages:
     'have'     — exists in the export or the system today, nothing to build
     'partial'  — exists but is unusable as-is (bad values, low fill, wrong unit)
     'missing'  — does not exist anywhere; must be added
     'build'    — a setting/screen/table that must be built
--------------------------------------------------------------------------- */
(function (global) {
  'use strict';

  var STATUS = {
    have:    { label: 'Have it',        badge: 'badge-good' },
    partial: { label: 'Unusable as-is', badge: 'badge-warn' },
    missing: { label: 'Missing',        badge: 'badge-crit' },
    build:   { label: 'Needs building', badge: 'badge-crit' }
  };

  /* ------------------------------------------------------------------------
     DATA FIELDS — what feeds the portal.
     `where` is where it shows up; `how` is the connection instruction.
     ------------------------------------------------------------------------ */
  var FIELDS = [

    /* ---- identity & routing -------------------------------------------- */
    { group: 'Identity & routing', name: 'Affiliate ID', source: 'Affiliate ID', status: 'have',
      where: 'Every page. Scopes the whole portal.',
      how: 'In production this comes off the SESSION, never a URL parameter. The "Viewing as" ' +
           'selector is a mock-up affordance and must not ship.' },
    { group: 'Identity & routing', name: 'Affiliate name', source: 'Affiliate', status: 'have',
      where: 'Topbar, Partnership summary.', how: 'Straight read.' },
    { group: 'Identity & routing', name: 'Campaign ID + name', source: 'Campaign', status: 'have',
      where: 'Filter bar, lead table, Partnership summary.',
      how: 'The comp model and the CPL rate are currently parsed out of the campaign NAME ' +
           '("$150", "Rev Share"). That is a stopgap — both need real columns.' },
    { group: 'Identity & routing', name: 'Comp model', source: 'derived from campaign name', status: 'partial',
      where: 'Decides the entire column projection for every row.',
      how: 'MUST become a real per-campaign field. This is the single most load-bearing value ' +
           'in the system — it selects which SELECT list a row is built from. Parsing it from ' +
           'a name is fragile in a way that fails toward over-disclosure.' },

    /* ---- lead core ------------------------------------------------------ */
    { group: 'Lead record', name: 'Lead ID', source: 'Lead ID', status: 'have',
      where: 'Lead table, CSV export.', how: 'Straight read.' },
    { group: 'Lead record', name: 'Received date', source: 'Date', status: 'have',
      where: 'Volume everywhere, the "what did I send" attribution basis.',
      how: 'Straight read. Note this is a DATE only — see Received time below.' },
    { group: 'Lead record', name: 'Received time of day', source: '(TimeStamp — empty)', status: 'missing',
      where: 'Arrival-window widget. CURRENTLY SWITCHED OFF.',
      how: 'The TimeStamp column exists but is empty on every row. Populate it and the arrival ' +
           'widget turns on with no other change. Until then the widget must stay off rather ' +
           'than render a fabricated hour.' },
    { group: 'Lead record', name: 'Accepted / rejected', source: 'Status + Lead Cost', status: 'have',
      where: 'Acceptance rate, the row rule, CPL invoicing.', how: 'Straight read.' },
    { group: 'Lead record', name: 'Reject reason (exact string)', source: 'Reject Reason', status: 'partial',
      where: 'Lead table cell, CSV export.',
      how: 'RENDERED VERBATIM so the affiliate\'s table reconciles 1:1 against ours. Blocked by ' +
           'the XML problem below: 2,713 rows carry a raw filter payload instead of a reason, ' +
           'and those fall back to a plain-language bucket label rather than print an XML blob ' +
           'at a partner. Fix the filter and the fallback stops firing.' },
    { group: 'Lead record', name: 'Reject reason (bucket)', source: 'derived', status: 'have',
      where: 'Grouped rejection summary, pie chart, health score.',
      how: 'Server-side mapping of the exact string to a bucket. Needed because the raw column ' +
           'has 2,917 distinct values and cannot be grouped as-is.' },
    { group: 'Lead record', name: 'State', source: 'State', status: 'have',
      where: 'Coverage, state demand matching.', how: 'Straight read.' },
    { group: 'Lead record', name: 'Investable assets', source: 'Investable Assets', status: 'partial',
      where: 'Asset-band breakdown, the highest-leverage targeting widget.',
      how: 'Free text with many unparsed variants. Needs normalising to bands at ingest.' },
    { group: 'Lead record', name: 'Date of birth / age', source: 'DOB', status: 'partial',
      where: 'Age-criteria rejections.',
      how: 'PLACEHOLDER BIRTH YEARS on the aged-lead import corrupt any age metric. Must be ' +
           'cleaned before age-based reporting means anything.' },
    { group: 'Lead record', name: 'Sub-ID', source: 'SubID', status: 'partial',
      where: 'Sub-ID drilldown and filter.',
      how: 'Only 0.4% fill. Madrivo passes them; the two largest accounts pass none. The ' +
           'drilldown is off for partners with no sub-IDs rather than showing one empty row.' },
    { group: 'Lead record', name: 'click_id / utm_campaign / utm_medium', source: '—', status: 'missing',
      where: 'Not built — the finer traffic-source breakdown.',
      how: 'Blocking dependency (Zakira). Accept and store on the post, then expose alongside ' +
           'sub-ID.' },

    /* ---- outcomes ------------------------------------------------------- */
    { group: 'Sale outcome', name: 'Sold date', source: 'Sold Date', status: 'have',
      where: 'Earnings, the "what did I earn" attribution basis.',
      how: 'Straight read. Must be the basis for every revenue figure — attributing earnings ' +
           'to the received date reports $0 on recent windows because leads take 9–12 days.' },
    { group: 'Sale outcome', name: 'Sold type — Priority/Hot/Auction/Marketplace', source: 'Sold Type', status: 'partial',
      where: 'The North Star metric, tier mix, the entire hero of the Performance page.',
      how: 'Needs to arrive as DISTINCT tier labels. Blocking dependency (Zakira). Some rows ' +
           'are marked sold with no type at all.' },
    { group: 'Sale outcome', name: 'Sale amount', source: 'Revenue', status: 'have',
      where: 'Revenue-share rows only. Never present on a CPL row.',
      how: 'Projected per row from that row\'s comp model, not the account.' },
    { group: 'Sale outcome', name: 'Partner share', source: 'Revenue × share %', status: 'have',
      where: 'Revenue-share rows only.', how: 'Share % needs to be a real per-campaign field.' },

    /* ---- internal, never projected -------------------------------------- */
    { group: 'Internal — never leaves the query', name: 'Lead cost', source: 'Lead Cost', status: 'partial',
      where: 'Margin input to the health score. NEVER rendered.',
      how: '$1 PHANTOM COGS on all 41,627 accepted rows. Margin computed from it is fiction, so ' +
           'the margin component of the score is currently excluded. Must be $0 on rev-share ' +
           'campaigns before any margin metric means anything.' },
    { group: 'Internal — never leaves the query', name: 'Margin / profit', source: 'derived', status: 'partial',
      where: 'The INTERNAL OVERLAY beside the health score (Data connections partner table). ' +
             'REMOVED from the score itself in v2.',
      how: 'A partner with bad margin is mispriced — fixed with the CPL lever, not their ' +
           'behaviour — and a visible score moved by an invisible input cannot be explained ' +
           'to the person being scored. Margin renders internally beside the score, never in ' +
           'it. Blocked on the $1 phantom COGS (A6) like every margin metric.' },
    { group: 'Internal — never leaves the query', name: 'Buyer name · CSR name · call result · IPQS detail',
      source: 'various', status: 'have',
      where: 'NOWHERE. Absent from the column registry entirely.',
      how: 'These are the July 31 Heritage leak columns. Absence from the registry IS the ' +
           'enforcement — do not add them and gate them.' },
    { group: 'Internal — never leaves the query', name: 'Speed to lead', source: 'Speed to Lead', status: 'partial',
      where: 'Internal ops diagnostics ONLY (Courtney\'s Module F, Phase 2). The v1 "Speed & ' +
             'operations" score pillar is DELETED, permanently — see the health v2 decision.',
      how: 'This measures OUR call floor, not the affiliate\'s traffic, so it must never feed ' +
           'the affiliate-facing score. Fix the values (negatives, median zero) for internal ' +
           'dashboards, not for scoring.' },
    { group: 'Internal — never leaves the query', name: 'Call-outcome feed (bad-contact rate)', source: '—', status: 'missing',
      where: 'The parked "Bad-contact rate" component of the Delivered quality pillar — the ' +
             'strongest leading indicator in the whole score.',
      how: 'Needs per-lead call outcomes classified to wrong-number / disconnected / ' +
           'unreachable, aggregated to a rate. The affiliate sees only their rate, never ' +
           'call-level detail. Unparks automatically once the feed exists.' },
    { group: 'Compliance system (health v2)', name: 'Consent certificate coverage', source: 'xxTrustedFormCertUrl on the post', status: 'missing',
      where: 'Compliance & trust pillar (30% of it).',
      how: 'The API already accepts the field; it needs capturing through to the lead record ' +
           'and aggregating to a per-affiliate coverage %. LP-path leads carry it from our ' +
           'own forms.' },
    { group: 'Compliance system (health v2)', name: 'Complaint incident log', source: '—', status: 'missing',
      where: 'Compliance pillar (30%) AND the gate — an unresolved critical incident caps the ' +
             'score at 45.',
      how: 'incidents (affiliate_id, campaign_id, type, severity critical|minor, date, ' +
           'resolved, notes). MANUAL ADMIN ENTRY FIRST — enforcement must not wait for ' +
           'automation. Trailing 90 days feeds the score.' },
    { group: 'Compliance system (health v2)', name: 'Creative-review currency flag', source: '—', status: 'missing',
      where: 'Compliance pillar (25%) and the gate.',
      how: 'Boolean per affiliate: is the running creative set on file with Jefanie? Set false ' +
           'when they change creatives without re-sending (the setup-flow policy). False = ' +
           'score capped.' },
    { group: 'Compliance system (health v2)', name: 'Unsubscribe compliance flag', source: '—', status: 'missing',
      where: 'Compliance pillar (15%) and the gate. Email-traffic affiliates only.',
      how: 'Boolean per affiliate: opt-out links live and correct. False = score capped.' },

    /* ---- relationship --------------------------------------------------- */
    { group: 'Relationship', name: 'Partner since', source: '—', status: 'missing',
      where: 'Partnership summary.',
      how: 'Not derivable — the earliest row is the start of the export window, not of the ' +
           'relationship. Needs a real field on the partner record.' },
    { group: 'Relationship', name: 'Billing terms & next payment date', source: '—', status: 'missing',
      where: 'Partnership summary billing widget.',
      how: 'Net terms per partner. The payment date is computed as 3 business days after ' +
           'month end, but the TERMS themselves need storing.' },
    { group: 'Relationship', name: 'Partner contacts & portal users', source: '—', status: 'missing',
      where: 'Account page, Partnership summary.',
      how: 'Whole table missing — see the settings list. Placeholders until it exists.' }
  ];

  /* ------------------------------------------------------------------------
     ADMIN SETTINGS — what has to be controllable, and what that costs.
     ------------------------------------------------------------------------ */
  var SETTINGS = [

    { group: 'Visibility', name: 'Lead column visibility, per comp model', status: 'build',
      controls: 'Which columns an affiliate sees in the table and the CSV export.',
      today: 'Hardcoded as ADMIN_COLUMN_CONFIG in data.js.',
      storage: 'Table keyed (comp_model, column_key) → enabled. The code registry stays the ' +
               'hard constraint: an admin must not be able to enable a revenue column for a ' +
               'CPL campaign, and locked columns cannot be switched off.',
      risk: 'This is the setting that decides what leaves the building. It needs an audit trail.' },

    { group: 'Visibility', name: 'Comp model, per campaign', status: 'build',
      controls: 'The entire column projection for every row on that campaign.',
      today: 'Parsed out of the campaign name.',
      storage: 'A real enum column on the campaign record.',
      risk: 'Highest-consequence field in the system. A campaign silently defaulting to the ' +
            'wrong model discloses revenue to a CPL partner.' },

    { group: 'Commercial terms', name: 'Lead criteria, per affiliate', status: 'build',
      controls: 'The age band, asset floor, income floor and every other criteria line on the ' +
                'Targeting page and in the rejection labels.',
      today: 'Standard criteria in code; OptiLabX\'s negotiated 45–79 band is a per-partner ' +
             'override in the mock data.',
      storage: 'Per-affiliate criteria overrides, per product.',
      risk: 'Already real money: the 45–79 band applied as 45–75 caused a $5,194 invoice ' +
            'variance and 55 leads wrongly flagged. Any criteria value may be negotiated.' },

    { group: 'Commercial terms', name: 'CPL targets — margin, CPL, volume, spend', status: 'build',
      controls: 'The weekly target card and the per-day target line on the Performance chart.',
      today: 'Hardcoded TARGETS in data.js, plus sessionStorage in the mock.',
      storage: 'partner_targets (partner_id, campaign_id, week_start, target_margin, ' +
               'target_cpl, target_volume, target_spend, set_by, set_at). Store all four ' +
               'resolved values plus WHICH field the admin typed — the other of each pair is ' +
               'derived from it.',
      risk: 'CPL only. Revenue-share partners have no target by design. A null target means ' +
            'NOT SET — it must not render and must not count as missed.' },

    { group: 'Commercial terms', name: 'Day-of-week volume split', status: 'build',
      controls: 'The per-day target ticks on the affiliate\'s chart, and the ideal-split chips ' +
                'on Targeting.',
      today: 'IDEAL_DOW_SPLIT constant, Sunday 0%.',
      storage: 'partner_dow_weights (partner_id, dow, weight), falling back to a global default.',
      risk: 'Sunday defaults to 0% because the call floor is closed. It must stay overridable.' },

    { group: 'Commercial terms', name: 'Revenue share %, per campaign', status: 'build',
      controls: 'The partner-share column on revenue-share rows.',
      today: 'Read from the export but not editable.',
      storage: 'Per-campaign field.' },

    { group: 'Operational', name: 'Call centre hours', status: 'build',
      controls: 'The hours card on Targeting, and every timing claim on the portal.',
      today: 'OPERATING_HOURS constant.',
      storage: 'Global setting, per weekday, with a timezone note.',
      risk: 'An earlier version asserted a 6–9a "golden window" that contradicted the real ' +
            'hours — the floor does not open until 9a. Anything on screen about timing must ' +
            'derive from this one setting.' },

    { group: 'Operational', name: 'Ideal send windows', status: 'build',
      controls: 'The "best times to send" chips on Targeting.',
      today: 'IDEAL_WINDOWS constant.',
      storage: 'Global list of windows, consumer local time. Displays to every affiliate, so ' +
               'one edit must propagate everywhere.' },

    { group: 'Operational', name: 'States we need most', status: 'build',
      controls: 'The top-10 state list on Targeting.',
      today: 'STATE_DEMAND constant.',
      storage: 'Ranked list of states, admin-ordered. CHANGES OFTEN — this needs to be easy to ' +
               'edit, not a deploy.',
      risk: 'The affiliate sees state NAMES ONLY. The unused budget and implied lead counts ' +
            'behind the ranking are internal and must not be projected.' },

    { group: 'Content', name: 'Document library', status: 'build',
      controls: 'The Helpful documents section on Setup & docs.',
      today: 'DOCUMENTS constant in data.js.',
      storage: 'documents (key, label, description, url, scope, sort_order, featured). Must ' +
               'support ADDING documents without a deploy.' },

    { group: 'Campaigns', name: 'Campaign setup tracker', status: 'build',
      controls: 'The per-campaign onboarding tracker (campaign-setup.html): step states, ' +
                'integration method, traffic source, tracking/test URLs, and the affiliate\'s ' +
                'pixel URL.',
      today: 'campaignSetup() in data.js; states in sessionStorage; integration method is a ' +
             'deterministic stand-in; two synthetic in-setup demo campaigns.',
      storage: 'campaign_setup (campaign_id, step_key, state, updated_by, updated_at) plus new ' +
               'campaign fields: integration_method, traffic_source, tracking_url, test_url, ' +
               'pixel_url (affiliate-writable, audited). See ADMIN-MAPPING §7d.',
      risk: 'pixel_url is the ONLY affiliate-writable field in the portal — it needs an audit ' +
            'trail, and a post-go-live change must notify Logan and be re-verified with a test ' +
            'lead before taking effect.' },

    { group: 'Health score', name: 'Compliance system (inputs + gate)', status: 'build',
      controls: 'The Compliance & trust pillar and the score cap. Four inputs: consent-cert ' +
                'coverage, complaint incident log, creative-review flag, unsub flag.',
      today: 'complianceFor() in data.js returns all nulls — pillar parked, gate unarmed. ' +
             'Deliberately: these are real affiliate names and fabricating an incident against ' +
             'one in a reviewable mock is not acceptable.',
      storage: 'incidents table + two boolean flags on the affiliate record + consent-cert ' +
               'capture on the lead. Spec in ADMIN-MAPPING §6a.',
      risk: 'The gate is the enforcement: critical failure caps the score at 45 and is not ' +
            'launderable by good acceptance. Manual admin entry first — do not wait for ' +
            'automation to start enforcing.' },

    { group: 'Health score', name: 'Score calibration table', status: 'build',
      controls: 'The percentile pools every metric scores against, per campaign class ' +
                '(fresh annuity / aged annuity / life).',
      today: 'Computed live from the dataset on page load (buildPools() in health.js).',
      storage: 'A stored calibration table, recomputed QUARTERLY by a job — never per request. ' +
               'A partner\'s score must not move because someone else\'s traffic shifted ' +
               'mid-week. Store: class, metric, sorted value list (or quantiles), computed_at.',
      risk: 'Also the shrinkage medians come from here. Getting the recompute cadence wrong ' +
            'makes scores drift in ways nobody can explain to a partner.' },

    { group: 'Content', name: 'Creative links', status: 'build',
      controls: 'The three buttons on Targeting\'s Creatives card: example annuity creatives, ' +
                'example life creatives, creative guidelines.',
      today: 'CREATIVE_LINKS constant in data.js, all three null — clicks show "not linked yet".',
      storage: 'Three URL settings, or documents-table rows with a creatives scope.' },

    { group: 'Content', name: 'Per-affiliate agreement URL', status: 'build',
      controls: 'The "Your agreement" card on Setup & docs, which links to that partner\'s own ' +
                'Google Drive doc. Logan\'s workflow: agreement signed → paste the Drive link ' +
                'on the affiliate\'s record → the card renders it.',
      today: 'WORKING in the mock: the Admin settings page has a live per-affiliate paste ' +
             'field (sessionStorage standing in for the record field).',
      storage: 'A URL field on the affiliate record, editable in the admin. No URL set must ' +
               'render "not linked yet" rather than a dead button.',
      risk: 'Sharing model differs from every other document: the Drive doc is shared ' +
            'DIRECTLY with each account user\'s email, never "anyone with the link" — the ' +
            'share list is the access control, and it must follow the user list (add a user → ' +
            'share; deactivate → unshare same day). The link renders only inside the portal ' +
            'for that account\'s session and must never appear in emails, exports, or query ' +
            'strings.' },

    { group: 'Account', name: 'Affiliate users & contacts', status: 'build',
      controls: 'Who can log in, and the contact block on the Account page.',
      today: 'Does not exist. Mock users in sessionStorage.',
      storage: 'Whole table: users (affiliate_id, name, email, role, status, last_login) plus ' +
               'billing/primary contact fields on the affiliate record.' },

    { group: 'Account', name: 'Partner since, billing terms', status: 'build',
      controls: 'Partnership summary.',
      today: 'Placeholders.',
      storage: 'Fields on the affiliate record.' },

    { group: 'Campaigns', name: 'New / edit campaign flows', status: 'build',
      controls: 'The two placeholder buttons on Setup & docs.',
      today: 'Placeholder modals pointing at Logan.',
      storage: 'Not yet specified — Logan to define the flow before anything is built.' },

    { group: 'Security', name: 'Duplicate lookup rate limiting', status: 'build',
      controls: 'The daily cap on the duplicates page.',
      today: 'A sessionStorage counter, purely so the affordance is visible.',
      storage: 'Server-side, per partner, per day, with every query logged against the partner ' +
               'ID.',
      risk: 'This is a suppression-list API in disguise. A partner who can query without limit ' +
            'can enumerate the database one number at a time. The containment must be in the ' +
            'design, not the UI.' },

    { group: 'Security', name: 'Suppression file delivery', status: 'build',
      controls: 'The download on the duplicates page.',
      today: 'Downloads a fabricated sample.',
      storage: 'Authenticated, per-affiliate, rate-limited, HMAC keyed per partner.',
      risk: 'CONFIRM WITH SAGAR FIRST — we already run an automatic suppression file and its ' +
            'actual behaviour is unknown. The affiliate-facing version has to match it rather ' +
            'than compete with it.' }
  ];

  /* Data-quality findings that block metrics regardless of what gets built. */
  var BLOCKERS = [
    { name: '$1 phantom COGS', severity: 'critical',
      detail: 'All 41,627 accepted rows carry a non-zero Lead Cost with a median of exactly $1.00.',
      impact: 'Margin on rev-share campaigns is fabricated. The margin component of the health ' +
              'score is excluded until this is $0.' },
    { name: 'Placeholder birth years', severity: 'critical',
      detail: 'The aged-lead import carries placeholder DOB values.',
      impact: 'Any age-based metric or age-criteria rejection count is wrong until cleaned.' },
    { name: 'XML payloads in Reject Reason', severity: 'serious',
      detail: '2,713 rows carry a raw filter response instead of a reason. 2,917 distinct values overall.',
      impact: 'Those rows cannot show the exact system value and fall back to a bucket label. ' +
              'This is our fault, not the affiliate\'s, and is labelled as such on screen.' },
    { name: 'Speed to lead values', severity: 'serious',
      detail: 'Populated but with negatives and a median of zero.',
      impact: 'The whole Speed & operations pillar is in development and excluded from scoring.' },
    { name: 'Sub-ID fill at 0.4%', severity: 'warning',
      detail: 'Madrivo passes sub-IDs; the two largest accounts pass none.',
      impact: 'The sub-ID drilldown is off for most partners.' },
    { name: 'Sold rows with no sold type', severity: 'warning',
      detail: 'Some rows are marked sold without a tier label.',
      impact: 'Tier mix undercounts. Blocks the North Star metric being exact.' }
  ];

  global.FZHandoff = {
    STATUS: STATUS,
    FIELDS: FIELDS,
    SETTINGS: SETTINGS,
    BLOCKERS: BLOCKERS,
    counts: function (list) {
      var c = {};
      list.forEach(function (f) { c[f.status] = (c[f.status] || 0) + 1; });
      return c;
    }
  };

})(window);
