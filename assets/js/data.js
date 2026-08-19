/* ==========================================================================
   data.js — mock lead dataset + the redaction query layer
   --------------------------------------------------------------------------
   TWO THINGS LIVE IN THIS FILE, AND THE SECOND ONE IS THE IMPORTANT ONE.

   1. A deterministic generator that fabricates ~4 months of realistic lead
      traffic so the mock-up has something to render. Throwaway — in production
      it is replaced by a MySQL query.

   2. queryLeads() — the visibility firewall. An ALLOWLIST projection: each
      returned row is built field-by-field from a column list resolved from the
      row's own campaign, so a field a partner may not see is never copied onto
      the object and cannot be read out of the DOM, a CSV export, or the
      console.

      THIS IS THE PATTERN THE PHP BUILD SHOULD COPY. Two different SELECT
      lists, not one SELECT plus an `if` in the template:

        // Lead from a REVENUE-SHARE campaign
        SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status,
               l.reject_reason, l.asset_band, l.sold_type, l.sold_at,
               l.days_to_sale, l.sale_amount,
               ROUND(l.sale_amount * c.rev_share_pct, 2) AS partner_share
          FROM leads l JOIN campaigns c ON c.id = l.campaign_id
         WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

        // Lead from a FLAT / TIERED CPL campaign — sale_amount is not in the
        // statement at all, and outcome columns are nulled on rejected rows.
        SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status,
               l.reject_reason, l.asset_band,
               CASE WHEN l.status = 'paid' THEN l.sold_type    END AS sold_type,
               CASE WHEN l.status = 'paid' THEN l.sold_at      END AS sold_at,
               CASE WHEN l.status = 'paid' THEN l.days_to_sale END AS days_to_sale
          FROM leads l
         WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

        // ...and any CPL query filtering BY sold_at must also add
        //     AND l.status = 'paid'
        // or the row count alone leaks that we work leads we declined.

      Columns in NEITHER list, for ANY comp model:
        lead_cost, margin, margin_pct, buyer_name, csr_name, call_result,
        ipqs_score, ipqs_rules_fired, clawback_reason, campaign_cost

   COMP MODEL IS A PROPERTY OF THE CAMPAIGN, NOT THE PARTNER.
   A partner can run revenue-share and CPL campaigns side by side, so the
   projection is resolved PER ROW from that row's campaign. Do not reintroduce
   a single per-account branch — see ADMIN-MAPPING.md.

   WHICH COLUMNS ARE AVAILABLE IS ADMIN-CONFIGURABLE, PER COMP MODEL.
   LEAD_COLUMNS below is the registry; ADMIN_COLUMN_CONFIG is the setting an
   admin screen writes. Adding a column later is ONE registry entry. The
   registry constrains what an admin may enable — it is not merely a default,
   so an admin cannot switch on a revenue column for a CPL campaign.
   ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------- */
  /* Deterministic PRNG so every reviewer sees identical numbers            */
  /* ---------------------------------------------------------------------- */

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(20260805);
  function rnd() { return rand(); }
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function between(lo, hi) { return lo + rnd() * (hi - lo); }
  function intBetween(lo, hi) { return Math.floor(between(lo, hi + 1)); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function weighted(pairs) {
    var total = 0, i;
    for (i = 0; i < pairs.length; i++) total += pairs[i][1];
    var r = rnd() * total;
    for (i = 0; i < pairs.length; i++) {
      r -= pairs[i][1];
      if (r <= 0) return pairs[i][0];
    }
    return pairs[pairs.length - 1][0];
  }

  /* ---------------------------------------------------------------------- */
  /* Reference data                                                         */
  /* ---------------------------------------------------------------------- */

  var TODAY = new Date(2026, 7, 5);          /* pinned so the mock is stable */
  var HISTORY_DAYS = 120;
  var NEW_PRODUCT_LAUNCH = new Date(2026, 7, 1);   /* Aug 1 2026 */

  /* Sale tiers. Prices are the real ones — Priority ~$500, Hot ~$400-475,
     Marketplace ~$10-20. Appointment booking and Live transfer launched
     August 2026, so they only appear in the last few days of the data.

     POINTS: Michael's system is Priority 10 / Hot 8 / Auction & Marketplace
     negative. The two new tiers sit above Priority, so they are scored above
     it here — those two values are my proposal and NEED HIS SIGN-OFF. */
  var SOLD_TYPES = {
    livetransfer: { label: 'Live transfer', short: 'Live',   points: 14, price: [900, 1150], premium: true, launched: true },
    appointment:  { label: 'Appointment',   short: 'Appt',   points: 12, price: [680, 820],  premium: true, launched: true },
    priority:     { label: 'Priority',      short: 'Priority', points: 10, price: [450, 560], premium: true },
    hot:          { label: 'Hot',           short: 'Hot',    points: 8,  price: [395, 480],  premium: true },
    auction:      { label: 'Auction',       short: 'Auction', points: -3, price: [45, 95] },
    marketplace:  { label: 'Marketplace',   short: 'Market', points: -4, price: [10, 22] }
  };

  /* The North Star bucket stays Priority + Hot — Michael's KPI, unchanged.
     The two new tiers are reported alongside it rather than folded into it. */
  var NORTH_STAR_TYPES = ['priority', 'hot'];
  var NEW_TIER_TYPES = ['livetransfer', 'appointment'];

  /* ======================================================================
     REJECTION REASONS — the affiliate-facing catalogue
     ----------------------------------------------------------------------
     THIS REGISTRY IS A PROPOSAL FOR THE INTERNAL VOCABULARY, NOT A MIRROR OF
     ONE. It is the most important thing on this page for the dev team to act
     on, so read this header before changing a key.

     Today the reject-reason column is free text: 2,917 distinct values across
     the export, and the tail is raw XML filter responses (A5 in
     ADMIN-MAPPING). This registry is what we want it collapsed TO. The
     affiliate-facing list must then be EXACTLY the internal list — one code,
     one meaning, both sides — so that adding or renaming a reason internally
     shows up here without a translation layer that can silently drift.

     Fields per entry:

       key      — our code. MUST become the internal code. Until the tech
                  team confirms them, these are proposals.
       label    — the SHORT affiliate-facing name shown in tables and legends.
       desc     — one or two plain sentences, shown in the hover box.
       fix      — what the affiliate can do about it.
       group    — how the list is organised on screen.
       live     — true when the current export can actually populate it.
                  Everything else renders with a zero count on purpose: the
                  catalogue is the spec, and a reason nobody can see is a
                  reason nobody knows to ask for.
       notReject— true when the bucket is NOT a lead-quality rejection at all
                  and must never be read as one.

     `age` is rendered through rejectDesc() because the accepted band is a
     negotiated commercial term that differs by partner.
     ====================================================================== */

  /* Display order of the groups, and their headings. */
  var REJECT_GROUPS = [
    { key: 'validation', label: 'Contact validation' },
    { key: 'data',       label: 'Lead data' },
    { key: 'criteria',   label: 'Campaign criteria' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'duplicate',  label: 'Exclusivity' },
    { key: 'notreject',  label: 'Not a rejection' }
  ];

  var REJECT_REASONS = {
    /* ---- contact validation -------------------------------------------
       IPQS ARRIVES AS ONE BUCKET AND MUST NOT STAY THAT WAY. It is the
       single largest reason on the book — 12,178 of 23,430 rejections, 52% —
       and as one undifferentiated label it is unactionable: "IPQS" tells an
       affiliate nothing about whether to fix their phone capture, their email
       capture, or their traffic source. IPQS returns the specific check that
       failed; we collapse it on ingest and throw that away. Split it. The
       three below are the split. */
    ipqs_phone: {
      label: 'Phone did not validate', group: 'validation',
      desc: 'Automated contact validation could not confirm the phone number as a live, ' +
            'reachable line belonging to this consumer.',
      fix: 'Add real-time phone validation at the form before the lead posts.'
    },
    ipqs_email: {
      label: 'Email did not validate', group: 'validation',
      desc: 'Automated contact validation rejected the email address — disposable domain, ' +
            'undeliverable mailbox, or a syntax that cannot exist.',
      fix: 'Validate the email inline and block disposable domains at the form.'
    },
    ipqs_other: {
      label: 'Other validation failure', group: 'validation',
      desc: 'Automated contact validation failed on a signal other than the phone or email ' +
            'itself — IP reputation, proxy or VPN, or a device signal that did not look like ' +
            'a real consumer session.',
      fix: 'Usually a traffic-source problem rather than a form problem. Check where the ' +
           'session originated.'
    },
    /* The aggregate the export can populate today. It exists ONLY as the
       landing bucket until the three above are wired; it is not a reason in
       its own right and should disappear from this list, not be renamed. */
    ipqs: {
      label: 'Contact validation (unsplit)', group: 'validation', live: true,
      desc: 'The phone or email failed automated contact validation. Our system does not yet ' +
            'record which check failed, so this bucket is broader than it should be.',
      fix: 'We are splitting this into phone, email and other so it tells you what to fix. ' +
           'Until then, read it as general traffic quality.'
    },

    /* ---- lead data ------------------------------------------------------ */
    missing_fields: {
      label: 'Required field blank', group: 'data',
      desc: 'A field the campaign requires arrived empty or null — nothing was posted at all, ' +
            'as distinct from a value that was posted and failed a check.',
      fix: 'Make the field required at the form and block the post when it is empty.'
    },
    contact: {
      label: 'Lead data not valid', group: 'data', live: true,
      desc: 'A posted value was present but not usable — a phone that is not a phone number, ' +
            'a name in the wrong field, placeholder text.',
      fix: 'Tighten field validation at the source.'
    },

    /* ---- campaign criteria --------------------------------------------- */
    age: {
      label: 'Age', group: 'criteria', live: true,
      desc: 'The consumer\'s age is outside the band this account accepts.',
      fix: 'Add an age gate to the funnel before the lead posts.'
    },
    assets: {
      label: 'Investable assets', group: 'criteria', live: true,
      desc: 'Reported investable assets were under $25,000. Leads under that threshold never ' +
            'pay, on any comp model.',
      fix: 'Under $25K never pays under any model. Add an assets question to the funnel.'
    },
    income: {
      label: 'Household income', group: 'criteria', live: true,
      desc: 'Reported household income was under the $40,000 minimum for life leads.',
      fix: 'Life leads need $40,000+ household income.'
    },
    state: {
      label: 'State', group: 'criteria', live: true,
      desc: 'The lead came from a state we do not accept. New York is never accepted.',
      fix: 'New York is never accepted. See Coverage for the states we want most.'
    },
    advisor: {
      label: 'Financial advisor', group: 'criteria',
      desc: 'The consumer is a financial advisor or industry professional rather than a ' +
            'prospective client.',
      fix: 'Add an occupation exclusion or suppress advisor lists.'
    },
    interest: {
      label: 'Not interested', group: 'criteria',
      desc: 'The consumer said they were not interested when reached.',
      fix: 'Usually a creative or expectation-setting issue upstream of the form.'
    },

    /* ---- compliance ----------------------------------------------------- */
    consent: {
      label: 'Consent missing', group: 'compliance',
      desc: 'No prior-express-written-consent certificate (TrustedForm or Jornaya) arrived ' +
            'with the lead, so it cannot legally be worked.',
      fix: 'Confirm the TCPA disclosure is on the page and the certificate is posting.'
    },

    /* ---- exclusivity ---------------------------------------------------- */
    duplicate: {
      label: 'Duplicate', group: 'duplicate', live: true,
      desc: 'This phone number already sold as a Priority or Hot lead within the last 365 ' +
            'days, so it is inside the exclusivity window and cannot be paid again.',
      fix: 'Screen your list against your suppression file before you pay to acquire it.'
    },

    /* ---- NOT A REJECTION ------------------------------------------------
       2,713 rows on this export carry an unmappable value in the reason
       column. It is not a rejection reason and must never be presented as
       one: it is US, after the fact, manually unfiring the pixel on a lead we
       had already accepted. Logan expects it to disappear once the reason
       column is a controlled vocabulary; if it survives into the new
       database, that is what it means, and it belongs on the Pixel unfire
       report rather than in this list. */
    filter_error: {
      label: 'Pixel manually unfired', group: 'notreject', live: true, notReject: true,
      desc: 'Not a rejection. We accepted this lead and then unfired the pixel by hand ' +
            'afterwards — the reason column carries our internal marker rather than anything ' +
            'about your lead. You are not billed for it.',
      fix: 'Nothing for you to fix. Removals are itemised on the Pixel unfire report on the ' +
           'Compensation page.'
    }
  };

  /* Every key, in group order then registry order — the affiliate-facing
     catalogue. Zero-count reasons render too: the list IS the spec. */
  var REJECT_ORDER = (function () {
    var out = [], keys = Object.keys(REJECT_REASONS);
    REJECT_GROUPS.forEach(function (g) {
      keys.forEach(function (k) { if (REJECT_REASONS[k].group === g.key) out.push(k); });
    });
    /* Anything without a recognised group still has to appear. */
    keys.forEach(function (k) { if (out.indexOf(k) === -1) out.push(k); });
    return out;
  })();

  /* Investable-asset bands. Under $25K never pays, under any comp model.
     The $100K–$250K band converts materially better than anything else and
     holds across months — the single highest-leverage targeting change most
     partners can make, so the dashboard surfaces it explicitly. */
  var ASSET_BANDS = [
    { key: 'end',   label: 'Under $25K',    weight: 9,  yield: 0,    payable: false, cpl: 0 },
    { key: 'low',   label: '$25K – $50K',   weight: 16, yield: 0.55, payable: true,  cpl: 27 },
    { key: 'mid1',  label: '$50K – $100K',  weight: 20, yield: 0.88, payable: true,  cpl: 90 },
    { key: 'sweet', label: '$100K – $250K', weight: 23, yield: 1.55, payable: true,  cpl: 90, focus: true },
    { key: 'mid2',  label: '$250K – $500K', weight: 18, yield: 1.18, payable: true,  cpl: 90 },
    { key: 'high',  label: '$500K+',        weight: 14, yield: 1.02, payable: true,  cpl: 102 }
  ];
  var ASSET_BY_KEY = {};
  ASSET_BANDS.forEach(function (b) { ASSET_BY_KEY[b.key] = b; });

  /* ---------------------------------------------------------------------- */
  /* Comp models                                                            */
  /* ---------------------------------------------------------------------- */

  /* A comp model is the unit that visibility is decided on. It carries two
     behaviours, and they are separate on purpose:

       seesRevenue           — may revenue columns be projected at all
       seesRejectedOutcomes  — may a REJECTED row carry outcome columns

     Revenue share is paid on any sale, accepted or not, so hiding
     rejected-but-sold rows would understate what we owe. A CPL partner is paid
     on acceptance and must never learn a declined lead can still sell. */
  var COMP_MODELS = {
    revshare: {
      key: 'revshare',
      label: 'Revenue share',
      seesRevenue: true,
      seesRejectedOutcomes: true,
      rateBasis: 'all',          /* paid on any sale → denominator is all leads */
      note: 'Paid a share of any sale, accepted or not.'
    },
    cpl: {
      key: 'cpl',
      label: 'Cost per lead',
      seesRevenue: false,
      seesRejectedOutcomes: false,
      rateBasis: 'paid',         /* paid on acceptance → denominator is accepted */
      note: 'Paid per accepted lead. A rejected lead stops at its reason.'
    }
  };

  function compModel(key) {
    return COMP_MODELS[key === 'revshare' ? 'revshare' : 'cpl'];
  }

  /* ---------------------------------------------------------------------- */
  /* Partners                                                               */
  /* ---------------------------------------------------------------------- */

  /* Two real partners, matched to their actual commercial terms:
       · Annuity Heritage Group — 40% revenue share, annuity only, posts to
         our API from their own funnel. The loudest voice on visibility.
       · OptiLabX Media — TIERED CPL ($102 / $90 / $27), annuity + life, runs
         on our landing pages. Carries a negotiated age band of 45–79 rather
         than the standard 45–75. That exception has already caused a $5,194
         invoice variance and wrongly flagged 55 leads on an unfire list, so
         every criteria label in this UI is rendered through rejectLabel()
         with the partner's own band.

     NOTE the id/comp separation. A partner id is an identity, NOT a comp
     model — both partners here happen to run a single comp model across all
     their campaigns, but the schema does not assume that and neither does the
     query layer. */
  /* NOTE there is deliberately NO `status` field here any more. Active vs
     inactive is DERIVED — at least one accepted lead in the trailing month —
     via isPartnerActive(). A stored flag drifts; a derived one cannot.

     `sinceISO` must come off the partnership record in production. That date
     may not exist in the admin centre today — see ADMIN-MAPPING.md §1. */
  var PARTNERS = {
    ahg: {
      id: 'ahg',
      name: 'Annuity Heritage Group',
      shortName: 'Heritage',
      /* The RATE CARD, not the comp model. Comp model is a property of the
         campaign; this is only the commercial rate those campaigns bill at. */
      rateCard: 'Revenue share — 40%',
      revSharePct: 0.40,
      ageBand: '45–75',
      ageBandNote: 'Standard criteria.',
      products: 'Annuity',
      integration: 'Their funnel → our API',
      integrationNote: 'Posts server-to-server. Pixel validated Jun 2026.',
      sinceISO: '2026-02-11',
      billingPeriod: 'Net 15',
      billingBasis: 'Invoiced monthly on the sold date',
      exclusivity: '365-day Priority/Hot exclusivity window',
      /* Everyone at the affiliate who can log in. Financialize staff are NOT
         users — admin access covers every account and lives outside this
         table entirely. Exactly one user is primary at any time. */
      users: [
        { id: 'u-ahg-1', name: 'Jake Wolfe',     title: 'Co-founder',   email: 'jake@annuityheritage.example',    isPrimary: true,  away: false, avatar: null },
        { id: 'u-ahg-2', name: 'Brayden Miller', title: 'Co-founder',   email: 'brayden@annuityheritage.example', isPrimary: false, away: false, avatar: null },
        { id: 'u-ahg-3', name: 'Dana Ortiz',     title: 'Media buyer',  email: 'dana@annuityheritage.example',    isPrimary: false, away: true,  avatar: null }
      ]
    },
    opx: {
      id: 'opx',
      name: 'OptiLabX Media',
      shortName: 'OptiLabX',
      rateCard: 'Tiered CPL — $102 / $90 / $27',
      revSharePct: 0,
      ageBand: '45–79',                 /* negotiated exception, not an error */
      ageBandNote: 'Negotiated exception — wider than the standard 45–75.',
      products: 'Annuity + Life',
      integration: 'Our landing pages',
      integrationNote: 'Traffic driven to Financialize-hosted LPs.',
      sinceISO: '2025-11-03',
      billingPeriod: 'Net 30',
      billingBasis: 'Invoiced monthly on the received date',
      exclusivity: '365-day Priority/Hot exclusivity window',
      users: [
        { id: 'u-opx-1', name: 'Alex Stark',   title: 'Founder',          email: 'alex@optilabx.example',   isPrimary: true,  away: false, avatar: null },
        { id: 'u-opx-2', name: 'Priya Nair',   title: 'Head of media',    email: 'priya@optilabx.example',  isPrimary: false, away: false, avatar: null },
        { id: 'u-opx-3', name: 'Sam Whitaker', title: 'Ops coordinator',  email: 'sam@optilabx.example',    isPrimary: false, away: false, avatar: null }
      ]
    }
  };

  /* Our side of the relationship. Fixed contacts, not per-partner data. */
  var ACCOUNT_MANAGER = {
    name: 'Logan Randall',
    title: 'Affiliate Performance Manager',
    email: 'logan@financialize.com',
    /* Generic chat entry point in the mock. Production should deep-link the
       partner straight into a DM — see ADMIN-MAPPING.md. */
    chatUrl: 'https://chat.google.com/'
  };
  var BILLING_CONTACTS = [
    { name: 'Cassie Jensen',    title: 'AP / Controller', email: 'accounting@financialize.com',
      note: 'Billing questions and payment status' },
    { name: 'Christine Aquino', title: 'Reporting',       email: 'christine.aquino@financialize.com',
      note: 'Monthly invoice reports' }
  ];

  /* Accepts the current partner id, and still accepts the legacy 'revshare' /
     'cpl' values that used to double as partner ids so old bookmarks and
     query strings keep working. */
  var PARTNER_ALIASES = { revshare: 'ahg', cpl: 'opx' };
  /* Reassigned by the dataset loader — partner ids come from the data. */
  var DEFAULT_PARTNER = 'ahg';

  function resolvePartnerId(id) {
    if (PARTNERS[id]) return id;
    if (PARTNER_ALIASES[id] && PARTNERS[PARTNER_ALIASES[id]]) return PARTNER_ALIASES[id];
    return DEFAULT_PARTNER;
  }

  function partner(partnerId) {
    return PARTNERS[resolvePartnerId(partnerId)];
  }

  /* ---------------------------------------------------------------------- */
  /* Affiliate users                                                        */
  /* ---------------------------------------------------------------------- */

  /* The mock persists user edits (primary contact, titles, away flag,
     avatars) to sessionStorage so a change made on the Account page is
     visible on the Partnership summary without a backend. In production this
     is an affiliate_users table — see ADMIN-MAPPING.md §1a. */
  function usersFor(partnerId) {
    var pid = resolvePartnerId(partnerId);
    try {
      var saved = sessionStorage.getItem('fz_users_' + pid);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    /* Deep copy so callers can mutate then save without touching the seed. */
    return JSON.parse(JSON.stringify(PARTNERS[pid].users));
  }

  function saveUsers(partnerId, users) {
    var pid = resolvePartnerId(partnerId);
    try { sessionStorage.setItem('fz_users_' + pid, JSON.stringify(users)); } catch (e) {}
  }

  function primaryContact(partnerId) {
    var users = usersFor(partnerId);
    for (var i = 0; i < users.length; i++) if (users[i].isPrimary) return users[i];
    return users[0] || null;
  }

  function setPrimaryContact(partnerId, userId) {
    var users = usersFor(partnerId);
    users.forEach(function (u) { u.isPrimary = u.id === userId; });
    saveUsers(partnerId, users);
    return users;
  }

  /* ---------------------------------------------------------------------- */
  /* Derived partner status                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * DERIVED, never stored: a partner is Active if we accepted at least one
   * of their leads in the trailing month. In production:
   *
   *   SELECT COUNT(*) FROM leads
   *    WHERE partner_id = ? AND status = 'paid'
   *      AND received_at >= NOW() - INTERVAL 1 MONTH
   *
   * Declared before ALL_LEADS is generated, so it must be CALLED only after
   * module init completes — which is every real caller, since pages call it
   * from the UI layer.
   */
  function isPartnerActive(partnerId) {
    var pid = resolvePartnerId(partnerId);
    var cutoff = addDays(TODAY, -30).getTime();
    var lastAccepted = null;
    for (var i = ALL_LEADS.length - 1; i >= 0; i--) {
      var l = ALL_LEADS[i];
      if (l.partnerId !== pid || l.status !== 'paid') continue;
      if (!lastAccepted || l.receivedAt > lastAccepted) lastAccepted = l.receivedAt;
      if (l.receivedAt.getTime() >= cutoff) {
        return { active: true, lastAcceptedAt: l.receivedAt };
      }
    }
    return { active: false, lastAcceptedAt: lastAccepted };
  }

  /** Average raw leads per week, trailing 28 days. */
  function avgWeeklyVolume(partnerId) {
    var pid = resolvePartnerId(partnerId);
    var cutoff = addDays(TODAY, -27).getTime();
    var n = 0;
    for (var i = 0; i < ALL_LEADS.length; i++) {
      var l = ALL_LEADS[i];
      if (l.partnerId === pid && l.receivedAt.getTime() >= cutoff) n++;
    }
    return Math.round(n / 4);
  }

  /**
   * DERIVED: payment usually lands on the third business day after a month
   * closes. Computed from the most recent month end; once that date has
   * passed, rolls to the next month's close. Weekends excluded; company
   * holidays are not modelled here — see ADMIN-MAPPING.md §1.
   */
  function nextPaymentDate() {
    function thirdBusinessDayAfter(monthEnd) {
      var d = new Date(monthEnd.getTime());
      var n = 0;
      while (n < 3) {
        d.setDate(d.getDate() + 1);
        var dow = d.getDay();
        if (dow !== 0 && dow !== 6) n++;
      }
      return d;
    }
    var pay = thirdBusinessDayAfter(new Date(TODAY.getFullYear(), TODAY.getMonth(), 0));
    if (pay < TODAY) {
      pay = thirdBusinessDayAfter(new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0));
    }
    return { date: pay, isToday: dayKey(pay) === dayKey(TODAY) };
  }

  function fmtSince(partnerId) {
    var iso = partner(partnerId).sinceISO;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    /* The lead export cannot answer this — its earliest row is the start of
       the export window, not the start of the relationship. */
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3])
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  /** Criteria labels must carry the partner's negotiated band. */
  /** Short display name for a reject bucket. The explanation is NOT part of
      the label any more — it lives in rejectDesc(), rendered behind a hover
      info button, so tables stay scannable. */
  function rejectLabel(key) {
    return REJECT_REASONS[key] ? REJECT_REASONS[key].label : key;
  }
  /** The hover-box explanation. Partner-aware where the criteria are — the
      age sentence carries THIS account's negotiated band. */
  function rejectDesc(key, partnerId) {
    if (key === 'age') {
      return 'The consumer\'s age is outside the ' + partner(partnerId).ageBand +
        ' band this account accepts.';
    }
    return REJECT_REASONS[key] ? (REJECT_REASONS[key].desc || '') : '';
  }
  function rejectFix(key) {
    return REJECT_REASONS[key] ? REJECT_REASONS[key].fix : '';
  }
  /** Is this bucket a lead-quality rejection at all? `filter_error` is not. */
  function rejectIsReal(key) {
    return !(REJECT_REASONS[key] && REJECT_REASONS[key].notReject);
  }
  /** Can the current data source populate this bucket? */
  function rejectIsLive(key) {
    return !!(REJECT_REASONS[key] && REJECT_REASONS[key].live);
  }
  function rejectGroup(key) {
    return REJECT_REASONS[key] ? REJECT_REASONS[key].group : null;
  }

  /**
   * The full affiliate-facing catalogue, counts merged in.
   *
   * Returns EVERY reason in the registry, not only the ones with volume in
   * the window — a reason at zero is the whole point of publishing a
   * catalogue, and a partner who has never seen "Consent missing" should
   * still be able to read what it would mean. Anything in `counts` that is
   * not in the registry lands in an `unknown` bucket rather than being
   * dropped, so a new internal code shows up as a visible gap instead of
   * silently vanishing from the totals.
   *
   * @param counts  {key: n} from computeMetrics().rejects
   */
  function rejectCatalogue(counts) {
    counts = counts || {};
    var out = REJECT_ORDER.map(function (k) {
      var r = REJECT_REASONS[k];
      return {
        key: k, label: r.label, group: r.group, fix: r.fix,
        live: !!r.live, notReject: !!r.notReject,
        count: counts[k] || 0
      };
    });
    Object.keys(counts).forEach(function (k) {
      if (REJECT_REASONS[k]) return;
      out.push({
        key: k, label: k, group: 'notreject', fix: '',
        live: true, notReject: false, unknown: true, count: counts[k]
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Campaigns                                                              */
  /* ---------------------------------------------------------------------- */

  /* Heritage's fresh/aged split is the live example of why campaigns must be
     broken out natively: a small excellent campaign and a large low-yield one
     blend into a single mediocre-looking account.

     `comp` is the field the query layer reads. `active` drives the Partnership
     summary — a paused campaign keeps its history but is not listed as live. */
  var CAMPAIGNS = [
    {
      id: '596', name: 'Annuity — Fresh', partnerId: 'ahg', comp: 'revshare',
      active: true, launched: 'Feb 2026',
      product: 'Annuity', kind: 'fresh', perDay: [4, 8], acceptRate: 0.80,
      sold: { priority: 0.16, hot: 0.13, auction: 0.05, marketplace: 0.04 },
      rejectMix: [['ipqs', 26], ['duplicate', 24], ['consent', 15], ['assets', 13], ['advisor', 10], ['age', 8], ['state', 4]],
      cycle: [7, 13],
      subids: [
        { id: 'ahg_search_brand', label: 'Search — brand',    share: 0.31, quality: 1.30 },
        { id: 'ahg_search_gen',   label: 'Search — generic',  share: 0.27, quality: 1.06 },
        { id: 'ahg_native_a',     label: 'Native — placement A', share: 0.23, quality: 0.84 },
        { id: 'ahg_display_rt',   label: 'Display — retarget', share: 0.19, quality: 0.58 }
      ]
    },
    {
      id: '597', name: 'Annuity — Aged under 6mo', partnerId: 'ahg', comp: 'revshare',
      active: true, launched: 'Mar 2026',
      product: 'Annuity', kind: 'aged', perDay: [10, 16], acceptRate: 0.62,
      sold: { priority: 0.035, hot: 0.045, auction: 0.08, marketplace: 0.10 },
      rejectMix: [['duplicate', 32], ['age', 20], ['contact', 16], ['assets', 12], ['ipqs', 11], ['consent', 6], ['advisor', 3]],
      cycle: [10, 19],
      subids: [
        { id: 'ahg_aged_a', label: 'Aged batch A', share: 0.52, quality: 1.02 },
        { id: 'ahg_aged_b', label: 'Aged batch B', share: 0.48, quality: 0.88 }
      ]
    },
    {
      id: '600', name: 'Annuity — Aged over 6mo', partnerId: 'ahg', comp: 'revshare',
      active: true, launched: 'Apr 2026',
      product: 'Annuity', kind: 'aged', perDay: [22, 34], acceptRate: 0.48,
      sold: { priority: 0.004, hot: 0.008, auction: 0.07, marketplace: 0.13 },
      rejectMix: [['duplicate', 34], ['age', 24], ['contact', 18], ['assets', 10], ['ipqs', 9], ['consent', 3], ['state', 2]],
      cycle: [12, 22],
      subids: [
        { id: 'ahg_bulk_1', label: 'Bulk import 1', share: 0.55, quality: 0.92 },
        { id: 'ahg_bulk_2', label: 'Bulk import 2', share: 0.45, quality: 0.80 }
      ]
    },

    {
      id: '371', name: 'Annuity — Landing page', partnerId: 'opx', comp: 'cpl',
      active: true, launched: 'Nov 2025',
      product: 'Annuity', kind: 'fresh', perDay: [12, 20], acceptRate: 0.78,
      sold: { priority: 0.12, hot: 0.10, auction: 0.05, marketplace: 0.04 },
      rejectMix: [['ipqs', 27], ['duplicate', 23], ['assets', 16], ['consent', 13], ['advisor', 10], ['age', 7], ['state', 4]],
      cycle: [7, 14],
      subids: [
        { id: 'opx_search_brand', label: 'Search — brand',     share: 0.30, quality: 1.28 },
        { id: 'opx_search_gen',   label: 'Search — generic',   share: 0.26, quality: 1.04 },
        { id: 'opx_native_a',     label: 'Native — placement A', share: 0.24, quality: 0.86 },
        { id: 'opx_display_rt',   label: 'Display — retarget', share: 0.20, quality: 0.60 }
      ]
    },
    {
      id: '412', name: 'Annuity — Email', partnerId: 'opx', comp: 'cpl',
      active: true, launched: 'Jan 2026',
      product: 'Annuity', kind: 'fresh', perDay: [10, 16], acceptRate: 0.66,
      sold: { priority: 0.08, hot: 0.09, auction: 0.06, marketplace: 0.06 },
      rejectMix: [['duplicate', 26], ['ipqs', 22], ['assets', 18], ['age', 13], ['contact', 11], ['consent', 7], ['advisor', 3]],
      cycle: [9, 17],
      subids: [
        { id: 'opx_email_house', label: 'Email — house file', share: 0.44, quality: 1.12 },
        { id: 'opx_email_part',  label: 'Email — partner',    share: 0.33, quality: 0.90 },
        { id: 'opx_email_cold',  label: 'Email — cold',       share: 0.23, quality: 0.54 }
      ]
    },
    {
      id: '488', name: 'Annuity — Spanish', partnerId: 'opx', comp: 'cpl',
      active: true, launched: 'Apr 2026',
      product: 'Annuity', kind: 'fresh', perDay: [4, 8], acceptRate: 0.72,
      sold: { priority: 0.10, hot: 0.10, auction: 0.05, marketplace: 0.05 },
      rejectMix: [['ipqs', 25], ['assets', 20], ['duplicate', 18], ['consent', 15], ['age', 12], ['advisor', 6], ['state', 4]],
      cycle: [8, 15],
      subids: [
        { id: 'opx_span_search', label: 'Spanish — search', share: 0.58, quality: 1.14 },
        { id: 'opx_span_social', label: 'Spanish — social', share: 0.42, quality: 0.88 }
      ]
    },
    /* Inactive campaigns. perDay [0,0] so they generate no leads — which is
       exactly why they are inactive. Today `active` is a manual flip in the
       admin system; the intended rule (see ADMIN-MAPPING.md §2) is DERIVED:
       auto-active while leads arrive, auto-inactive after 6 months without
       one. These two rows are what that rule would have flipped. */
    {
      id: '561', name: 'Annuity — Nurture reactivation', partnerId: 'ahg', comp: 'revshare',
      active: false, launched: 'Feb 2026',
      product: 'Annuity', kind: 'aged', perDay: [0, 0], acceptRate: 0.5,
      sold: { priority: 0, hot: 0, auction: 0, marketplace: 0 },
      rejectMix: [['duplicate', 1]], cycle: [10, 20], subids: []
    },
    {
      id: '433', name: 'Annuity — Social', partnerId: 'opx', comp: 'cpl',
      active: false, launched: 'Dec 2025',
      product: 'Annuity', kind: 'fresh', perDay: [0, 0], acceptRate: 0.5,
      sold: { priority: 0, hot: 0, auction: 0, marketplace: 0 },
      rejectMix: [['ipqs', 1]], cycle: [8, 16], subids: []
    },

    {
      id: '592', name: 'Life — Landing page', partnerId: 'opx', comp: 'cpl',
      active: true, launched: 'May 2026',
      product: 'Life', kind: 'fresh', perDay: [6, 11], acceptRate: 0.74,
      sold: { priority: 0.09, hot: 0.11, auction: 0.06, marketplace: 0.05 },
      rejectMix: [['ipqs', 26], ['consent', 20], ['duplicate', 17], ['contact', 14], ['state', 10], ['age', 8], ['advisor', 5]],
      cycle: [6, 13],
      subids: [
        { id: 'opx_life_search', label: 'Search — life', share: 0.44, quality: 1.16 },
        { id: 'opx_life_social', label: 'Social — life', share: 0.34, quality: 0.94 },
        { id: 'opx_life_email',  label: 'Email — life',  share: 0.22, quality: 0.72 }
      ]
    }
  ];

  var CAMPAIGN_BY_ID = {};
  CAMPAIGNS.forEach(function (c) { CAMPAIGN_BY_ID[c.id] = c; });

  function campaignsFor(partnerId) {
    var pid = resolvePartnerId(partnerId);
    return CAMPAIGNS.filter(function (c) { return c.partnerId === pid; });
  }
  function activeCampaignsFor(partnerId) {
    return campaignsFor(partnerId).filter(function (c) { return c.active; });
  }
  function inactiveCampaignsFor(partnerId) {
    return campaignsFor(partnerId).filter(function (c) { return !c.active; });
  }

  /**
   * What a set of leads is worth TO THE AFFILIATE — their revenue, not ours.
   *
   *   revenue-share rows → their share of the sale, on every lead that sold
   *   CPL rows           → accepted leads × that campaign's rate
   *
   * This is the affiliate's own invoice line, so it is not a redaction
   * concern: a partner knows their own rate card. It is deliberately NOT our
   * cost, margin, or per-lead spend.
   *
   * Returns `known:false` when no rate is on file for the CPL campaigns in
   * scope — better to say "we do not have your rate card wired up" than to
   * show a confident $0. Rate cards are a NEEDS BUILDING field; see
   * ADMIN-MAPPING.md.
   */
  function affiliatePayout(rows) {
    var total = 0, ratedLeads = 0, unratedAccepted = 0, sawCpl = false;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.partnerShare !== undefined && r.soldType) {
        total += r.partnerShare || 0;
        continue;
      }
      if (r.status !== 'paid') continue;
      var camp = CAMPAIGN_BY_ID[r.campaignId];
      if (!camp || camp.comp === 'revshare') continue;
      sawCpl = true;
      if (camp.cplRate != null) { total += camp.cplRate; ratedLeads++; }
      else unratedAccepted++;
    }
    return {
      total: round2(total),
      known: !sawCpl || ratedLeads > 0,
      ratedLeads: ratedLeads,
      unratedAccepted: unratedAccepted
    };
  }

  /** Partner-facing billing label for a campaign — the MODEL only, no rates.
      Rates live behind "View details", not in the summary table. */
  function compLabelForCampaign(c) {
    if (c.comp === 'revshare') return 'Revenue share';
    var card = PARTNERS[c.partnerId].rateCard || '';
    return card.indexOf('Tiered') === 0 ? 'Tiered CPL' : 'Flat CPL';
  }
  function campaignById(id) { return CAMPAIGN_BY_ID[id] || null; }

  /** The comp model a given campaign is billed on. */
  function compForCampaign(campaignId) {
    var c = CAMPAIGN_BY_ID[campaignId];
    return compModel(c ? c.comp : 'cpl');
  }

  /** Distinct comp models a partner is running right now. */
  function compsFor(partnerId) {
    var seen = {}, out = [];
    activeCampaignsFor(partnerId).forEach(function (c) {
      if (!seen[c.comp]) { seen[c.comp] = 1; out.push(compModel(c.comp)); }
    });
    return out;
  }

  /* Effective revenue-share rate for a campaign. Per-partner rather than a
     hardcoded 40% — annuity.org runs at 85%. */
  function revSharePctFor(camp) {
    return camp.comp === 'revshare' ? PARTNERS[camp.partnerId].revSharePct : 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Geography & demand                                                     */
  /* ---------------------------------------------------------------------- */

  /* New York is a hard exclusion and is deliberately absent from supply here;
     the few that arrive are generated as rejects. */
  var STATES = [
    ['TX', 14], ['FL', 13], ['OH', 8], ['PA', 8], ['NC', 7], ['GA', 7],
    ['MI', 6], ['TN', 5], ['MO', 5], ['IN', 4], ['AZ', 4], ['CO', 3],
    ['WA', 3], ['CA', 6], ['NV', 2], ['UT', 2], ['NM', 1], ['KS', 1],
    ['NE', 1], ['SD', 1]
  ];

  /* Per-state monthly demand. `budget` is what we have to spend there this
     month; `fillRate` is how much of it current supply is consuming. Unused
     budget is the ask — it is money already approved that nobody is filling.

     MOCK VALUES. In production this comes off the buyer-demand table; see
     ADMIN-MAPPING.md. The shape is real though: Pacific and Mountain are a
     standing coverage gap, which is why they dominate the unused column. */
  /* ======================================================================
     STATES — the full 50, and where the demand numbers come from
     ----------------------------------------------------------------------
     ALL FIFTY STATES ARE LISTED, ALWAYS. The States card used to build its
     rows from the union of "states we have demand data for" and "states this
     affiliate already sends from", which quietly hid the most useful row on
     the card: a state nobody has data on and nobody is sending to. A partner
     deciding where to buy needs to see the whole map, including the empty
     parts of it.

     New York is deliberately present. It is never accepted (see
     REJECT_REASONS.state) and the card marks it so — a partner who does not
     know that is exactly the partner who needs to be told, and leaving the
     row out means they find out through a rejection instead.

     TWO DIFFERENT SOURCES MEET IN THIS CARD, and only one of them exists:

       · Volume and conversion per state — REAL, computed from the affiliate's
         own leads (`computeMetrics().byState`).
       · Buyer budget per state — A CONNECTION POINT. `ADMIN_STATE_DEMAND`
         below is a hardcoded stand-in for what the system will supply. A
         state with no demand record renders its budget cell blank rather
         than as "fully covered", because "we have no data" and "we have no
         room" are different answers and only one of them is true.
     ====================================================================== */
  var US_STATES = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
    ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
    ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'],
    ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
    ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
    ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
    ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
    ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
    ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
    ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
    ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
    ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
    ['WI', 'Wisconsin'], ['WY', 'Wyoming']
  ];
  var STATE_NAME = {};
  US_STATES.forEach(function (r) { STATE_NAME[r[0]] = r[1]; });

  /* States we never accept, whatever the demand table says. */
  var BLOCKED_STATES = { NY: 'New York is never accepted on any campaign.' };

  /* HARDCODED STAND-IN FOR THE BUYER-DEMAND CONNECTION. In production this
     comes off the buyer-demand table, per state, refreshed as budgets move.
     A state absent from here has NO DATA, which the card renders as blank —
     not as "covered". ADMIN-MAPPING §5a. */
  var ADMIN_STATE_DEMAND = [
    { st: 'CA', tz: 'PT', budget: 42000, fillRate: 0.38 },
    { st: 'WA', tz: 'PT', budget: 18000, fillRate: 0.41 },
    { st: 'AZ', tz: 'MT', budget: 16000, fillRate: 0.44 },
    { st: 'NV', tz: 'PT', budget:  9000, fillRate: 0.36 },
    { st: 'CO', tz: 'MT', budget: 12000, fillRate: 0.55 },
    { st: 'NM', tz: 'MT', budget:  6000, fillRate: 0.33 },
    { st: 'UT', tz: 'MT', budget:  7500, fillRate: 0.52 },
    { st: 'TX', tz: 'CT', budget: 38000, fillRate: 0.91 },
    { st: 'KS', tz: 'CT', budget:  5000, fillRate: 0.48 },
    { st: 'NE', tz: 'CT', budget:  4500, fillRate: 0.51 },
    { st: 'SD', tz: 'CT', budget:  3000, fillRate: 0.44 },
    { st: 'MO', tz: 'CT', budget:  9000, fillRate: 0.86 },
    { st: 'FL', tz: 'ET', budget: 36000, fillRate: 0.94 },
    { st: 'OH', tz: 'ET', budget: 14000, fillRate: 0.89 },
    { st: 'PA', tz: 'ET', budget: 13000, fillRate: 0.92 },
    { st: 'NC', tz: 'ET', budget: 12000, fillRate: 0.88 },
    { st: 'GA', tz: 'ET', budget: 11000, fillRate: 0.90 },
    { st: 'MI', tz: 'ET', budget: 10000, fillRate: 0.87 },
    { st: 'TN', tz: 'CT', budget:  8000, fillRate: 0.85 },
    { st: 'IN', tz: 'ET', budget:  7000, fillRate: 0.83 }
  ];

  /* Name comes from the canonical list so the demand table cannot disagree
     with it, and so a new state needs one entry, not two. */
  var STATE_DEMAND = ADMIN_STATE_DEMAND.map(function (d) {
    return { st: d.st, name: STATE_NAME[d.st] || d.st, tz: d.tz,
             budget: d.budget, fillRate: d.fillRate };
  });

  /* Blended CPL used to convert unused budget into a lead count. Rounded to
     the mid tier rather than computed per band — the point of the widget is
     "roughly this many leads," not an invoice. */
  var BLENDED_CPL = 90;

  /**
   * States with unfilled budget, richest first.
   * @param opts.limit  how many rows to return
   */
  function stateDemand(opts) {
    opts = opts || {};
    var rows = STATE_DEMAND.map(function (s) {
      var unused = Math.round(s.budget * (1 - s.fillRate));
      return {
        st: s.st, name: s.name, tz: s.tz,
        budget: s.budget,
        fillRate: s.fillRate,
        unusedBudget: unused,
        leadsNeeded: Math.round(unused / BLENDED_CPL),
        western: s.tz === 'PT' || s.tz === 'MT'
      };
    }).sort(function (a, b) { return b.unusedBudget - a.unusedBudget; });
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  /**
   * How much room a state has, as a BAND rather than a number.
   *
   * The dollar figures stay internal (§5a) — an affiliate seeing "$26,040
   * unspent in California" is reading our negotiating position. A band leaks
   * nothing the ranked list does not already imply, and "High" is readable at
   * a glance in a way that "Room for more" was not: the old binary flag told a
   * partner a state was wanted but not whether it was wanted a little or a
   * lot, which is exactly the decision they are trying to make.
   *
   * Cut on the state's own share of ALL unspent budget, so the bands stay
   * stable as the demand table changes rather than being fixed dollar cuts
   * that go stale.
   */
  var BUDGET_BANDS = [
    { key: 'high', label: 'High',     min: 0.10 },
    { key: 'mid',  label: 'Moderate', min: 0.05 },
    { key: 'low',  label: 'Some',     min: 0.00 }
  ];

  function budgetRoom() {
    var rows = stateDemand();
    var total = rows.reduce(function (a, r) { return a + r.unusedBudget; }, 0) || 1;
    var out = {};
    rows.forEach(function (r) {
      var share = r.unusedBudget / total;
      var band = BUDGET_BANDS.filter(function (b) { return share >= b.min; })[0] ||
                 BUDGET_BANDS[BUDGET_BANDS.length - 1];
      out[r.st] = { st: r.st, name: r.name, band: band.key, bandLabel: band.label,
                    share: share, rank: 0 };
    });
    rows.forEach(function (r, i) { out[r.st].rank = i + 1; });
    return out;
  }

  /**
   * All fifty states for one affiliate, each carrying both halves of the
   * decision: what they send there, and whether we have room to buy it.
   *
   * Returns EVERY state, always — sorting and paging are the caller's job,
   * and a card that filters rows out before the user sorts is a card that
   * lies about what it contains.
   *
   * @param opts.byState  computeMetrics().byState for this affiliate
   */
  function stateRows(opts) {
    opts = opts || {};
    var by = opts.byState || {};
    var room = budgetRoom();
    return US_STATES.map(function (pair) {
      var st = pair[0];
      var b = by[st] || { raw: 0, mature: 0, ph: 0 };
      var r = room[st] || null;
      return {
        st: st,
        name: pair[1],
        blocked: !!BLOCKED_STATES[st],
        blockedNote: BLOCKED_STATES[st] || null,
        raw: b.raw,
        mature: b.mature,
        ph: b.ph,
        rate: b.mature ? b.ph / b.mature : null,
        /* null = we have no demand record for this state, which is NOT the
           same as having no room. The card renders it blank. */
        room: r,
        roomRank: r ? r.rank : null
      };
    });
  }

  /* Kept for the health pillar and the rejection copy: the states we most want
     volume from. Derived from demand rather than hand-maintained twice. */
  var COVERAGE_STATES = {};
  STATE_DEMAND.forEach(function (s) {
    if (1 - s.fillRate >= 0.35) COVERAGE_STATES[s.st] = 1;
  });
  function isCoverageState(st) { return !!COVERAGE_STATES[st]; }

  /* ---------------------------------------------------------------------- */
  /* Operating hours & ideal send windows                                   */
  /* ---------------------------------------------------------------------- */

  /* THESE ARE REAL OPERATING FACTS, not fabricated shape. Everything the
     dashboard says about timing has to agree with them.

     An earlier version of this mock asserted a 6–9a "golden window". That was
     invented, it predated the call-centre hours below, and it contradicted
     them — the floor is not open at 6a. It has been removed rather than left
     to argue with the coverage widgets. */
  var OPERATING_HOURS = {
    weekday: 'Monday–Friday, 9:00 AM – 7:00 PM local time in every timezone we cover ' +
             '(9:00 AM – 10:00 PM ET end to end)',
    saturday: 'Saturday, 9:00 AM – 8:00 PM ET, lighter staffing',
    sunday: 'Closed Sundays',
    /* 8p ET on Saturday is 5p Pacific and 6p Mountain, so the 3–7p local
       window does not hold out west on Saturdays. Surfaced as a caveat on any
       partner running western states rather than buried in a footnote. */
    saturdayWestCaveat: 'Saturday closes at 8 PM ET — 5 PM Pacific, 6 PM Mountain. ' +
                        'The 3–7p local window does not hold out west on Saturdays; ' +
                        'the morning window is the one that works cleanly.'
  };

  /* Ideal reception windows, consumer local time, Monday–Friday. */
  var IDEAL_WINDOWS = [
    { label: '9:00 – 11:00 AM', segs: ['primeam'] },
    { label: '3:00 – 7:00 PM',  segs: ['primepm'] }
  ];

  /* THE FRAMING IS THE POINT. Everything on the Targeting page is an
     observation about where leads convert best, offered so a partner can get
     more out of the volume they already send. None of it is a request for
     volume, and none of it is a gate — we accept every lead, any day, any
     hour, from any state.

     This matters commercially, not just tonally: a partner who reads these as
     requirements sends LESS, holding back volume that falls outside them.
     Every rendering of a window, a day split or a state list carries this
     note for that reason. */
  var COVERAGE_NOTE =
    'Nothing here is a requirement, and none of it is us asking for more leads — ' +
    'we accept every lead you send, any day, any hour, from any state. These are ' +
    'simply the windows where our floor is fully staffed, so leads landing in them ' +
    'get contacted fastest and convert best for you. Weighting your sends this way ' +
    'lifts the return on volume you are already buying. Saturday runs on lighter ' +
    'staffing, and anything landing Sunday sits until Monday morning.';

  /* Arrival windows, consumer local time. `ideal` marks the two windows above.
     Weights are the mock's supply mix; yields are how well each converts. */
  var HOUR_SEGMENTS = [
    ['overnight',  3],   /* 12a–6a  — nobody is calling these for hours     */
    ['early',     12],   /* 6a–9a   — arrives before the floor opens        */
    ['primeam',   17],   /* 9a–11a  ★ ideal                                 */
    ['midmorning',15],   /* 11a–1p                                          */
    ['midday',    14],   /* 1p–3p                                           */
    ['primepm',   24],   /* 3p–7p   ★ ideal                                 */
    ['evening',   11],   /* 7p–9p   — after close                           */
    ['late',       4]    /* 9p–12a                                          */
  ];
  var HOUR_SEGMENT_LABEL = {
    overnight: '12a–6a', early: '6a–9a', primeam: '9a–11a', midmorning: '11a–1p',
    midday: '1p–3p', primepm: '3p–7p', evening: '7p–9p', late: '9p–12a'
  };
  var HOUR_SEGMENT_ORDER = ['overnight', 'early', 'primeam', 'midmorning',
                            'midday', 'primepm', 'evening', 'late'];
  var IDEAL_SEGMENTS = { primeam: 1, primepm: 1 };
  function isIdealSegment(seg) { return !!IDEAL_SEGMENTS[seg]; }

  /* Conversion lift by arrival window. Peaks inside the two ideal windows,
     falls off outside operating hours — a lead landing at 11pm waits ten hours
     for its first dial and converts accordingly. */
  /* The two ideal windows are kept clearly ahead of their neighbours rather
     than marginally ahead. At 30-day cohort sizes the per-window buckets are
     small enough that a 0.1pp gap disappears into noise, and the Performance
     card would then star a window the table shows in second place. */
  var HOUR_YIELD = {
    overnight: 0.38, early: 0.74, primeam: 1.95, midmorning: 0.98,
    midday: 0.88, primepm: 1.80, evening: 0.64, late: 0.42
  };

  var HOUR_RANGES = {
    overnight: [0, 6], early: [6, 9], primeam: [9, 11], midmorning: [11, 13],
    midday: [13, 15], primepm: [15, 19], evening: [19, 21], late: [21, 24]
  };

  var DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* Ideal share of a week's volume by day. Sunday is 0% because nothing sent
     Sunday is worked until Monday — it is not a restriction, it is where the
     lead lands in the queue. Indexed by JS getDay(). */
  var IDEAL_DOW_SPLIT = [0.00, 0.20, 0.19, 0.19, 0.19, 0.15, 0.08];

  /* ---- Weeks of the month ------------------------------------------------
     Four buckets rather than 31 days: a per-day read on a 30-day cohort is
     noise, and the question a partner can act on is "which part of the month
     works for me".

     THERE IS NO IDEAL WEEK OF THE MONTH AND WE DO NOT INVENT ONE. Unlike
     hours and days of week — where the call floor's staffing is a real,
     stated fact — nothing about our operation prefers the 3rd to the 23rd. So
     the HEALTH SCORE reads this as evenness only, never as conformance to a
     shape we made up. The Targeting page is different: there it is derived
     from the partner's OWN results, which is an observation about their
     traffic rather than a preference of ours.

     (An earlier version of this prototype asserted a 6–9a "golden window"
      that nobody had ever said. It cost us credibility to unwind. Same trap
      here — do not fill this in with a preferred week.) */
  var MONTH_PHASES = [
    { key: 'w1', label: 'Days 1–7',   from: 1,  to: 7 },
    { key: 'w2', label: 'Days 8–14',  from: 8,  to: 14 },
    { key: 'w3', label: 'Days 15–21', from: 15, to: 21 },
    { key: 'w4', label: 'Day 22–end', from: 22, to: 31 }
  ];
  var MONTH_PHASE_ORDER = ['w1', 'w2', 'w3', 'w4'];
  function monthPhase(d) {
    var day = d.getDate();
    return day <= 7 ? 'w1' : day <= 14 ? 'w2' : day <= 21 ? 'w3' : 'w4';
  }
  var MONTH_PHASE_LABEL = {};
  MONTH_PHASES.forEach(function (m) { MONTH_PHASE_LABEL[m.key] = m.label; });

  /* ======================================================================
     TOP CONVERSION WINDOWS — derived per partner, admin-overridable
     ----------------------------------------------------------------------
     What the Targeting page shows for hour of day, day of week and week of
     the month. Three sources, in strict precedence:

       1. OVERRIDE  — an admin has pinned this partner's windows by hand.
                      Always wins. This is the failsafe: derived numbers on a
                      thin or weird month can be wrong, and an account manager
                      who knows better needs a way to say so without a deploy.
       2. DERIVED   — computed from THIS partner's own trailing 30-day matured
                      cohort. The default, and the point of the feature: a
                      global "9–11am and 3–7pm" tells a partner nothing about
                      their own traffic.
       3. DEFAULT   — the stated operating-hours windows. Used when the
                      partner has too little matured volume to read, or when
                      the data cannot answer at all.

     WHY IT CAN FALL BACK. Hour of day is UNANSWERABLE on the live export:
     `TimeStamp` is empty on every row and `Created On` is date-only (A1). So
     hours land on DEFAULT for everyone until that field arrives, and the card
     says so rather than plotting a shape it cannot support.

     "Best" is measured against THE PARTNER'S OWN AVERAGE, not against a
     threshold we picked. A bucket is highlighted when it beats that partner's
     own Priority/Hot conversion rate on a large enough sample. That keeps the
     claim honest — "these convert better than your average" is true or it is
     not — and it means a strong account is not told everything is bad because
     it fails somebody else's bar.
     ====================================================================== */

  /* Admin override. `null` for a partner (or absent) means DERIVE.
     Shape when set — any grain may be set independently:
       { hours: ['primeam','primepm'], dow: [2,3,4], week: ['w1','w2'] }
     THIS IS A HARDCODED STAND-IN FOR AN ADMIN SCREEN — ADMIN-MAPPING §5b. */
  var ADMIN_CONVERSION_WINDOWS = {};

  /* THREE GUARDS ON CALLING SOMETHING A TOP WINDOW. All of them are needed;
     each one alone lets an obvious piece of noise through.

       CW_MIN_BUCKET — matured leads in the bucket. Three leads and one sale
                       is not a 33% hour.
       CW_MIN_SALES  — Priority/Hot sales in the bucket. This is the guard
                       that matters on a low-converting account: with a 0.2%
                       baseline, ONE sale in a 25-lead bucket reads as a 20×
                       lift. Requiring real sales kills that.
       CW_LIFT       — how much better than the partner's own average it has
                       to be. Without a margin, a 0.24% day "beats" a 0.20%
                       average and gets recommended, which is worse than
                       recommending nothing. */
  var CW_MIN_BUCKET = 25;
  var CW_MIN_SALES = 3;
  var CW_LIFT = 1.20;
  /* And the scope as a whole needs this much matured volume before we derive
     at all, rather than showing a partner a shape built from nothing. */
  var CW_MIN_SCOPE = 150;

  function cwRate(b) { return b && b.mature ? b.ph / b.mature : 0; }

  /**
   * Rank one grain's buckets by the partner's own conversion rate.
   * @param buckets  map of key -> {raw, mature, ph}
   * @param defs     [{key,label}] in display order
   * @param baseline the partner's own overall P/H rate
   */
  function cwRank(buckets, defs, baseline) {
    return defs.map(function (d) {
      var b = buckets[d.key] || { raw: 0, mature: 0, ph: 0 };
      var r = cwRate(b);
      var thin = b.mature < CW_MIN_BUCKET || b.ph < CW_MIN_SALES;
      return {
        key: d.key, label: d.label,
        raw: b.raw, mature: b.mature, ph: b.ph, rate: r,
        thin: thin,
        best: !thin && baseline > 0 && r >= baseline * CW_LIFT
      };
    }).sort(function (a, b) {
      /* Thin buckets sink regardless of their rate — a 100% hour on six
         leads must never head this list. */
      if (a.thin !== b.thin) return a.thin ? 1 : -1;
      return b.rate - a.rate;
    });
  }

  /**
   * The three grains for one partner.
   * @param opts.partnerId
   * @param opts.campaignId  optional scope
   * @returns { hours, dow, week } — each { source, items, note, baseline }
   */
  function conversionWindows(opts) {
    opts = opts || {};
    var pid = resolvePartnerId(opts.partnerId);
    var override = ADMIN_CONVERSION_WINDOWS[pid] || null;

    var coh = cohort({ partnerId: pid, campaignId: opts.campaignId });
    var m = coh.metrics;
    var scopeMature = m.mature || 0;

    /* BASELINE MUST SHARE THE BUCKETS' DENOMINATOR. The buckets count P/H
       sales over ALL matured leads in the bucket (cwRate), because that is
       the only count a bucket carries — so the average has to be computed the
       same way. Using m.priorityHotRate here instead is wrong and silently
       breaks the whole card: that rate divides by matured ACCEPTED leads, so
       on a partner accepting ~49% it sits at roughly double every bucket, no
       bucket can ever clear it, and every grain reports "no clear standout".
       Same basis as the Investable assets and States cards on the Targeting
       page, which both rate a bucket as ph / mature. */
    var baseline = scopeMature ? (m.soldPriorityHot || 0) / scopeMature : 0;
    var enough = scopeMature >= CW_MIN_SCOPE;

    var noTime = !!(DATASET_NOTES && DATASET_NOTES.noTimeOfDay);

    function grain(key, buckets, defs, defaultItems, defaultNote) {
      /* 1. override */
      if (override && override[key] && override[key].length) {
        var pick = {};
        override[key].forEach(function (k) { pick[String(k)] = 1; });
        return {
          source: 'override',
          baseline: baseline,
          items: defs.filter(function (d) { return pick[String(d.key)]; })
                     .map(function (d) { return { key: d.key, label: d.label, best: true }; }),
          note: 'Set by your account manager for this account.'
        };
      }
      /* 2. derived */
      if (buckets && enough) {
        var ranked = cwRank(buckets, defs, baseline);
        if (ranked.filter(function (r) { return r.best; }).length) {
          return { source: 'derived', baseline: baseline, items: ranked, note: null };
        }
        /* Derived, but nothing beat their own average on a real sample —
           usually a flat month. Say that rather than highlighting the top of
           a list of ties. */
        return { source: 'derived', baseline: baseline, items: ranked,
                 note: 'No clear standout in the last 30 days — your volume converts about ' +
                       'evenly across these.' };
      }
      /* 3. default */
      return { source: 'default', baseline: baseline, items: defaultItems, note: defaultNote };
    }

    var thinNote = 'Based on our staffing until you have more matured volume — you have ' +
      fmtIntPlain(scopeMature) + ' lead' + (scopeMature === 1 ? '' : 's') +
      ' finished their sales cycle in the last 30 days, and we want at least ' +
      CW_MIN_SCOPE + ' before reading your own pattern.';

    var hourDefs = HOUR_SEGMENT_ORDER.map(function (k) {
      return { key: k, label: HOUR_SEGMENT_LABEL[k] };
    });
    var dowDefs = [1, 2, 3, 4, 5, 6, 0].map(function (d) {
      return { key: d, label: DOW_SHORT[d] };
    });
    var weekDefs = MONTH_PHASES.map(function (w) {
      return { key: w.key, label: w.label };
    });

    return {
      scopeMature: scopeMature,
      enough: enough,
      hours: grain('hours', noTime ? null : m.bySegment, hourDefs,
        IDEAL_WINDOWS.map(function (w) {
          return { key: w.segs[0], label: w.label, best: true };
        }),
        noTime
          ? 'Time of day is not connected yet, so we cannot read your own hours. These are the ' +
            'hours our floor is fully staffed — your own will appear here once it is wired up.'
          : thinNote),
      dow: grain('dow', m.byDow, dowDefs,
        dowDefs.filter(function (d) { return IDEAL_DOW_SPLIT[d.key] >= 0.19; })
               .map(function (d) { return { key: d.key, label: d.label, best: true }; }),
        thinNote),
      week: grain('week', m.byPhase, weekDefs,
        weekDefs.map(function (w) { return { key: w.key, label: w.label, best: false }; }),
        'We have no preferred week of the month, and you do not yet have the volume for us to ' +
        'read yours. Steady pacing is what helps.')
    };
  }

  /* Local int formatter — app.js is not loaded when data.js runs. */
  function fmtIntPlain(n) { return (n || 0).toLocaleString('en-US'); }

  /* ---------------------------------------------------------------------- */
  /* Lead criteria — the Targeting page                                     */
  /* ---------------------------------------------------------------------- */

  /* What makes a lead payable, per product. The age row is a FUNCTION of the
     partner because the accepted band is a negotiated commercial term —
     OptiLabX runs 45–79 against the standard 45–75, and hardcoding the
     standard band has already cost a $5,194 invoice variance. */
  function leadCriteria(partnerId) {
    var p = partner(partnerId);
    var exception = p.ageBand !== '45–75';
    return {
      annuity: [
        { label: 'Age', value: p.ageBand + (exception ? ' — negotiated for your account (standard is 45–75)' : ''), highlight: exception },
        { label: 'Investable assets', value: 'Greater than $25,000 — under $25K never pays, on any comp model' },
        { label: 'Location', value: 'US only. New York is never accepted.' },
        { label: 'Phone', value: 'Valid, working US number' },
        { label: 'Email', value: 'Valid, working' },
        { label: 'Consent', value: 'TrustedForm or Jornaya certificate — prior express written consent' },
        { label: 'Transmission', value: 'Real time, via our landing page or authorized API' }
      ],
      life: [
        { label: 'Age', value: '25 to 73' },
        { label: 'Household income', value: '$40,000 or greater' },
        { label: 'Declared health', value: 'Good, Average, or Excellent — Poor not accepted' },
        { label: 'Coverage amount', value: 'Greater than $50,000. Final Expense excluded.' },
        { label: 'Location', value: 'US only. New York is never accepted.' },
        { label: 'Consent', value: 'TrustedForm or Jornaya certificate' }
      ]
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Generation                                                             */
  /* ---------------------------------------------------------------------- */

  function dayKey(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) {
    var c = new Date(d.getTime());
    c.setDate(c.getDate() + n);
    return c;
  }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

  function hourForSegment(seg) {
    var r = HOUR_RANGES[seg] || [12, 13];
    return intBetween(r[0], r[1] - 1);
  }

  function generate() {
    var leads = [];
    var counter = 41200;
    var start = addDays(TODAY, -(HISTORY_DAYS - 1));

    for (var dayIdx = 0; dayIdx < HISTORY_DAYS; dayIdx++) {
      var day = addDays(start, dayIdx);
      var dow = day.getDay();
      /* Monday–Wednesday is the strongest revenue window, Wednesday biggest;
         weekends run light and carry the worst COGS. Deliberately NOT matched
         to IDEAL_DOW_SPLIT — the gap between what a partner sends and the
         ideal split is the whole point of the daily-split widget. */
      var dowFactor = [0.55, 1.06, 1.10, 1.14, 1.00, 0.92, 0.66][dow];
      var drift = 0.86 + (dayIdx / HISTORY_DAYS) * 0.30;

      for (var c = 0; c < CAMPAIGNS.length; c++) {
        var camp = CAMPAIGNS[c];
        var base = between(camp.perDay[0], camp.perDay[1]);
        var count = Math.max(0, Math.round(base * dowFactor * drift));
        for (var i = 0; i < count; i++) leads.push(makeLead(camp, day, ++counter));
      }
    }

    leads.sort(function (a, b) { return a.receivedAt - b.receivedAt; });
    return leads;
  }

  function makeLead(camp, day, seq) {
    var sub = weighted(camp.subids.map(function (s) { return [s, s.share]; }));
    var q = sub.quality;

    var seg = weighted(HOUR_SEGMENTS);
    var received = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
                            hourForSegment(seg), intBetween(0, 59), intBetween(0, 59));

    var state = weighted(STATES);
    var band = weighted(ASSET_BANDS.map(function (b) { return [b, b.weight]; }));

    var lead = {
      id: 'FZ-' + seq,
      receivedAt: received,
      partnerId: camp.partnerId,
      comp: camp.comp,
      campaignId: camp.id,
      campaignName: camp.name,
      campaignKind: camp.kind,
      product: camp.product,
      subid: sub.id,
      subidLabel: sub.label,
      state: state,
      hourSegment: seg,
      assetBand: band.key,
      status: 'paid',
      rejectReason: null,
      soldType: null,
      soldAt: null,
      daysToSale: null,
      saleAmount: 0,
      partnerShare: 0,

      /* ---- INTERNAL ONLY. Never leaves queryLeads(). ---------------- */
      _leadCost: 0,
      _margin: 0,
      _buyerName: null,
      _csrName: null,
      _callResult: null,
      _ipqsScore: Math.round(between(18, 96)),
      _unfired: false,
      _badContact: false
    };

    /* Under $25K investable never pays, under any comp model. */
    var forcedReject = !band.payable;
    var accept = Math.min(0.94, camp.acceptRate * (0.72 + 0.28 * q));
    var isPaid = !forcedReject && rnd() < accept;

    var pct = revSharePctFor(camp);

    if (!isPaid) {
      lead.status = 'free';
      lead.rejectReason = forcedReject ? 'assets' : weighted(camp.rejectMix);

      /* REJECTED-BUT-SOLD. A lead we declined can still find a buyer, and it
         costs us nothing because we never paid for it.

         Revenue-share campaigns SHOW these and are paid on them — confirmed by
         Logan Aug 2026, overriding the blanket rule in the context doc. CPL
         campaigns must never reveal they exist; see the row rule in
         runQuery(). */
      lead._leadCost = 0;
      applyOutcome(lead, camp, received, rejectedSellRates(camp), q, band, seg, pct);
      lead._badContact = rnd() < (0.11 / Math.max(0.5, q));
      return lead;
    }

    lead._leadCost = round2(band.cpl * between(0.92, 1.08));
    applyOutcome(lead, camp, received, camp.sold, q, band, seg, pct);

    lead._csrName = pick(['D. Alvarez', 'M. Chen', 'R. Whitfield', 'T. Okafor', 'J. Reyes']);
    lead._callResult = pick(['Contacted — qualified', 'Contacted — not qualified',
                             'No answer', 'Voicemail', 'Callback scheduled']);
    lead._badContact = rnd() < (0.07 / Math.max(0.5, q));
    lead._unfired = lead.soldType ? rnd() < 0.035 : false;

    return lead;
  }

  /* Leads we declined sell far less often at the top tiers — that is why we
     declined them — but they still clear at auction and marketplace. */
  function rejectedSellRates(camp) {
    return {
      priority:    camp.sold.priority * 0.16,
      hot:         camp.sold.hot * 0.22,
      auction:     camp.sold.auction * 0.55,
      marketplace: camp.sold.marketplace * 0.70
    };
  }

  function applyOutcome(lead, camp, received, rates, q, band, seg, revSharePct) {
    /* Asset band and arrival window both move conversion. The $100K–$250K
       band and the two ideal windows are the biggest levers a partner has. */
    var lift = band.yield * (HOUR_YIELD[seg] || 1);

    var r = rnd();
    var pPriority = rates.priority * q * lift;
    var pHot      = rates.hot * q * lift;
    var pAuction  = rates.auction;
    var pMarket   = rates.marketplace;

    var soldType = null;
    if (r < pPriority) soldType = 'priority';
    else if (r < pPriority + pHot) soldType = 'hot';
    else if (r < pPriority + pHot + pAuction) soldType = 'auction';
    else if (r < pPriority + pHot + pAuction + pMarket) soldType = 'marketplace';
    if (!soldType) return;

    var cycle = Math.round(between(camp.cycle[0], camp.cycle[1]));
    var soldAt = addDays(received, cycle);
    /* A lead cannot have sold in the future. Leads inside the maturity buffer
       are still cooking — that is not missing data. */
    if (soldAt > TODAY) return;

    /* Appointment booking and Live transfer launched Aug 2026. A small slice
       of what would have been Priority now routes to them. */
    if (soldType === 'priority' && soldAt >= NEW_PRODUCT_LAUNCH) {
      var roll = rnd();
      if (roll < 0.14) soldType = 'appointment';
      else if (roll < 0.20) soldType = 'livetransfer';
    }

    var price = SOLD_TYPES[soldType].price;
    lead.soldType = soldType;
    lead.soldAt = soldAt;
    lead.daysToSale = cycle;
    lead.saleAmount = round2(between(price[0], price[1]));
    lead.partnerShare = round2(lead.saleAmount * revSharePct);
    lead._margin = round2(lead.saleAmount - lead._leadCost - lead.partnerShare);
    lead._buyerName = pick(['Meridian Retirement', 'Crestline Financial', 'Oakhaven Advisors',
                            'Summit Wealth Partners', 'Brightwater Group']);
  }

  /* ======================================================================
     REAL DATA LOADER
     ----------------------------------------------------------------------
     If assets/data/dataset.js loaded before this file, window.FZ_DATASET holds
     a real lead export and we build PARTNERS, CAMPAIGNS and ALL_LEADS from it.
     Otherwise everything above stands and the mock generator runs, so the
     prototype still works with no data file present.

     The loader emits records in EXACTLY the shape makeLead() produces, so the
     query layer, the firewall and every metric downstream are untouched by the
     swap. Fields the export cannot supply are left null rather than defaulted
     — see DATASET_NOTES and the Data source page.
     ====================================================================== */

  var DATASET = global.FZ_DATASET || null;
  var DATASET_NOTES = null;
  var USING_REAL_DATA = false;
  var REKEY_TARGETS = null;

  function loadDataset(ds) {
    var f = {};
    ds.fields.forEach(function (name, i) { f[name] = i; });

    var epochParts = ds.epoch.split('-');
    var epoch = new Date(+epochParts[0], +epochParts[1] - 1, +epochParts[2]);
    function dayToDate(n) {
      return n < 0 ? null : addDays(epoch, n);
    }

    /* ---- partners ---- */
    var partners = {};
    ds.partners.forEach(function (p) {
      var camps = ds.campaigns.filter(function (c) { return c.partnerId === p.id; });
      var rev = camps.filter(function (c) { return c.comp === 'revshare'; })[0];
      partners[p.id] = {
        id: p.id,
        name: p.name,
        shortName: p.name.split(' ')[0],
        affiliateId: p.affiliateId,
        rateCard: rev ? ('Revenue share — ' + Math.round(rev.revSharePct * 100) + '%')
                      : 'Cost per lead',
        revSharePct: rev ? rev.revSharePct : 0,
        /* Not in the export. OptiLabX's negotiated 45–79 is carried from the
           commercial record; everyone else falls back to standard. */
        ageBand: /optilabx/i.test(p.name) ? '45–79' : '45–75',
        ageBandNote: /optilabx/i.test(p.name)
          ? 'Negotiated exception — wider than the standard 45–75.'
          : 'Standard criteria.',
        products: (function () {
          var set = {};
          camps.forEach(function (c) { set[c.product] = 1; });
          return Object.keys(set).sort().join(' + ') || 'Annuity';
        })(),
        integration: '—',
        integrationNote: null,
        /* Left NULL rather than derived. The earliest lead we hold is a floor
           on the relationship, not its start date, and a wrong date on a
           partnership summary is worse than a blank one. Populates from the
           partner record once that is connected. */
        sinceISO: null,
        billingPeriod: 'Net 30',
        billingBasis: 'Invoiced monthly',
        exclusivity: '365-day Priority/Hot exclusivity window',
        /* No contact record is connected yet. `placeholder: true` makes the
           views render a designed empty state ("no contact on file yet")
           instead of a fake-looking record — an unconnected field should read
           as an unfilled field, not as broken UI. */
        users: [
          { id: p.id + '-u1', name: 'Primary contact', title: null,
            email: 'contact@' + p.id + '.example', isPrimary: true, away: false, avatar: null,
            placeholder: true }
        ]
      };
    });

    /* ---- campaigns ---- */
    var campaigns = ds.campaigns.map(function (c) {
      return {
        id: c.cid, name: c.name, partnerId: c.partnerId, comp: c.comp,
        active: c.active, launched: c.lastLead ? '' : '',
        product: c.product, kind: /aged|6m|pq/i.test(c.name) ? 'aged' : 'fresh',
        revSharePct: c.revSharePct,
        cplRate: c.cplRate == null ? null : c.cplRate,
        lastLead: c.lastLead,
        subids: []
      };
    });

    /* ---- leads ---- */
    var bandKeys = ds.assetBands.map(function (b) { return b.key; });
    var campById = {};
    campaigns.forEach(function (c) { campById[c.id] = c; });

    var leads = ds.leads.map(function (row) {
      var cid = row[f.campaign] >= 0 ? ds.campaigns[row[f.campaign]].cid : '';
      var camp = campById[cid];
      var recv = dayToDate(row[f.recv]);
      var soldOn = dayToDate(row[f.soldOn]);
      var st = row[f.soldType] >= 0 ? ds.soldTypes[row[f.soldType]] : null;
      var paid = row[f.paid] === 1;
      var sub = row[f.subid] >= 0 ? ds.subids[row[f.subid]] : null;

      return {
        id: String(row[f.leadId]),
        receivedAt: recv,
        partnerId: ds.partners[row[f.partner]].id,
        comp: camp ? camp.comp : 'cpl',
        campaignId: cid,
        campaignName: camp ? camp.name : cid,
        campaignKind: camp ? camp.kind : 'fresh',
        product: camp ? camp.product : 'Annuity',
        subid: sub,
        subidLabel: sub || null,
        state: row[f.state] >= 0 ? ds.states[row[f.state]] : '',
        /* The export has no time component at all, so arrival window is
           genuinely unknown. null, never a fabricated bucket. */
        hourSegment: null,
        assetBand: row[f.assetBand] >= 0 ? bandKeys[row[f.assetBand]] : null,
        status: paid ? 'paid' : 'free',
        rejectReason: row[f.reject] >= 0 ? ds.rejects[row[f.reject]] : null,
        /* The EXACT string the system recorded — what the lead table shows.
           null on the XML-payload rows (the one documented exception; the
           view falls back to the bucket's plain-language label) and on
           datasets generated before this field existed. */
        rejectReasonRaw: (f.rejectRaw !== undefined && row[f.rejectRaw] >= 0)
          ? ds.rejectsRaw[row[f.rejectRaw]] : null,
        soldType: st,
        soldAt: soldOn,
        daysToSale: (soldOn && recv) ? daysBetween(recv, soldOn) : null,
        saleAmount: row[f.revenueCents] / 100,
        partnerShare: row[f.shareCents] / 100,

        /* Internal-only. The export's Lead Cost is the $1 phantom COGS, so
           margin is not computable from it — left at 0 and reported as
           unavailable rather than rendered as a real number. */
        _leadCost: 0,
        _margin: 0,
        _buyerName: null,
        _csrName: null,
        _callResult: null,
        _ipqsScore: null,
        _unfired: row[f.returned] === 1,
        _badContact: false,
        _attempts: row[f.attempts]
      };
    });

    return { partners: partners, campaigns: campaigns, leads: leads };
  }

  var ALL_LEADS;
  if (DATASET && DATASET.leads && DATASET.leads.length) {
    var loaded = loadDataset(DATASET);
    PARTNERS = loaded.partners;
    CAMPAIGNS = loaded.campaigns;
    ALL_LEADS = loaded.leads;
    DATASET_NOTES = DATASET.notes;
    USING_REAL_DATA = true;

    CAMPAIGN_BY_ID = {};
    CAMPAIGNS.forEach(function (c) { CAMPAIGN_BY_ID[c.id] = c; });

    /* TODAY must follow the data, not the wall clock, or every window is
       empty. Pin it to the last day the export covers. */
    var dtParts = DATASET.notes.dateTo.split('-');
    TODAY = new Date(+dtParts[0], +dtParts[1] - 1, +dtParts[2]);

    /* Partner ids changed, so the legacy aliases point at the two accounts
       the old query strings meant. */
    var firstRev = null, firstCpl = null;
    Object.keys(PARTNERS).forEach(function (k) {
      var hasRev = CAMPAIGNS.some(function (c) { return c.partnerId === k && c.comp === 'revshare'; });
      if (hasRev && !firstRev) firstRev = k;
      if (!hasRev && !firstCpl) firstCpl = k;
    });
    PARTNER_ALIASES = {
      revshare: firstRev || Object.keys(PARTNERS)[0],
      cpl: firstCpl || Object.keys(PARTNERS)[0],
      ahg: Object.keys(PARTNERS)[0],
      opx: firstCpl || Object.keys(PARTNERS)[0]
    };
    DEFAULT_PARTNER = Object.keys(PARTNERS)[0];

    /* CPL targets have no home in the export — they're a planning decision,
       not a lead-level fact. Re-key the demo seed onto the largest CPL
       account so the feature demonstrates against real volume; every other
       partner correctly shows "not set". Revenue-share partners never get a
       seed — see the note above cplTargetsFor(). */
    REKEY_TARGETS = [firstRev, firstCpl];
  } else {
    ALL_LEADS = generate();
  }

  /* ====================================================================== */
  /* THE FIREWALL                                                           */
  /* ====================================================================== */

  /* ---- The column registry ---------------------------------------------
     ONE ENTRY PER AFFILIATE-VISIBLE COLUMN. Adding a column later means
     adding one object here and nothing else — the lead table, the CSV export
     and the admin screen all read this list.

       key        field on the lead row
       label      affiliate-facing header
       group      intake | outcome | revenue — groups the admin toggles
       comp       which comp models MAY see it. This is a hard constraint,
                  not a default: an admin cannot enable a column for a comp
                  model that is not listed here.
       locked     true = identity/audit column an admin may not switch off
       align      'num' right-aligns in the table
       csvOnly    exported but not rendered (keeps the table readable)

     A column that is forbidden to everyone is NOT in this registry at all.
     lead_cost, margin, buyer_name, csr_name, call_result, ipqs_score and
     campaign_cost are absent on purpose — absence is the enforcement. */
  var LEAD_COLUMNS = [
    { key: 'receivedAt',   label: 'Received',          group: 'intake',  comp: ['revshare', 'cpl'], locked: true },
    { key: 'id',           label: 'Lead ID',           group: 'intake',  comp: ['revshare', 'cpl'], locked: true },
    { key: 'campaignId',   label: 'CID',               group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'campaignName', label: 'Campaign',          group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'product',      label: 'Product',           group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'subid',        label: 'Sub-ID',            group: 'intake',  comp: ['revshare', 'cpl'], csvOnly: true },
    { key: 'subidLabel',   label: 'Sub-ID name',       group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'state',        label: 'State',             group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'assetBand',    label: 'Investable assets', group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'hourSegment',  label: 'Arrival window',    group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'dow',          label: 'Day received',      group: 'intake',  comp: ['revshare', 'cpl'] },
    { key: 'status',       label: 'Status',            group: 'intake',  comp: ['revshare', 'cpl'], locked: true },
    { key: 'rejectReason', label: 'Rejection reason',  group: 'intake',  comp: ['revshare', 'cpl'], locked: true },

    { key: 'soldType',     label: 'Sold type',         group: 'outcome', comp: ['revshare', 'cpl'] },
    { key: 'soldAt',       label: 'Date sold',         group: 'outcome', comp: ['revshare', 'cpl'] },
    { key: 'daysToSale',   label: 'Days to sale',      group: 'outcome', comp: ['revshare', 'cpl'], align: 'num' },

    { key: 'saleAmount',   label: 'Sale amount',       group: 'revenue', comp: ['revshare'], align: 'num' },
    { key: 'partnerShare', label: 'Your share',        group: 'revenue', comp: ['revshare'], align: 'num' }
  ];

  var COLUMN_BY_KEY = {};
  LEAD_COLUMNS.forEach(function (c) { COLUMN_BY_KEY[c.key] = c; });

  /* Columns in the `outcome` group are the ones withheld on a rejected row
     for a comp model that does not see rejected outcomes. */
  var OUTCOME_KEYS = LEAD_COLUMNS
    .filter(function (c) { return c.group === 'outcome'; })
    .map(function (c) { return c.key; });

  /* Derived columns are computed in the projection rather than stored. */
  var DERIVED = {
    dow: function (src) { return src.receivedAt.getDay(); }
  };

  /* ---- The admin setting -----------------------------------------------
     WHAT AN ADMIN SCREEN WRITES. Per comp model, the set of registry columns
     switched on for affiliates. NOT YET BUILT as a UI — see admin-preview.html
     for the shape and ADMIN-MAPPING.md for the storage.

     `enabled: null` means "everything the registry allows for this comp
     model". Listing keys explicitly narrows it. Locked columns are always on
     regardless of what is stored here. */
  var ADMIN_COLUMN_CONFIG = {
    revshare: { enabled: null },
    /* Day-received is switched off for CPL here purely to demonstrate that
       the toggle does something. It is not a visibility rule. */
    cpl: { enabled: LEAD_COLUMNS
             .filter(function (c) { return c.comp.indexOf('cpl') !== -1 && c.key !== 'dow'; })
             .map(function (c) { return c.key; }) }
  };

  /**
   * The columns an affiliate may see for a given comp model: registry
   * constraint AND admin setting, with locked columns forced on.
   */
  function columnsFor(compKey) {
    var cm = compModel(compKey);
    var cfg = ADMIN_COLUMN_CONFIG[cm.key] || { enabled: null };
    return LEAD_COLUMNS.filter(function (c) {
      if (c.comp.indexOf(cm.key) === -1) return false;          /* hard constraint */
      if (c.group === 'revenue' && !cm.seesRevenue) return false;
      if (c.locked) return true;                                 /* cannot be disabled */
      if (cfg.enabled === null) return true;
      return cfg.enabled.indexOf(c.key) !== -1;
    });
  }

  /** The union across every comp model a partner is currently running. */
  function columnsForPartner(partnerId) {
    var seen = {}, out = [];
    compsFor(partnerId).forEach(function (cm) {
      columnsFor(cm.key).forEach(function (c) {
        if (!seen[c.key]) { seen[c.key] = 1; out.push(c); }
      });
    });
    /* Keep registry order rather than discovery order. */
    return LEAD_COLUMNS.filter(function (c) { return seen[c.key]; });
  }

  /* Projection cache — resolved once per comp model, not per row. */
  var PROJECTION = {};
  function projectionFor(compKey) {
    var cm = compModel(compKey);
    if (!PROJECTION[cm.key]) {
      PROJECTION[cm.key] = columnsFor(cm.key).map(function (c) { return c.key; });
    }
    return PROJECTION[cm.key];
  }

  function queryLeads(opts) { return runQuery(opts, 'receivedAt'); }

  /**
   * The same projection, filtered on the date the lead SOLD.
   *
   * WHY BOTH EXIST — the most important modelling decision on the dashboard:
   *   Volume questions  ("what did I send, did it get accepted")
   *      → attribute to the RECEIVED date.
   *   Outcome questions ("what sold this week, what did I earn")
   *      → attribute to the SOLD date.
   * Leads take 9–12 days to cook, so attributing outcomes to the received
   * date makes every Today / Yesterday / Last-7-days view report zero sales.
   *
   * Conversion RATES are a third case and use neither: a rate needs a matured
   * cohort, so those run on the trailing 30 days with the maturity buffer —
   * the same basis the health score uses.
   */
  function queryLeadsBySold(opts) { return runQuery(opts, 'soldAt'); }

  function runQuery(opts, dateField) {
    opts = opts || {};
    var pid = resolvePartnerId(opts.partnerId);

    var from = opts.from || addDays(TODAY, -6);
    var to = opts.to || TODAY;
    var fromMs = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    var toMs = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime();

    var out = [];
    for (var i = 0; i < ALL_LEADS.length; i++) {
      var src = ALL_LEADS[i];
      if (src.partnerId !== pid) continue;
      var d = src[dateField];
      if (!d) continue;
      var t = d.getTime();
      if (t < fromMs || t > toMs) continue;
      if (opts.campaignId && opts.campaignId !== 'all' && src.campaignId !== opts.campaignId) continue;
      if (opts.subid && opts.subid !== 'all' && src.subid !== opts.subid) continue;

      /* ---- PER-ROW PROJECTION ------------------------------------------
         Resolved from THIS ROW's campaign, not from the account. A partner
         running both comp models gets revenue columns on their rev-share rows
         and no revenue field at all on their CPL rows, in one table. */
      var cm = compModel(src.comp);
      var cols = projectionFor(src.comp);

      /* ---- THE ROW RULE -------------------------------------------------
         For a CPL campaign a rejected lead dies at the door: the affiliate
         sees that it arrived and why it was declined, and nothing after that.

         Enforced here rather than in the view because it is not just about
         hiding a column — it changes which ROWS exist. A sold-date query must
         not return a rejected lead at all, or the row count alone would reveal
         that we work leads we declined. */
      var dropOutcome = !cm.seesRejectedOutcomes && src.status === 'free';
      if (dropOutcome && dateField === 'soldAt') continue;

      var row = {};
      for (var c = 0; c < cols.length; c++) {
        var k = cols[c];
        if (dropOutcome && OUTCOME_KEYS.indexOf(k) !== -1) continue;
        row[k] = DERIVED[k] ? DERIVED[k](src) : src[k];
      }
      /* Comp model travels with the row so the view can label a mixed table.
         It is a property of the campaign the affiliate already knows about,
         not a disclosure. */
      row.comp = src.comp;
      /* The exact system reject string rides with its bucket — same column,
         same visibility (intake, locked, both comp models), finer grain. */
      if ('rejectReason' in row) row.rejectReasonRaw = src.rejectReasonRaw || null;
      out.push(row);
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Date range presets                                                     */
  /* ---------------------------------------------------------------------- */

  var RANGES = {
    today:      { label: 'Today',        days: 0 },
    yesterday:  { label: 'Yesterday',    days: 1, offset: 1 },
    '7d':       { label: 'Last 7 days',  days: 6 },
    '14d':      { label: 'Last 14 days', days: 13 },
    '30d':      { label: 'Last 30 days', days: 29 },
    mtd:        { label: 'This month',   month: 0 },
    lastmonth:  { label: 'Last month',   month: 1 },
    custom:     { label: 'Custom range' }
  };

  function resolveRange(key, customFrom, customTo) {
    var from, to;
    if (key === 'today') { from = TODAY; to = TODAY; }
    else if (key === 'yesterday') { from = addDays(TODAY, -1); to = addDays(TODAY, -1); }
    else if (key === 'mtd') { from = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1); to = TODAY; }
    else if (key === 'lastmonth') {
      from = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1);
      to = new Date(TODAY.getFullYear(), TODAY.getMonth(), 0);
    }
    else if (key === 'custom' && customFrom && customTo) { from = customFrom; to = customTo; }
    else {
      /* Also catches 'custom' arriving without usable dates — that must land
         on a bounded window, not an unbounded one. */
      var cfg = RANGES[key];
      var d = (cfg && typeof cfg.days === 'number') ? cfg.days : 6;
      from = addDays(TODAY, -d); to = TODAY;
    }
    if (from > to) { var tmp = from; from = to; to = tmp; }
    return { key: key, from: from, to: to, label: RANGES[key] ? RANGES[key].label : 'Custom range' };
  }

  function priorWindow(range) {
    var span = daysBetween(range.from, range.to) + 1;
    return { from: addDays(range.from, -span), to: addDays(range.from, -1) };
  }

  /* ---------------------------------------------------------------------- */
  /* Metrics                                                                */
  /* ---------------------------------------------------------------------- */

  var MATURITY_DAYS = 10;

  function isMature(row, asOf) {
    return daysBetween(row.receivedAt, asOf || TODAY) >= MATURITY_DAYS;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * @param opts.rateBasis 'paid' | 'all' | 'mixed'
   *   'paid' (CPL) — of the leads we ACCEPTED and paid for, how many
   *      converted. The right question for a partner paid per accepted lead.
   *   'all' (RevShare) — of EVERY lead submitted. A revenue-share partner is
   *      paid on any sale, accepted or not, so dividing by accepted leads
   *      alone overstates conversion and undervalues the volume they send.
   *   'mixed' (both models on one account) — THE DENOMINATOR IS RESOLVED PER
   *      ROW from that row's campaign: matured leads on rev-share campaigns
   *      count whether accepted or not, matured leads on CPL campaigns count
   *      only when accepted. Neither account-level basis is right for a
   *      mixed book — 'all' would drag the CPL campaigns' rates down by
   *      their own rejects, 'paid' would understate the rev-share volume.
   *      Same per-row principle as the column projection.
   */
  function computeMetrics(rows, asOf, opts) {
    asOf = asOf || TODAY;
    var basis = (opts && opts.rateBasis);
    if (basis !== 'all' && basis !== 'mixed') basis = 'paid';
    var mixedDenom = 0;

    var raw = rows.length;
    var paid = 0, free = 0, mature = 0, maturePaid = 0, immaturePaid = 0;
    var rejectedSold = 0, rejectedSoldPH = 0, rejectedEarnings = 0;
    var byType = { priority: 0, hot: 0, auction: 0, marketplace: 0, appointment: 0, livetransfer: 0 };
    var cycles = [], rejects = {}, salePrices = [];
    var earnings = 0, saleTotal = 0, hasEarnings = false;
    var byBand = {}, bySegment = {}, byState = {}, byDow = {}, byPhase = {};
    var idealWindowLeads = 0;
    var sameDaySold = 0;

    function bucket(map, key) {
      if (!map[key]) map[key] = { raw: 0, paid: 0, mature: 0, ph: 0, earnings: 0 };
      return map[key];
    }

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var matured = isMature(r, asOf);
      var isPH = r.soldType === 'priority' || r.soldType === 'hot';

      if (r.status === 'paid') {
        paid++;
        if (matured) maturePaid++; else immaturePaid++;
      } else {
        free++;
        if (r.rejectReason) rejects[r.rejectReason] = (rejects[r.rejectReason] || 0) + 1;
      }
      if (matured) mature++;

      /* Mixed basis: this row counts toward the rate denominator on its own
         campaign's terms — rev share on any matured lead, CPL on matured
         accepted only. Resolved from the campaign record, mirroring the
         per-row column projection. */
      if (basis === 'mixed' && matured) {
        var mc = CAMPAIGN_BY_ID[r.campaignId];
        if (mc && mc.comp === 'revshare') mixedDenom++;
        else if (r.status === 'paid') mixedDenom++;
      }

      if (r.soldType && byType[r.soldType] !== undefined) byType[r.soldType]++;

      if (r.soldType && r.status === 'free') {
        rejectedSold++;
        if (isPH) rejectedSoldPH++;
        rejectedEarnings += r.partnerShare || 0;
      }

      if (r.daysToSale != null) {
        cycles.push(r.daysToSale);
        /* Sold on the day it arrived. Counted on the LEAD, not on the sale
           date — this is a property of the lead's own journey, so it belongs
           on the same received-date basis as everything else in this block. */
        if (r.daysToSale === 0) sameDaySold++;
      }
      if (r.saleAmount) salePrices.push(r.saleAmount);

      if (r.partnerShare !== undefined) {
        hasEarnings = true;
        earnings += r.partnerShare || 0;
        saleTotal += r.saleAmount || 0;
      }

      if (isIdealSegment(r.hourSegment)) idealWindowLeads++;

      /* Breakdowns the affiliate can act on. */
      var bBand = bucket(byBand, r.assetBand);
      var bSeg = bucket(bySegment, r.hourSegment);
      var bSt = bucket(byState, r.state);
      var bDow = bucket(byDow, r.receivedAt.getDay());
      var bPh = bucket(byPhase, monthPhase(r.receivedAt));
      [bBand, bSeg, bSt, bDow, bPh].forEach(function (b) {
        b.raw++;
        if (r.status === 'paid') b.paid++;
        if (matured) b.mature++;
        if (isPH) b.ph++;
        b.earnings += r.partnerShare || 0;
      });
    }

    var soldPH = byType.priority + byType.hot;
    var soldNewTiers = byType.appointment + byType.livetransfer;
    var soldAny = soldPH + soldNewTiers + byType.auction + byType.marketplace;

    var rateDenom = basis === 'all' ? mature : basis === 'mixed' ? mixedDenom : maturePaid;
    var phRate = rateDenom ? soldPH / rateDenom : 0;

    var points = 0;
    Object.keys(byType).forEach(function (k) {
      points += byType[k] * SOLD_TYPES[k].points;
    });

    return {
      raw: raw, paid: paid, free: free,
      acceptanceRate: raw ? paid / raw : 0,
      mature: mature, maturePaid: maturePaid, immaturePaid: immaturePaid,

      priority: byType.priority, hot: byType.hot,
      auction: byType.auction, marketplace: byType.marketplace,
      appointment: byType.appointment, livetransfer: byType.livetransfer,
      byType: byType,

      soldPriorityHot: soldPH,
      soldNewTiers: soldNewTiers,
      soldAny: soldAny,
      priorityHotRate: phRate,
      rateBasis: basis,
      rateDenominator: rateDenom,
      sellThrough: maturePaid ? soldAny / maturePaid : 0,
      pointsPerPaid: maturePaid ? points / maturePaid : 0,

      rejectedSold: rejectedSold,
      rejectedSoldPriorityHot: rejectedSoldPH,
      rejectedEarnings: round2(rejectedEarnings),

      medianCycle: median(cycles),
      /* SAME-DAY CONVERSION. Denominator is the SAME rate denominator every
         other conversion rate on this object uses, so it sits beside
         Priority/Hot conversion and Sold rate without a footnote — see the
         rateBasis doc above. Not "of everything that sold": that would make
         it a restatement of median sales cycle rather than a conversion
         measure, and it is filed under Conversion & value for a reason. */
      sameDaySold: sameDaySold,
      sameDayRate: rateDenom ? sameDaySold / rateDenom : 0,
      avgSalePrice: salePrices.length ? round2(salePrices.reduce(function (a, b) { return a + b; }, 0) / salePrices.length) : null,
      rejects: rejects,

      hasEarnings: hasEarnings,
      earnings: round2(earnings),
      saleTotal: round2(saleTotal),

      idealWindowLeads: idealWindowLeads,
      idealWindowShare: raw ? idealWindowLeads / raw : 0,

      byBand: byBand, bySegment: bySegment, byState: byState, byDow: byDow,
      byPhase: byPhase
    };
  }

  /**
   * Actual share of volume by day of week against IDEAL_DOW_SPLIT.
   * Returns one row per day, ideal order Monday-first.
   */
  function dowSplit(rows) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < rows.length; i++) counts[rows[i].receivedAt.getDay()]++;
    var total = rows.length || 1;
    var order = [1, 2, 3, 4, 5, 6, 0];              /* Monday → Sunday */
    return order.map(function (d) {
      var actual = counts[d] / total;
      return {
        dow: d,
        label: DOW_LABEL[d],
        short: DOW_SHORT[d],
        leads: counts[d],
        actual: actual,
        ideal: IDEAL_DOW_SPLIT[d],
        delta: actual - IDEAL_DOW_SPLIT[d]
      };
    });
  }

  /** Actual share of volume by arrival window, flagged against the ideal two. */
  function windowSplit(rows) {
    var counts = {};
    HOUR_SEGMENT_ORDER.forEach(function (s) { counts[s] = 0; });
    for (var i = 0; i < rows.length; i++) {
      if (counts[rows[i].hourSegment] !== undefined) counts[rows[i].hourSegment]++;
    }
    var total = rows.length || 1;
    return HOUR_SEGMENT_ORDER.map(function (s) {
      return {
        seg: s,
        label: HOUR_SEGMENT_LABEL[s],
        leads: counts[s],
        share: counts[s] / total,
        ideal: isIdealSegment(s)
      };
    });
  }

  function dailySeries(rows, range, dateField) {
    dateField = dateField || 'receivedAt';
    var byDay = {}, days = [];
    var cursor = new Date(range.from.getTime());
    while (cursor <= range.to) {
      var k = dayKey(cursor);
      byDay[k] = { key: k, date: new Date(cursor.getTime()), raw: 0, paid: 0, free: 0, priority: 0, hot: 0 };
      days.push(byDay[k]);
      cursor = addDays(cursor, 1);
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r[dateField]) continue;
      var d = byDay[dayKey(r[dateField])];
      if (!d) continue;
      d.raw++;
      if (r.status === 'paid') d.paid++; else d.free++;
      if (r.soldType === 'priority') d.priority++;
      else if (r.soldType === 'hot') d.hot++;
    }
    return days;
  }

  function cohort(opts) {
    var range = { from: addDays(TODAY, -29), to: TODAY };
    var rows = queryLeads({
      partnerId: opts.partnerId,
      from: range.from, to: range.to,
      campaignId: opts.campaignId, subid: opts.subid
    });
    return {
      range: range, rows: rows,
      metrics: computeMetrics(rows, TODAY, { rateBasis: opts.rateBasis })
    };
  }

  function groupBy(rows, keyFn, opts) {
    var buckets = {};
    for (var i = 0; i < rows.length; i++) {
      var k = keyFn(rows[i]);
      (buckets[k] = buckets[k] || []).push(rows[i]);
    }
    return Object.keys(buckets).map(function (k) {
      return { key: k, rows: buckets[k], metrics: computeMetrics(buckets[k], null, opts) };
    });
  }

  /** The rate basis a partner's headline figures should use. */
  function rateBasisFor(partnerId) {
    var comps = compsFor(partnerId);
    var hasAll = false, hasPaid = false;
    for (var i = 0; i < comps.length; i++) {
      if (comps[i].rateBasis === 'all') hasAll = true;
      else hasPaid = true;
    }
    /* Both models on one account → neither account-level basis is honest.
       'all' would drag the CPL campaigns down by their own rejects; 'paid'
       would understate the rev-share volume. 'mixed' resolves the
       denominator per row — see computeMetrics. */
    if (hasAll && hasPaid) return 'mixed';
    return hasAll ? 'all' : 'paid';
  }

  /* ---------------------------------------------------------------------- */
  /* Spend & volume targets                                                 */
  /* ---------------------------------------------------------------------- */

  /* ==========================================================================
     SPEND & VOLUME TARGETS — CPL ONLY
     --------------------------------------------------------------------------
     Confirmed by Logan, Aug 2026: revenue-share partners get NO volume or
     spend target. They can send as much or as little as they want — more is
     generally better, but nothing here governs them. Their only governance
     mechanism is the lead health score, which already exists. Every function
     below returns null immediately for a revenue-share partner, on purpose,
     rather than silently computing a number nobody asked for.

     For a CPL partner, margin and CPL are THE SAME LEVER expressed two ways:

         margin = (R − CPL) / R          CPL = R × (1 − margin)

     where R is our expected revenue per ACCEPTED lead — a historical,
     internal-only figure (revenuePerAcceptedLead(), below). Admin sets EITHER
     a target margin OR a target CPL and the other is derived; whichever field
     was last touched is the one treated as the source of truth going forward.
     R itself is never shown to the affiliate — only the CPL, volume and spend
     that fall out of it, same as target margin never is.

     Volume and spend are the second either/or pair, linked by the derived
     CPL: Spend = Volume × CPL. Volume is defined in ACCEPTED leads, matching
     how CPL is actually invoiced — not raw submitted, which would need a
     separate acceptance-rate assumption this design deliberately avoids.

     Targets are WEEKLY (Sunday–Saturday), matching the real Friday-night
     budget-distribution cadence, not calendar months. The daily figure used
     for the "Leads by day" reference line is the weekly volume target times
     that day's share of a default day-of-week split — Sunday is 0% by
     default, so a Sunday's target is genuinely zero unless a partner's split
     is explicitly overridden.
     ========================================================================== */

  function isCplPartner(partnerId) {
    var pid = resolvePartnerId(partnerId);
    return compsFor(pid).some(function (c) { return !c.seesRevenue; });
  }

  /** Whether every lead the current scope counts is on a CPL campaign.
      The per-day target ticks on the volume chart compare the target
      against the chart's own accepted counts, so on a MIXED account the
      ticks only render when the scope is pure CPL — either filtered to a
      CPL campaign, or an account with no rev-share campaigns at all. The
      weekly-target card does not need this gate: cplWeeklyProgress()
      filters its own counts to CPL campaigns. */
  function cplScopeIsPure(partnerId, campaignId) {
    var pid = resolvePartnerId(partnerId);
    if (campaignId && campaignId !== 'all') {
      var c = campaignById(campaignId);
      return !!c && c.comp !== 'revshare';
    }
    return campaignsFor(pid).every(function (c) { return c.comp !== 'revshare'; });
  }

  /* Sunday-start week containing `d`, at local midnight. */
  function startOfWeek(d) {
    return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay());
  }

  function weekLabel(sunday) {
    /* Always carries month on BOTH ends — "Week of Aug 2–Aug 8, 2026" rather
       than trying to omit the repeated month for a same-month week. That
       shorter form needs an Intl.DateTimeFormat call with only {day,year}
       and no {month}, which is a combination some engines format oddly
       (seen rendering literal field names instead of a date). Simpler and
       unambiguous beats slightly shorter. */
    var sat = addDays(sunday, 6);
    var f = sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    var t = sat.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return 'Week of ' + f + '–' + t + ', ' + sat.getFullYear();
  }

  function currentWeek() {
    var start = startOfWeek(TODAY);
    var end = addDays(start, 6);
    var elapsed = Math.min(7, daysBetween(start, TODAY) + 1);
    return {
      start: start, end: end, to: TODAY < end ? TODAY : end,
      daysElapsed: elapsed, daysInWeek: 7, daysLeft: Math.max(0, 7 - elapsed)
    };
  }

  /* Day-of-week share of the week's volume. Index matches Date#getDay() — 0
     is Sunday — which is exactly how IDEAL_DOW_SPLIT is already laid out, so
     the company default and the target engine can never disagree about which
     index means Sunday. Per-partner overrides persist to sessionStorage; in
     production this is a stored column on partner_targets, not a fallback
     table nobody can change — see ADMIN-MAPPING.md §4. */
  function dowWeightsFor(partnerId) {
    var pid = resolvePartnerId(partnerId);
    try {
      var raw = sessionStorage.getItem('fz_dow_' + pid);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return IDEAL_DOW_SPLIT.slice();
  }
  function saveDowWeights(partnerId, weights) {
    try { sessionStorage.setItem('fz_dow_' + resolvePartnerId(partnerId), JSON.stringify(weights)); } catch (e) {}
  }

  /**
   * INTERNAL ONLY — never returned from queryLeads(), never rendered to an
   * affiliate. Our expected revenue per ACCEPTED lead, trailing `lookbackDays`
   * (default 90), matured only (see MATURITY_DAYS — an unsold lead still
   * inside its cook window is not evidence of anything yet). Reads ALL_LEADS
   * directly rather than the redacted projection, the same pattern
   * _internalAggregates() uses and for the same reason: this number touches
   * our margin, which must never reach the affiliate side of the query layer.
   *
   * Deliberately does NOT depend on Lead Cost, so the $1 phantom COGS problem
   * (see ADMIN-MAPPING §6) does not corrupt it — it only sums saleAmount,
   * which is trustworthy.
   */
  function revenuePerAcceptedLead(opts) {
    opts = opts || {};
    var pid = resolvePartnerId(opts.partnerId);
    var from = addDays(TODAY, -(opts.lookbackDays || 90));
    var revenue = 0, matured = 0;
    for (var i = 0; i < ALL_LEADS.length; i++) {
      var l = ALL_LEADS[i];
      if (l.partnerId !== pid || l.status !== 'paid') continue;
      if (l.comp === 'revshare') continue;               /* R is a CPL-economics concept */
      if (opts.campaignId && opts.campaignId !== 'all' && l.campaignId !== opts.campaignId) continue;
      if (l.receivedAt < from) continue;
      if (!isMature(l, TODAY)) continue;
      matured++;
      revenue += l.saleAmount || 0;
    }
    var MIN_SAMPLE = 20;
    return {
      matured: matured,
      revenue: round2(revenue),
      revenuePerLead: matured ? round2(revenue / matured) : null,
      usable: matured >= MIN_SAMPLE
    };
  }

  /* The margin↔CPL and volume↔spend math, as pure functions so the admin
     mock, the engine and (eventually) real form handlers all call the same
     arithmetic and cannot drift apart. */
  function cplFromMargin(revenuePerLead, marginPct) {
    if (revenuePerLead == null || marginPct == null) return null;
    return round2(revenuePerLead * (1 - marginPct));
  }
  function marginFromCpl(revenuePerLead, cpl) {
    if (!revenuePerLead || cpl == null) return null;
    return Math.round((1 - (cpl / revenuePerLead)) * 1000) / 1000;
  }
  function spendFromVolume(volume, cpl) {
    return (volume != null && cpl != null) ? round2(volume * cpl) : null;
  }
  function volumeFromSpend(spend, cpl) {
    return (spend != null && cpl) ? Math.round(spend / cpl) : null;
  }

  function targetStoreKey(partnerId, campaignId) {
    return 'fz_cpltarget_' + resolvePartnerId(partnerId) + '_' + (campaignId || 'all');
  }
  function blankCplTarget() {
    return { marginPct: null, targetCpl: null, volume: null, spend: null, revenuePerLeadOverride: null };
  }

  /**
   * The stored target record for a partner (optionally scoped to one
   * campaign), merged with the live-computed R. `campaignId` is optional —
   * targets are account-wide by default, per Logan's "input the volume
   * target for an affiliate" framing; per-campaign is the same storage shape
   * with campaignId set, left for a later build rather than a full picker
   * in this mock.
   */
  function cplTargetsFor(partnerId, campaignId) {
    var pid = resolvePartnerId(partnerId);
    var rec = blankCplTarget();
    try {
      var raw = sessionStorage.getItem(targetStoreKey(pid, campaignId));
      if (raw) rec = JSON.parse(raw);
    } catch (e) {}

    var rpl = revenuePerAcceptedLead({ partnerId: pid, campaignId: campaignId });
    var effectiveR = rec.revenuePerLeadOverride != null ? rec.revenuePerLeadOverride : rpl.revenuePerLead;

    return {
      partnerId: pid, campaignId: campaignId || 'all',
      marginPct: rec.marginPct, targetCpl: rec.targetCpl,
      volume: rec.volume, spend: rec.spend,
      revenuePerLead: effectiveR,
      revenuePerLeadAuto: rpl.revenuePerLead,
      revenuePerLeadOverride: rec.revenuePerLeadOverride,
      revenuePerLeadUsable: rpl.usable,
      maturedSample: rpl.matured,
      isSet: rec.volume != null || rec.spend != null
    };
  }

  /**
   * Write one field of a target and derive its paired field. `changedField`
   * is whichever input the admin just edited — that is the source of truth;
   * the other half of its pair is recomputed from it, never the reverse,
   * which is what makes the either/or behaviour well-defined instead of a
   * fight over which stale number wins.
   *
   *   changedField 'marginPct' or 'targetCpl'  → recomputes the other of that pair
   *   changedField 'volume' or 'spend'         → recomputes the other of that pair,
   *                                               using whatever targetCpl is on file
   */
  function saveCplTarget(partnerId, campaignId, patch, changedField) {
    var pid = resolvePartnerId(partnerId);
    var current = cplTargetsFor(pid, campaignId);
    var rec = {
      marginPct: current.marginPct, targetCpl: current.targetCpl,
      volume: current.volume, spend: current.spend,
      revenuePerLeadOverride: current.revenuePerLeadOverride
    };
    for (var k in patch) rec[k] = patch[k];

    var R = rec.revenuePerLeadOverride != null ? rec.revenuePerLeadOverride : current.revenuePerLeadAuto;

    if (changedField === 'marginPct') rec.targetCpl = cplFromMargin(R, rec.marginPct);
    else if (changedField === 'targetCpl') rec.marginPct = marginFromCpl(R, rec.targetCpl);

    if (changedField === 'volume') rec.spend = spendFromVolume(rec.volume, rec.targetCpl);
    else if (changedField === 'spend') rec.volume = volumeFromSpend(rec.spend, rec.targetCpl);

    try { sessionStorage.setItem(targetStoreKey(pid, campaignId), JSON.stringify(rec)); } catch (e) {}
    return cplTargetsFor(pid, campaignId);
  }

  /**
   * This week's pace against target — the CPL replacement for the old
   * monthly targetProgress(). Returns null for a revenue-share partner
   * (always) or a CPL partner with nothing configured (correctly — a null
   * target must not render, not render as zero).
   */
  function cplWeeklyProgress(opts) {
    opts = opts || {};
    var pid = resolvePartnerId(opts.partnerId);
    if (!isCplPartner(pid)) return null;

    var t = cplTargetsFor(pid, opts.campaignId);
    if (!t.isSet) return null;

    var wk = currentWeek();
    var rows = queryLeads({ partnerId: pid, campaignId: opts.campaignId, from: wk.start, to: wk.to });
    /* MIXED-ACCOUNT RULE: the target is a CPL construct, so only leads on
       CPL campaigns count toward it. Unscoped on a mixed account, the query
       above returns rev-share rows too — a rev-share lead must never make a
       CPL volume target look on-pace. */
    var cplIds = {};
    campaignsFor(pid).forEach(function (c) { if (c.comp !== 'revshare') cplIds[c.id] = 1; });
    rows = rows.filter(function (r) { return cplIds[r.campaignId]; });
    var acceptedActual = computeMetrics(rows, TODAY, { rateBasis: 'paid' }).paid;
    var spendActual = t.targetCpl != null ? round2(acceptedActual * t.targetCpl) : null;

    function pace(actual, target) {
      if (target == null) return null;
      var expected = target * (wk.daysElapsed / wk.daysInWeek);
      var ratio = expected ? actual / expected : 1;
      return {
        target: target, actual: actual, pct: target ? actual / target : 0,
        expected: expected, ratio: ratio, aheadBy: actual - expected,
        onPace: ratio >= 0.97,
        severity: ratio >= 0.97 ? '' : ratio >= 0.85 ? 'is-warning'
                : ratio >= 0.70 ? 'is-serious' : 'is-critical',
        perDayNeeded: wk.daysLeft > 0 ? Math.max(0, (target - actual) / wk.daysLeft) : 0
      };
    }

    return {
      weekLabel: weekLabel(wk.start), daysElapsed: wk.daysElapsed, daysInWeek: 7, daysLeft: wk.daysLeft,
      targetCpl: t.targetCpl,
      volume: pace(acceptedActual, t.volume),
      spend: (t.spend == null || spendActual == null) ? null : pace(spendActual, t.spend)
    };
  }

  /**
   * The reference value for one calendar day on the "Leads by day" chart —
   * this week's ACCEPTED-lead volume target times that day's share of the
   * day-of-week split. null for revenue share (always) and for CPL partners
   * with no volume target set. Applies the CURRENT week's target to every
   * day shown, including past weeks in a longer date range — target history
   * / versioning is a further need, not built into this mock.
   */
  function dailyCplTarget(partnerId, date, campaignId) {
    var pid = resolvePartnerId(partnerId);
    if (!isCplPartner(pid)) return null;
    var t = cplTargetsFor(pid, campaignId);
    if (t.volume == null) return null;
    var weights = dowWeightsFor(pid);
    return t.volume * (weights[date.getDay()] || 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Duplicate self-check                                                   */
  /* ---------------------------------------------------------------------- */

  /* checkDuplicate() and the bulk screening companion were removed Aug 19.
     They implemented a single-number lookup endpoint that does not exist and
     is not planned — see the suppression-file block below. Recoverable from
     git history if that changes. */


  function formatPhone(d) {
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }

  /* NOTE — a test-lead sandbox lived here briefly (Aug 6–7 2026) and was
     removed on Logan's call: checking a hand-typed lead against acceptance
     criteria is not something affiliates need. The affiliate-facing pixel
     verification now lives inside the campaign setup flow (the "Send a test
     lead" step on campaign-setup.html). */

  /* ======================================================================
     CAMPAIGN SETUP FLOW  (campaign-setup.html)
     ----------------------------------------------------------------------
     Onboarding steps 6–10 as a per-campaign tracker. Steps 1–5 (traffic
     type, comp model, integration method, agreement, campaign IDs) happen
     in conversation with Logan BEFORE the affiliate has portal access, so
     the portal only ever REFLECTS those decisions — the tracker starts at
     "complete setup for your integration method".

     THE ONE AFFILIATE-EDITABLE FIELD IN THE ENTIRE FLOW is the conversion
     pixel URL (landing-page campaigns). Everything else is a status, a
     link, or an instruction. CPL, comp model, targets and every other
     commercial term are read-only facts agreed with Logan.

     Each step carries an OWNER ('you' = the affiliate, 'us' = Financialize)
     and a STATE ('done' | 'action' | 'waiting' | 'todo'). The UX rule: a
     partner glancing at the tracker must know whose court the ball is in.

     Sources: Affiliate Onboarding V7.16.26, Landing Page & Pixel Setup
     Guide V7.14.26, Lead Submission API V5.22.26, Life Lead POST API.
     Storage spec: ADMIN-MAPPING §7d. */

  var COMPLIANCE_CONTACT = {
    name: 'Jefanie Genilla',
    email: 'jgenilla@financialize.com',
    role: 'Compliance review'
  };

  /* ---------------------------------------------------------------------- */
  /* Compliance inputs for the health score                                  */
  /* ---------------------------------------------------------------------- */
  /* STANDS IN FOR THE COMPLIANCE SYSTEM THE TECH TEAM IS BUILDING — see
     ADMIN-MAPPING §6a for the spec. Four inputs, all per affiliate:

       consentPct       — % of posts carrying a TrustedForm/Jornaya cert
       incidents        — complaint log entries, trailing 90 days:
                          { type, severity: 'critical'|'minor', date,
                            campaignId, resolved }
       creativesCurrent — is the running creative set on file with Jefanie?
       unsubOk          — email traffic: opt-out links live and correct?

     null means NOT YET COLLECTED. The engine parks a null input and
     renormalises — it never scores a gap as zero — and the gate (score cap
     at 45) only arms once real values exist. Everything here is null in the
     mock ON PURPOSE: these are real affiliate names, and fabricating a TCPA
     incident against one in a reviewable prototype is not acceptable. The
     gate code path is exercised by unit inspection instead. */
  function complianceFor(partnerId) {
    return {
      consentPct: null,
      incidents: null,
      creativesCurrent: null,
      unsubOk: null
    };
  }

  /* Test-lead conventions — system values, not suggestions. The test ZIP
     routes the lead down the test path, and dev_test as the first name is
     how the team spots test rows in the lead table. */
  var TEST_LEAD = {
    zip: '99996',
    firstName: 'dev_test',
    note: 'Unique email address and phone number on every test — repeats are rejected as duplicates.'
  };

  /* Tracking-URL parameters the tracking system accepts, from the LP &
     Pixel guide's variable list. THE KEY LIST BELONGS TO THE TRACKING
     SYSTEM: the admin's Tracking URL generator selects from the same set,
     and this constant must be replaced by that source (ADMIN-MAPPING §7d)
     so the portal can never offer a key the system would drop. */
  var TRACKING_PARAMS = [
    { group: 'Sub-tracking', keys: ['subid', 'subid2', 'subid3', 'subid4', 'subid5', 'xaffid', 'xsubid', 'transid'] },
    { group: 'UTM', keys: ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] },
    { group: 'Click IDs', keys: ['gclid', 'fbclid', 'msclkid', 'click_id', 'transaction_id'] },
    { group: 'Referrer & source', keys: ['referrer', 'source_affiliate', 'first_touch_timestamp'] },
    { group: 'Consent & verification', keys: ['phone_opt_in', 'tcpa_opt_in', 'opt_in_timestamp', 'xxTrustedFormCertUrl'] }
  ];

  /* Global per product line; the campaign's CID is substituted in. The
     &email= variant takes the subscriber address via a merge field. */
  var UNSUB_LINKS = {
    annuity: 'https://lead.annuities.net/email-unsubscribe.php/?cid={cid}',
    life: 'https://lead.lifepolicyexpress.com/email-unsubscribe.php?cid={cid}'
  };

  /* The two products post to DIFFERENT endpoints with different required
     fields. The summary here is orientation only — the linked doc is the
     spec, and the portal must never let the two drift. */
  var API_SPECS = {
    annuity: {
      endpoint: 'https://admin.financialize.com/api/lead_post.php',
      docKey: 'api_annuity',
      /* Every row is REQUIRED on every post — from Lead Submission API
         V5.22.26. The linked doc is the spec; this list must track it. */
      required: [
        { f: 'first_name', n: 'Lead’s first name' },
        { f: 'last_name', n: 'Lead’s last name' },
        { f: 'phone_day', n: 'Primary phone number' },
        { f: 'email', n: 'Email address' },
        { f: 'zip_code', n: 'ZIP code' },
        { f: 'age OR dob_y', n: 'One of the two — age in years, or 4-digit birth year. Not both required.' },
        { f: 'investment', n: 'Must match one of the nine documented options EXACTLY, character for character (e.g. "$50,000 - $100,000").' },
        { f: 'campaign_id', n: 'This campaign’s CID — shown in step 1.' },
        { f: 'response_format', n: '"json"' }
      ],
      note: 'The investment value must match one of the nine documented options exactly, ' +
        'character for character.'
    },
    life: {
      endpoint: 'https://admin.financialize.com/api/lead_post_life_insurance.php',
      docKey: 'api_life',
      /* From the Life Lead POST API doc. */
      required: [
        { f: 'first_name', n: 'Lead’s first name' },
        { f: 'last_name', n: 'Lead’s last name' },
        { f: 'email', n: 'Valid email address' },
        { f: 'phone_day', n: 'Daytime phone — must be 10 digits' },
        { f: 'zip_code', n: 'Must be 5 digits' },
        { f: 'age OR dob_y', n: 'One of the two — age in years, or 4-digit birth year (YYYY). Not both required.' },
        { f: 'health', n: 'One of: Excellent · Good · Average · Fair · Poor' },
        { f: 'reason_for_insurance', n: 'One of the seven documented options (e.g. "Mortgage Protection") — exact text' },
        { f: 'investment', n: 'Coverage range — one of the eight documented options, exact text' },
        { f: 'household_income', n: 'One of the five documented bands, exact text' },
        { f: 'nicotine_use', n: '"yes" or "no"' },
        { f: 'campaign_id', n: 'This campaign’s CID — shown in step 1.' },
        { f: 'aff_id', n: 'Your affiliate ID' },
        { f: 'response_format', n: 'Must be "json"' }
      ],
      note: 'health, reason_for_insurance, investment and household_income each take one of a ' +
        'fixed option list — see the doc for the exact strings.'
    }
  };

  /* ---- per-campaign setup facts -----------------------------------------
     integration method and traffic source are ADMIN FIELDS the export does
     not carry (ADMIN-MAPPING §7d). In the mock: traffic source is parsed
     off the campaign name where the name declares it; integration method is
     a deterministic stand-in so reviewers see both paths. */
  function trafficSourceFor(c) {
    if (/non-?email/i.test(c.name)) return 'nonemail';
    if (/email/i.test(c.name)) return 'email';
    return 'nonemail';
  }
  function integrationMethodFor(c) {
    if (c.method) return c.method;
    /* Mock assignment, stable per campaign. */
    var n = parseInt(String(c.id).replace(/\D/g, ''), 10) || 0;
    return (n % 2 === 0) ? 'lp' : 'api';
  }

  /* Synthetic in-setup campaigns so reviewers can walk the flow mid-stream.
     NOT in CAMPAIGNS: default queries, filters and metrics never see them.
     One LP path (Heritage — needs a pixel: rev share) and one API path
     (OptiLabX). Clearly fabricated; delete when real setup records exist. */
  var SETUP_CAMPAIGNS = [
    { id: '771', name: 'Heritage - Life [Non-email - Rev Share]', partnerId: 'annuityherit',
      comp: 'revshare', revSharePct: 0.4, product: 'Life', method: 'lp',
      active: false, inSetup: true },
    { id: '772', name: 'OptiLabX - Annuity [Email]', partnerId: 'optilabxmedi',
      comp: 'cpl', revSharePct: 0, product: 'Annuity', method: 'api',
      active: false, inSetup: true }
  ];

  function setupCampaignsFor(partnerId) {
    var pid = resolvePartnerId(partnerId);
    return SETUP_CAMPAIGNS.filter(function (c) { return c.partnerId === pid; });
  }
  function setupCampaign(partnerId, campaignId) {
    var all = setupCampaignsFor(partnerId).concat(campaignsFor(partnerId));
    return all.filter(function (c) { return String(c.id) === String(campaignId); })[0] || null;
  }

  /* ---- affiliate inputs & mock step persistence ------------------------- */
  function setupStore(pid, cid) { return 'fz_setup_' + pid + '_' + cid; }
  function setupState(partnerId, campaignId) {
    var pid = resolvePartnerId(partnerId);
    try { return JSON.parse(sessionStorage.getItem(setupStore(pid, campaignId))) || {}; }
    catch (e) { return {}; }
  }
  function saveSetupState(partnerId, campaignId, patch) {
    var pid = resolvePartnerId(partnerId);
    var s = setupState(pid, campaignId);
    for (var k in patch) s[k] = patch[k];
    try { sessionStorage.setItem(setupStore(pid, campaignId), JSON.stringify(s)); } catch (e) {}
    return s;
  }

  /**
   * The tracker. Returns { campaign, method, trafficSource, steps, complete,
   * current } where steps[i] = { key, label, owner, state, optional }.
   *
   * A LIVE campaign returns every step done — the tracker then reads as the
   * campaign's setup record (tracking link, pixel on file) rather than a
   * to-do list. In production every state except the pixel URL and the
   * creative send is admin-set; the mock lets buttons advance them so the
   * flow can be felt end to end.
   */
  function campaignSetup(partnerId, campaignId) {
    var pid = resolvePartnerId(partnerId);
    var c = setupCampaign(pid, campaignId);
    if (!c) return null;

    var method = integrationMethodFor(c);
    var live = !c.inSetup;
    var s = setupState(pid, c.id);
    var isRev = c.comp === 'revshare';

    var steps = [];
    steps.push({ key: 'tracking', owner: 'us',
      label: method === 'lp' ? 'Your campaign ID & tracking link' : 'Your campaign ID & API documentation',
      state: 'done' });

    if (method === 'lp') {
      /* CPL partners generally do not need a pixel on the LP path — the step
         is skippable for them, required for revenue share. */
      var pixelDone = live || !!s.pixelUrl || !!s.pixelSkipped;
      steps.push({ key: 'pixel', owner: 'you', optional: !isRev,
        label: 'Place your conversion pixel',
        state: pixelDone ? 'done' : 'action' });
    } else {
      steps.push({ key: 'integrate', owner: 'you',
        label: 'Build your API integration',
        state: (live || s.integrationReady) ? 'done' : 'action' });
    }

    /* Creatives are uploaded in the portal now, not emailed. The step
       mirrors the submission's own status so the tracker and the creatives
       card can never disagree: nothing uploaded is a to-do, uploaded is
       waiting on us, approved is done. */
    var cre = creativesFor(pid, c.id);
    steps.push({ key: 'creatives', owner: cre.status === 'pending' ? 'us' : 'you',
      /* The label follows the state. On a live campaign this section is not a
         task any more, it is where the approved set lives, and calling it
         "Upload your creatives for approval" there reads as unfinished work. */
      label: cre.status === 'approved' ? 'Creatives — approved'
           : cre.status === 'pending' ? 'Creatives — pending review'
           : 'Upload your creatives for approval',
      creatives: cre,
      state: (live || cre.status === 'approved') ? 'done'
           : cre.status === 'pending' ? 'waiting'
           : 'todo' });

    steps.push({ key: 'test', owner: 'both',
      label: 'Send a test lead',
      state: live ? 'done' : (s.testConfirmed ? 'done' : (s.testRequested ? 'waiting' : 'todo')) });

    steps.push({ key: 'live', owner: 'us', label: 'Go live',
      state: live ? 'done' : 'todo' });

    /* First not-done step becomes the current one; a 'todo' owned by the
       affiliate that is first in line is promoted to 'action'. */
    var current = null;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].state !== 'done') { current = steps[i]; break; }
    }
    if (current && current.state === 'todo' && current.owner !== 'us') current.state = 'action';

    return {
      campaign: c, method: method, live: live,
      trafficSource: c.trafficSource || trafficSourceFor(c),
      isRev: isRev,
      pixelUrl: s.pixelUrl || (live && method === 'lp' && isRev
        ? 'https://track.' + pid + '.example/postback?tid={transaction_id}&amt={sale_amount}&sub={xsubid}'
        : null),
      pixelSkipped: !!s.pixelSkipped,
      steps: steps,
      current: current,
      complete: !current,
      doneCount: steps.filter(function (st) { return st.state === 'done'; }).length
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Documents                                                              */
  /* ---------------------------------------------------------------------- */
  /* STANDS IN FOR AN ADMIN-MANAGED DOCUMENT LIBRARY. In production this is a
     table, not a constant — the team adds, retires and re-links documents
     without a deploy, so the Setup page renders whatever rows exist rather
     than a list typed into the page.

       scope 'global'  — same document for every affiliate.
       scope 'partner' — a DIFFERENT URL per affiliate. `agreement` is the
                         only one today: each partner's signed agreement is
                         its own Google Doc, so the admin pastes a URL on the
                         affiliate's record and it renders only for them.

     See ADMIN-MAPPING §7. */
  /* The real full-criteria document (Logan's). One constant, read by the
     Targeting page's "View full criteria" link and the document library, so
     the two can never point at different versions. */
  var CRITERIA_DOC_URL =
    'https://docs.google.com/document/d/1c5HDngeA34yM-7yh9zvah6Dl-sWuHOxP0hksgDhTfwA/edit?usp=sharing';

  /* Real document URLs (Logan's, Aug 2026). The campaign-setup tracker links
     the API docs by key and Targeting reads CRITERIA_DOC_URL, so this
     registry is the ONLY place a URL lives. */
  var DOCUMENTS = [
    { key: 'onboarding', label: 'Affiliate onboarding', scope: 'global', featured: true,
      desc: 'Start here. How to get set up, post leads and get paid.',
      url: 'https://docs.google.com/document/d/1hMyhV_2Lc6LSYFCw9MYrdK8yRqb0OUBrVjNLl3Ygt-Q/edit?usp=sharing' },
    { key: 'criteria', label: 'Lead criteria', scope: 'global',
      desc: 'The full accepted-lead criteria for every product.',
      url: CRITERIA_DOC_URL },
    { key: 'agreement', label: 'Your agreement', scope: 'partner',
      desc: 'Your signed partnership agreement and commercial terms.' },
    { key: 'api_annuity', label: 'Annuity API documentation', scope: 'global',
      desc: 'Endpoint, field spec and response codes for annuity posts.',
      url: 'https://docs.google.com/document/d/1-xFC8IwZYXUBlnvGixTatCNGB2-RPxxrizSxudu7ZnU/edit?usp=sharing' },
    { key: 'api_life', label: 'Life API documentation', scope: 'global',
      desc: 'Endpoint, field spec and response codes for life posts.',
      url: 'https://docs.google.com/document/d/1C7MgZ9FRjTHE6aU_Zw8F6YlI8npXEymu5JO6EqkNDsU/edit?usp=sharing' },
    /* Belongs to the LP integration path the way the API docs belong to the
       API path. */
    { key: 'landing_pages', label: 'Landing page instructions', scope: 'global',
      desc: 'Running traffic to our hosted landing pages: tracking links, pixels and sub-ID passthrough.',
      url: 'https://docs.google.com/document/d/1siIheEkgwsMGiMDW6x80QkVs-Dkpn9cFvojP2Q9teQ4/edit?usp=sharing' }
  ];

  /* Creative resources for the Targeting page. Admin-set URLs under the same
     rule as the document library: null means NOT LINKED YET and must render
     as such, never as a dead button. See ADMIN-MAPPING §7c. */
  /* ======================================================================
     CREATIVES — upload, approval, and the record it leaves
     ----------------------------------------------------------------------
     PROCESS CHANGE, Aug 19 (Logan with Michael). Creatives no longer travel
     by email. An affiliate uploads them through the portal, they sit
     PENDING until someone here reviews them, and then they read APPROVED.
     That applies twice over: when a campaign is being set up, and every time
     an affiliate wants to change what they are running.

     WHAT THE AFFILIATE IS TOLD: approval is a compliance review, and they
     cannot run a creative until it clears. That is true and it is the whole
     of the partner-facing story.

     WHAT THIS ALSO BUYS US, AND IS NOT PARTNER-FACING: a per-campaign record
     of which creatives were live and when, which is what lets us attribute a
     lead back to the creative that produced it. That is an internal
     analytics capability. It is specified in ADMIN-MAPPING and HANDOFF for
     the build; it must not be described on any partner screen, and no
     partner-facing copy may imply we retain or analyse their creative beyond
     the approval itself.

     THE UPLOAD IS THE BIGGEST NEW CONNECTION POINT IN THE PORTAL. Nothing
     here stores a file — `submitCreatives()` writes to sessionStorage so the
     three states can be walked through in review. Production needs real file
     storage, a review queue, and a status webhook. ADMIN-MAPPING §8.
     ====================================================================== */

  var CREATIVE_STATUS = {
    none:     { key: 'none',     label: 'None uploaded',   badge: 'badge' },
    pending:  { key: 'pending',  label: 'Pending review',  badge: 'badge-warn' },
    approved: { key: 'approved', label: 'Approved',        badge: 'badge-good' },
    changes:  { key: 'changes',  label: 'Changes needed',  badge: 'badge-crit' }
  };

  /* Per campaign, because approval is per campaign — a creative cleared for
     an annuity campaign is not automatically cleared for a life one. */
  function creativeKey(pid, campaignId) {
    return 'fz_creatives_' + pid + '_' + campaignId;
  }

  /**
   * What has been submitted for one campaign.
   * Returns { status, statusLabel, badge, files:[{name,size,uploadedAt}],
   *           submittedAt, reviewedAt, note }.
   *
   * NOT CONNECTED YET in production terms — see the header. The mock reads
   * sessionStorage so a reviewer can walk none -> pending -> approved.
   */
  function creativesFor(partnerId, campaignId) {
    var pid = resolvePartnerId(partnerId);
    var raw = null;
    try { raw = sessionStorage.getItem(creativeKey(pid, campaignId)); } catch (e) {}
    var st = raw ? JSON.parse(raw) : null;
    if (st && st.submittedAt) st.submittedAt = new Date(st.submittedAt);
    if (st && st.reviewedAt) st.reviewedAt = new Date(st.reviewedAt);
    var status = (st && st.status) || 'none';
    var cfg = CREATIVE_STATUS[status] || CREATIVE_STATUS.none;
    return {
      partnerId: pid,
      campaignId: campaignId,
      status: status,
      statusLabel: cfg.label,
      badge: cfg.badge,
      files: (st && st.files) || [],
      submittedAt: (st && st.submittedAt) || null,
      reviewedAt: (st && st.reviewedAt) || null,
      note: (st && st.note) || null
    };
  }

  /**
   * Record an upload. Always lands on PENDING — nothing an affiliate does
   * can approve their own creative, and the UI must never let it look
   * otherwise.
   * @param files [{name, size}]
   */
  function submitCreatives(partnerId, campaignId, files) {
    var pid = resolvePartnerId(partnerId);
    var now = new Date();
    var rec = {
      status: 'pending',
      submittedAt: now.toISOString(),
      reviewedAt: null,
      files: (files || []).map(function (f) {
        return { name: f.name, size: f.size, uploadedAt: now.toISOString() };
      })
    };
    try { sessionStorage.setItem(creativeKey(pid, campaignId), JSON.stringify(rec)); } catch (e) {}
    return creativesFor(pid, campaignId);
  }

  /* Review outcome. In production this is OUR side writing back — it is here
     only so the approved state can be demonstrated. */
  function _reviewCreatives(partnerId, campaignId, outcome, note) {
    var pid = resolvePartnerId(partnerId);
    var cur = creativesFor(pid, campaignId);
    if (cur.status === 'none') return cur;
    var rec = {
      status: outcome === 'approved' ? 'approved' : 'changes',
      submittedAt: cur.submittedAt ? cur.submittedAt.toISOString() : null,
      reviewedAt: new Date().toISOString(),
      files: cur.files,
      note: note || null
    };
    try { sessionStorage.setItem(creativeKey(pid, campaignId), JSON.stringify(rec)); } catch (e) {}
    return creativesFor(pid, campaignId);
  }

  /* Where "Give feedback" points. HARDCODED STAND-IN for an admin setting —
     null until the form exists, and the button says so rather than
     dead-ending. Set it to the form's URL and the button becomes a real link
     with no other change. ADMIN-MAPPING §9. */
  /* An OBJECT, not a bare string, so it is actually settable from outside.
     Exporting a scalar exports a copy — assigning to it changes nothing,
     because feedbackLink() closes over the module-local variable. Every other
     ADMIN_* stand-in in this file is an object for the same reason. */
  var ADMIN_FEEDBACK = { url: null };

  function feedbackLink() {
    return { url: ADMIN_FEEDBACK.url || null, connected: !!ADMIN_FEEDBACK.url };
  }

  var CREATIVE_LINKS = [
    { key: 'annuity_examples', label: 'See example annuity creatives', url: null },
    { key: 'life_examples', label: 'See example life creatives', url: null },
    { key: 'guidelines', label: 'Creative guidelines', url: null }
  ];

  /* Per-partner document URLs. sessionStorage stands in for the admin field;
     a missing URL renders as "not linked yet", never as a dead button. */
  function partnerDocUrl(partnerId, key) {
    var pid = resolvePartnerId(partnerId);
    try { return sessionStorage.getItem('fz_doc_' + pid + '_' + key) || null; }
    catch (e) { return null; }
  }
  function savePartnerDocUrl(partnerId, key, url) {
    var pid = resolvePartnerId(partnerId);
    try {
      if (url) sessionStorage.setItem('fz_doc_' + pid + '_' + key, url);
      else sessionStorage.removeItem('fz_doc_' + pid + '_' + key);
    } catch (e) {}
  }
  /** The document list as this partner sees it, per-partner URLs resolved. */
  function documentsFor(partnerId) {
    return DOCUMENTS.map(function (d) {
      var url = d.scope === 'partner' ? partnerDocUrl(partnerId, d.key) : d.url;
      return { key: d.key, label: d.label, desc: d.desc, scope: d.scope,
               featured: !!d.featured, url: url || null };
    });
  }

  /* ======================================================================
     SUPPRESSION FILE — one per affiliate, and that is all it is
     ----------------------------------------------------------------------
     REWRITTEN Aug 19 after Logan checked what actually runs. The earlier
     version of this module proposed a whole apparatus — a single-number
     lookup endpoint, a bulk screening tool, HMAC-SHA-256 digests under a
     per-affiliate key, a nightly rebuild, a published manifest. None of that
     exists and none of it is planned right now.

     WHAT IT ACTUALLY IS: a suppression file, one per affiliate, that helps
     them keep duplicates out of their own campaigns. That is the whole
     feature. It is a CONNECTION POINT — the file lives on the affiliate's
     record and this page surfaces it — so until that connection is wired
     there is nothing to show and the page says exactly that.

     DO NOT re-add format, cadence, hashing or record-count claims here
     unless someone has confirmed them against the file that really ships. It
     is easy to describe a file into existence and much harder to walk it
     back once a partner has read it.

     The 365-day Priority/Hot exclusivity window IS confirmed — it is a
     commercial term already on the partner record and in REJECT_REASONS — so
     that much can be stated plainly. */

  /* Per-affiliate file. HARDCODED STAND-IN FOR AN ADMIN FIELD: in production
     each affiliate's record carries the location of their own file. Absent or
     null means not connected yet, which is the state everyone is in today. */
  var ADMIN_SUPPRESSION_FILES = {
    /* Uncomment to preview the connected state:
       annuityherit: { url: 'https://example.com/file.csv',
                       updatedAt: new Date(2026, 7, 19), recordCount: 184203 } */
  };

  /**
   * This affiliate's suppression file, or the honest absence of one.
   * Everything is null until the field is connected — no invented row count,
   * no placeholder date, no sample download.
   */
  function suppressionFileFor(partnerId) {
    var pid = resolvePartnerId(partnerId);
    var cfg = ADMIN_SUPPRESSION_FILES[pid] || null;
    return {
      partnerId: pid,
      connected: !!(cfg && cfg.url),
      url: (cfg && cfg.url) || null,
      updatedAt: (cfg && cfg.updatedAt) || null,
      recordCount: (cfg && cfg.recordCount != null) ? cfg.recordCount : null,
      /* Confirmed commercial term, safe to state. */
      windowDays: 365
    };
  }

  /* ======================================================================
     COMPENSATION — earnings, statements, pixel unfires  /* ======================================================================
     COMPENSATION — earnings, statements, pixel unfires
     ----------------------------------------------------------------------
     Everything on the Compensation page. Three rules carried from the rest
     of the module:

       · Earnings are measured on the basis the invoice uses — rev-share on
         the SOLD date (including rejected-but-sold, per the Aug 5 2026
         ruling), CPL on the RECEIVED date. Same attribution split as
         targetProgress(); mixing the two is what makes a report look broken.
       · Unfire rows are built field-by-field from an allowlist, like
         runQuery(). The internal clawback_reason never leaves this module —
         affiliates see the RETURN_REASONS vocabulary only.
       · A statement with no URL renders "not linked yet", never a dead
         button — same rule as the per-partner documents.
     ====================================================================== */

  /**
   * What the affiliate earned inside a window, on their invoice basis:
   *
   *   rev-share rows → their share of every sale SOLD in the window,
   *     accepted or not (queryLeadsBySold — hiding rejected-but-sold sales
   *     understates what we owe and makes their invoice unreconcilable)
   *   CPL rows      → leads ACCEPTED in the window × that campaign's rate
   *     (we owe on acceptance, so the received date is the billing date)
   *
   * A mixed account gets both, summed, with a per-campaign breakdown. A CPL
   * campaign with no rate on file reports known:false rather than a
   * confident $0 — rate cards are a NEEDS BUILDING field, see ADMIN-MAPPING.
   */
  function payoutForWindow(opts) {
    opts = opts || {};
    var base = {
      partnerId: resolvePartnerId(opts.partnerId),
      from: opts.from, to: opts.to,
      campaignId: opts.campaignId, subid: opts.subid
    };
    var byCamp = {}, order = [];
    function entry(r, comp) {
      if (!byCamp[r.campaignId]) {
        byCamp[r.campaignId] = { campaignId: r.campaignId, name: r.campaignName,
                                 comp: comp, count: 0, amount: 0, unrated: 0 };
        order.push(r.campaignId);
      }
      return byCamp[r.campaignId];
    }

    queryLeadsBySold(base).forEach(function (r) {
      if (r.comp !== 'revshare' || !r.soldType) return;
      var e = entry(r, 'revshare');
      e.count++;
      e.amount += r.partnerShare || 0;
    });
    /* cplRaw counts EVERY lead received in the window on a RATED CPL
       campaign, accepted or not — the denominator of effective cost per
       lead, which is what a lead actually cost the affiliate to send (lower
       than the rate card, since rejected leads are free). Campaigns with no
       rate on file are excluded from BOTH sides of that division — a $0
       spend over a real denominator would understate the number — and
       reported in cplRawExcluded so the view can say so. */
    var cplRaw = 0, cplRawExcluded = 0;
    queryLeads(base).forEach(function (r) {
      if (r.comp === 'revshare') return;
      var camp = CAMPAIGN_BY_ID[r.campaignId];
      var rated = camp && camp.cplRate != null;
      if (rated) cplRaw++; else cplRawExcluded++;
      if (r.status !== 'paid') return;
      var e = entry(r, 'cpl');
      if (rated) { e.count++; e.amount += camp.cplRate; }
      else e.unrated++;
    });

    var total = 0, known = true, soldCount = 0, acceptedCount = 0, cplSpend = 0;
    var campaigns = order.map(function (cid) {
      var e = byCamp[cid];
      e.amount = round2(e.amount);
      e.known = !e.unrated;
      if (!e.known) known = false;
      total += e.amount;
      if (e.comp === 'revshare') soldCount += e.count;
      else { acceptedCount += e.count; cplSpend += e.amount; }
      return e;
    });
    return { total: round2(total), known: known, campaigns: campaigns,
             soldCount: soldCount, acceptedCount: acceptedCount,
             cplRaw: cplRaw, cplRawExcluded: cplRawExcluded, cplSpend: round2(cplSpend),
             effectiveCpl: (cplRaw && cplSpend) ? round2(cplSpend / cplRaw) : null };
  }

  /* Affiliate-safe vocabulary for a lead removed in audit. Deliberately
     DISJOINT from the internal clawback_reason field, which stays on the
     forbidden list with the rest of the how-we-work-leads internals. Nothing
     here may reference margin, buyers, or call outcomes. */
  var RETURN_REASONS = {
    criteria: {
      label: 'Outside criteria',
      desc: 'A weekly audit found this lead fell outside your campaign’s accepted-lead criteria, so it should not have been accepted. The charge has been removed.'
    },
    duplicate: {
      label: 'Duplicate found in audit',
      desc: 'The consumer matched an earlier record that was not caught at intake. You are never billed for duplicates.'
    },
    invalid_contact: {
      label: 'Invalid contact details',
      desc: 'The phone or email on this lead could not be validated as belonging to the consumer.'
    },
    consumer_request: {
      label: 'Consumer requested removal',
      desc: 'The consumer asked to be removed after the lead was accepted.'
    }
  };
  var RETURN_REASON_KEYS = ['criteria', 'duplicate', 'invalid_contact', 'consumer_request'];

  /* Deterministic derivations for the MOCK ONLY. They deliberately use the
     lead id rather than rnd() — an extra rnd() call mid-generation would
     shift the PRNG stream and change every number quoted in HANDOFF.md. */
  function idHash(id) {
    var h = 0, s = String(id);
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
    return h;
  }
  function auditMondayAfter(d) {
    var out = new Date(d.getTime());
    do { out.setDate(out.getDate() + 1); } while (out.getDay() !== 1);
    return out;
  }

  /**
   * The Pixel unfire report — leads unfired in audit, affiliate-safe.
   *
   * MEMBERSHIP COMES FROM THE UNFIRE RECORD ITSELF, nothing inferred. In the
   * live export that is the `returned` flag — and note its shape: unfiring
   * flips the lead's paid flag back off, so an unfired lead renders as
   * Rejected in the lead table with no visible trace of ever having been
   * billed. That silent disappearance is exactly the reconciliation gap this
   * report closes (Heritage alone carries 335 returned rows, none of them
   * sold — the flag is our audit's removal, not a buyer's return). The mock
   * generator sets the same flag on ~3.5% of sold accepted leads.
   *
   * Leak check: a row here says only "this lead was removed from billing".
   * No sold-derived field is projected, so a CPL partner learns nothing
   * about declined leads being worked — the row rule holds.
   *
   * The live export carries only the flag — no unfire date, reason, or
   * credited amount. Those fields are the unfire feed Sagar is connecting
   * (HANDOFF.md, gating dependencies); until then they render as absent, not
   * fabricated. The mock derives them so the page demonstrates: audits run
   * weekly, so the unfire date is the Monday after the sale.
   */
  function queryUnfires(opts) {
    opts = opts || {};
    var pid = resolvePartnerId(opts.partnerId);
    var from = opts.from || addDays(TODAY, -29);
    var to = opts.to || TODAY;
    var fromMs = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    var toMs = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime();

    var out = [];
    for (var i = 0; i < ALL_LEADS.length; i++) {
      var l = ALL_LEADS[i];
      if (l.partnerId !== pid || !l._unfired) continue;
      if (opts.campaignId && opts.campaignId !== 'all' && l.campaignId !== opts.campaignId) continue;

      var returnedAt = null, reason = null;
      if (!USING_REAL_DATA) {
        returnedAt = auditMondayAfter(l.soldAt || l.receivedAt);
        if (returnedAt > TODAY) continue;              /* not audited yet */
        reason = RETURN_REASON_KEYS[idHash(l.id) % RETURN_REASON_KEYS.length];
      }

      /* Window on the unfire date when we have one; the received date is the
         only anchor the live export offers until the feed lands. */
      var t = (returnedAt || l.receivedAt).getTime();
      if (t < fromMs || t > toMs) continue;

      var camp = CAMPAIGN_BY_ID[l.campaignId];
      var adj = l.comp === 'revshare'
        ? (l.partnerShare ? -l.partnerShare : null)
        : (camp && camp.cplRate != null ? -camp.cplRate : null);

      /* Field-by-field allowlist — nothing internal rides along. */
      out.push({
        id: l.id,
        receivedAt: l.receivedAt,
        campaignId: l.campaignId,
        campaignName: l.campaignName,
        comp: l.comp,
        returnedAt: returnedAt,
        reason: reason,
        adjustment: adj == null ? null : round2(adj)
      });
    }
    out.sort(function (a, b) {
      return (b.returnedAt || b.receivedAt) - (a.returnedAt || a.receivedAt);
    });
    return out;
  }

  /**
   * Monthly lead statements. Generated in Google Sheets on the first
   * business day after the month closes and LINKED BY THE ADMIN each month —
   * same per-partner-URL pattern as the agreement document. sessionStorage
   * stands in for the admin field; see ADMIN-MAPPING §7d.
   *
   * The mock links every closed month except the most recent, which renders
   * "Not linked yet" — that is the monthly admin step, shown as a state
   * rather than hidden.
   */
  function firstBusinessDayAfter(d) {
    var out = new Date(d.getTime());
    do { out.setDate(out.getDate() + 1); } while (out.getDay() === 0 || out.getDay() === 6);
    return out;
  }
  function statementUrl(partnerId, key) {
    var pid = resolvePartnerId(partnerId);
    try { return sessionStorage.getItem('fz_stmt_' + pid + '_' + key) || null; }
    catch (e) { return null; }
  }
  function saveStatementUrl(partnerId, key, url) {
    var pid = resolvePartnerId(partnerId);
    try {
      if (url) sessionStorage.setItem('fz_stmt_' + pid + '_' + key, url);
      else sessionStorage.removeItem('fz_stmt_' + pid + '_' + key);
    } catch (e) {}
  }
  function leadStatementsFor(partnerId) {
    var pid = resolvePartnerId(partnerId);
    var p = PARTNERS[pid];

    /* Earliest month a statement could exist for: the partnership start when
       we know it, else the start of the export window. */
    var startIso = p.sinceISO || (DATASET_NOTES && DATASET_NOTES.dateFrom) || null;
    var start;
    if (startIso) {
      var m = /^(\d{4})-(\d{2})/.exec(startIso);
      start = new Date(+m[1], +m[2] - 1, 1);
    } else {
      var h = addDays(TODAY, -HISTORY_DAYS);
      start = new Date(h.getFullYear(), h.getMonth(), 1);
    }

    var months = [];
    var cur = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1);
    while (cur >= start && months.length < 12) {
      var key = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0');
      var monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
      var url = statementUrl(pid, key);
      if (!url && months.length > 0) {
        /* Demo URL for older months; the newest closed month stays unlinked
           so the monthly admin step is visible. Fabricated, like every other
           document URL in the mock. */
        url = 'https://docs.google.com/spreadsheets/d/FZ-statement-' + pid + '-' + key;
      }
      months.push({
        key: key,
        label: cur.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        monthEnd: monthEnd,
        generatedAt: firstBusinessDayAfter(monthEnd),
        url: url
      });
      cur = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
    }

    var curEnd = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0);
    return {
      months: months,
      current: {
        label: TODAY.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        closesAt: curEnd,
        expectedAt: firstBusinessDayAfter(curEnd)
      }
    };
  }

  /* Seed ONE illustrative CPL target so the feature demonstrates with real
     numbers instead of an empty state everywhere. 50% is a target margin
     comfortably above the 45% campaign floor; volume is set to roughly the
     partner's own trailing 4-week accepted average, computed live, so the
     pace tracker opens close to on-pace rather than looking broken by an
     arbitrary round number. Every other partner is correctly "not set".

     THIS MUST RUN LAST, after every `var CONST = value` in the module has
     actually executed its assignment — not merely been hoisted. It was
     originally placed right after the dataset loader (much earlier in the
     file) and silently computed zero matured leads for every partner: it
     called isMature(), which compares against MATURITY_DAYS, but
     MATURITY_DAYS is declared with `var` further down the file. `var`
     hoists the DECLARATION to the top of the module, not the assignment —
     so at that point MATURITY_DAYS existed but was still `undefined`, and
     `30 >= undefined` is `false` for every lead, no matter how mature it
     really was. Function DECLARATIONS (`function foo(){}`) are fully
     hoisted with their bodies and are safe to call from anywhere in the
     module; plain `var` constants are not — only their empty declaration
     is. Keep this seed here, after everything, rather than re-introducing
     that bug. */
  (function seedOneCplTarget() {
    /* Real data names its own CPL partner via the dataset loader; the mock
       generator always has a fixed 'opx' as its CPL demo id (see PARTNERS
       above), so both paths get a working illustration. */
    var seedPid = (typeof REKEY_TARGETS !== 'undefined' && REKEY_TARGETS && REKEY_TARGETS[1])
      ? REKEY_TARGETS[1]
      : (PARTNERS.opx ? 'opx' : null);
    if (!seedPid || !isCplPartner(seedPid)) return;
    if (cplTargetsFor(seedPid, undefined).isSet) return;   /* an admin (or a prior run) already set one */

    var rpl = revenuePerAcceptedLead({ partnerId: seedPid });
    if (!rpl.usable) return;   /* not enough matured history to derive a CPL from margin */

    var trailing = queryLeads({ partnerId: seedPid, from: addDays(TODAY, -27), to: TODAY });
    var weeklyAcceptedAvg = Math.round(computeMetrics(trailing, TODAY, { rateBasis: 'paid' }).paid / 4);
    if (!weeklyAcceptedAvg) return;

    saveCplTarget(seedPid, undefined, { marginPct: 0.50 }, 'marginPct');
    saveCplTarget(seedPid, undefined, { volume: weeklyAcceptedAvg }, 'volume');
  })();

  /* ---------------------------------------------------------------------- */
  /* Exports                                                                */
  /* ---------------------------------------------------------------------- */

  global.FZData = {
    TODAY: TODAY,
    MATURITY_DAYS: MATURITY_DAYS,

    CAMPAIGNS: CAMPAIGNS,
    campaignsFor: campaignsFor,
    activeCampaignsFor: activeCampaignsFor,
    inactiveCampaignsFor: inactiveCampaignsFor,
    compLabelForCampaign: compLabelForCampaign,
    affiliatePayout: affiliatePayout,

    ACCOUNT_MANAGER: ACCOUNT_MANAGER,
    BILLING_CONTACTS: BILLING_CONTACTS,
    usersFor: usersFor,
    saveUsers: saveUsers,
    primaryContact: primaryContact,
    setPrimaryContact: setPrimaryContact,
    isPartnerActive: isPartnerActive,
    avgWeeklyVolume: avgWeeklyVolume,
    nextPaymentDate: nextPaymentDate,
    usingRealData: function () { return USING_REAL_DATA; },
    datasetNotes: function () { return DATASET_NOTES; },
    fmtSince: fmtSince,
    leadCriteria: leadCriteria,
    campaignById: campaignById,
    compForCampaign: compForCampaign,
    compsFor: compsFor,
    rateBasisFor: rateBasisFor,

    PARTNERS: PARTNERS,
    partner: partner,
    resolvePartnerId: resolvePartnerId,

    COMP_MODELS: COMP_MODELS,
    compModel: compModel,

    LEAD_COLUMNS: LEAD_COLUMNS,
    COLUMN_BY_KEY: COLUMN_BY_KEY,
    ADMIN_COLUMN_CONFIG: ADMIN_COLUMN_CONFIG,
    columnsFor: columnsFor,
    columnsForPartner: columnsForPartner,

    REJECT_REASONS: REJECT_REASONS,
    REJECT_GROUPS: REJECT_GROUPS,
    REJECT_ORDER: REJECT_ORDER,
    rejectCatalogue: rejectCatalogue,
    rejectIsReal: rejectIsReal,
    rejectIsLive: rejectIsLive,
    rejectGroup: rejectGroup,
    rejectLabel: rejectLabel,
    rejectDesc: rejectDesc,
    DOCUMENTS: DOCUMENTS,
    documentsFor: documentsFor,
    savePartnerDocUrl: savePartnerDocUrl,
    CRITERIA_DOC_URL: CRITERIA_DOC_URL,
    ADMIN_FEEDBACK: ADMIN_FEEDBACK,
    feedbackLink: feedbackLink,
    CREATIVE_LINKS: CREATIVE_LINKS,
    CREATIVE_STATUS: CREATIVE_STATUS,
    creativesFor: creativesFor,
    submitCreatives: submitCreatives,
    _reviewCreatives: _reviewCreatives,
    COMPLIANCE_CONTACT: COMPLIANCE_CONTACT,
    UNSUB_LINKS: UNSUB_LINKS,
    API_SPECS: API_SPECS,
    TEST_LEAD: TEST_LEAD,
    TRACKING_PARAMS: TRACKING_PARAMS,
    complianceFor: complianceFor,
    setupCampaignsFor: setupCampaignsFor,
    campaignSetup: campaignSetup,
    saveSetupState: saveSetupState,
    rejectFix: rejectFix,
    SOLD_TYPES: SOLD_TYPES,
    NORTH_STAR_TYPES: NORTH_STAR_TYPES,
    NEW_TIER_TYPES: NEW_TIER_TYPES,
    ASSET_BANDS: ASSET_BANDS,
    ASSET_BY_KEY: ASSET_BY_KEY,
    RANGES: RANGES,

    OPERATING_HOURS: OPERATING_HOURS,
    IDEAL_WINDOWS: IDEAL_WINDOWS,
    IDEAL_DOW_SPLIT: IDEAL_DOW_SPLIT,
    COVERAGE_NOTE: COVERAGE_NOTE,
    MONTH_PHASES: MONTH_PHASES,
    ADMIN_CONVERSION_WINDOWS: ADMIN_CONVERSION_WINDOWS,
    conversionWindows: conversionWindows,
    CW_MIN_BUCKET: CW_MIN_BUCKET,
    CW_MIN_SALES: CW_MIN_SALES,
    CW_LIFT: CW_LIFT,
    CW_MIN_SCOPE: CW_MIN_SCOPE,
    MONTH_PHASE_ORDER: MONTH_PHASE_ORDER,
    MONTH_PHASE_LABEL: MONTH_PHASE_LABEL,
    monthPhase: monthPhase,
    HOUR_SEGMENT_LABEL: HOUR_SEGMENT_LABEL,
    HOUR_SEGMENT_ORDER: HOUR_SEGMENT_ORDER,
    isIdealSegment: isIdealSegment,
    DOW_LABEL: DOW_LABEL,
    DOW_SHORT: DOW_SHORT,

    STATE_DEMAND: STATE_DEMAND,
    budgetRoom: budgetRoom,
    BUDGET_BANDS: BUDGET_BANDS,
    US_STATES: US_STATES,
    STATE_NAME: STATE_NAME,
    BLOCKED_STATES: BLOCKED_STATES,
    ADMIN_STATE_DEMAND: ADMIN_STATE_DEMAND,
    stateRows: stateRows,
    stateDemand: stateDemand,
    isCoverageState: isCoverageState,
    BLENDED_CPL: BLENDED_CPL,

    queryLeads: queryLeads,
    queryLeadsBySold: queryLeadsBySold,
    cohort: cohort,
    isCplPartner: isCplPartner,
    cplScopeIsPure: cplScopeIsPure,
    dowWeightsFor: dowWeightsFor,
    saveDowWeights: saveDowWeights,
    revenuePerAcceptedLead: revenuePerAcceptedLead,
    cplFromMargin: cplFromMargin,
    marginFromCpl: marginFromCpl,
    spendFromVolume: spendFromVolume,
    volumeFromSpend: volumeFromSpend,
    cplTargetsFor: cplTargetsFor,
    saveCplTarget: saveCplTarget,
    cplWeeklyProgress: cplWeeklyProgress,
    dailyCplTarget: dailyCplTarget,
    currentWeek: currentWeek,
    weekLabel: weekLabel,
    resolveRange: resolveRange,
    priorWindow: priorWindow,
    computeMetrics: computeMetrics,
    dowSplit: dowSplit,
    windowSplit: windowSplit,
    dailySeries: dailySeries,
    groupBy: groupBy,
    payoutForWindow: payoutForWindow,
    RETURN_REASONS: RETURN_REASONS,
    queryUnfires: queryUnfires,
    leadStatementsFor: leadStatementsFor,
    saveStatementUrl: saveStatementUrl,
    suppressionFileFor: suppressionFileFor,
    ADMIN_SUPPRESSION_FILES: ADMIN_SUPPRESSION_FILES,
    isMature: isMature,
    median: median,

    addDays: addDays,
    daysBetween: daysBetween,
    dayKey: dayKey,

    /* Internal-only aggregate for the health engine. Deliberately NOT part of
       queryLeads — see health.js for why it never reaches the UI. */
    _internalAggregates: function (opts) {
      var range = opts.range;
      var pid = resolvePartnerId(opts.partnerId);
      var fromMs = new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate()).getTime();
      var toMs = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate(), 23, 59, 59, 999).getTime();
      var margin = 0, revenue = 0, unfires = 0, badContacts = 0, paid = 0;
      for (var i = 0; i < ALL_LEADS.length; i++) {
        var l = ALL_LEADS[i];
        if (l.partnerId !== pid) continue;
        var t = l.receivedAt.getTime();
        if (t < fromMs || t > toMs) continue;
        if (opts.campaignId && opts.campaignId !== 'all' && l.campaignId !== opts.campaignId) continue;
        if (opts.subid && opts.subid !== 'all' && l.subid !== opts.subid) continue;
        if (l.status !== 'paid') continue;
        paid++;
        margin += l._margin;
        revenue += l.saleAmount;
        if (l._unfired) unfires++;
        if (l._badContact) badContacts++;
      }
      /* The *Usable flags tell the health engine whether an input is real.
         With the live export neither margin nor bad-contact is: Lead Cost is
         the $1 phantom COGS and there is no bad-contact signal in the file.
         Those components are PARKED rather than scored, so a gap on our side
         never costs the partner points. */
      return {
        paid: paid,
        marginPct: revenue ? margin / revenue : 0,
        marginUsable: !USING_REAL_DATA,
        unfireRate: paid ? unfires / paid : 0,
        badContactRate: paid ? badContacts / paid : 0,
        badContactUsable: !USING_REAL_DATA
      };
    }
  };

})(window);
