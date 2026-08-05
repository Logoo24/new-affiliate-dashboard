/* ==========================================================================
   data.js — mock lead dataset + the redaction query layer
   --------------------------------------------------------------------------
   TWO THINGS LIVE IN THIS FILE, AND THE SECOND ONE IS THE IMPORTANT ONE.

   1. A deterministic generator that fabricates ~4 months of realistic lead
      traffic so the mock-up has something to render. This is throwaway — in
      production it is replaced by a MySQL query.

   2. queryLeads() — the visibility firewall. It is written as an ALLOWLIST
      projection: it builds each returned row field-by-field from a per-partner-
      type column list. Fields that a partner type may not see are never copied
      onto the object, so they cannot be read back out of the DOM, the CSV
      export, or the browser console.

      THIS IS THE PATTERN THE PHP BUILD SHOULD COPY. It is not a UI toggle and
      it must not become one. Spec §3.1: "Build the redaction as a data-layer
      rule, not a UI toggle... If the query never returns the column, it can
      never render."

      The equivalent PHP is two different SELECT lists, not one SELECT plus an
      `if` in the template:

        // RevShare partner
        SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status,
               l.reject_reason, l.sold_type, l.sold_at, l.days_to_sale,
               l.sale_amount, ROUND(l.sale_amount * p.rev_share_pct, 2) AS partner_share
          FROM leads l JOIN partners p ON p.id = l.partner_id
         WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

        // Flat / tiered CPL partner  — sale_amount is not in the statement AT ALL
        SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status,
               l.reject_reason, l.sold_type, l.sold_at, l.days_to_sale
          FROM leads l
         WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

      Columns that appear in NEITHER list, for ANY partner type:
        lead_cost, margin, margin_pct, buyer_name, csr_name, call_result,
        ipqs_score, ipqs_rules_fired, clawback_reason, campaign_cost
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

  /* Weighted pick: [[value, weight], ...] */
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

  /* "Today" is pinned so the mock-up is stable for review. In production this
     is simply NOW(); nothing else about the date logic changes. */
  var TODAY = new Date(2026, 7, 5);           // 2026-08-05, local
  var HISTORY_DAYS = 120;                     // enough for a 90-day benchmark

  /* Rejection reasons are written in the affiliate's language, not ours.
     Each carries the fix, because a reason with no fix is just a complaint.
     Spec §3.2 Module B. */
  var REJECT_REASONS = {
    duplicate: {
      label: 'Duplicate — sold as Priority/Hot in last 365 days',
      fix: 'Screen the number in Duplicate Check before you pay to acquire it.'
    },
    advisor: {
      label: 'Financial advisor or industry professional',
      fix: 'Add an occupation exclusion to your form or suppress advisor lists.'
    },
    consent: {
      label: 'Consent / sign-up not captured',
      fix: 'Confirm the TCPA disclosure is on the page and the token is posting.'
    },
    ipqs: {
      label: 'Failed contact validation',
      fix: 'Phone or email did not validate. Check traffic source quality.'
    },
    age: {
      label: 'Age outside 45–75 criteria',
      fix: 'Add an age gate to the funnel before the lead posts.'
    },
    state: {
      label: 'State not currently open',
      fix: 'See Coverage Asks on the Health Scorecard for open states.'
    },
    contact: {
      label: 'Bad contact — wrong number or disconnected',
      fix: 'Tighten phone verification at the source.'
    }
  };

  var SOLD_TYPES = {
    priority:    { label: 'Priority',    points:  10, exclusivity: 365 },
    hot:         { label: 'Hot',         points:   8, exclusivity: 365 },
    auction:     { label: 'Auction',     points:  -3, exclusivity:  30 },
    marketplace: { label: 'Marketplace', points:  -4, exclusivity:  30 }
  };

  /* Four campaigns for the first build target (spec §7: OptiLabX). The fresh
     vs aged split is deliberate — blended they read as one mediocre campaign,
     split they read as one excellent campaign and one large low-yield one.
     Spec §6 requires the dashboard break this out natively. */
  var CAMPAIGNS = [
    {
      id: 'OPX-ANN-FRESH', name: 'Annuity — Fresh Web', product: 'Annuity',
      kind: 'fresh', perDay: [5, 10], acceptRate: 0.79,
      sold: { priority: 0.13, hot: 0.10, auction: 0.05, marketplace: 0.04 },
      rejectMix: [['ipqs', 30], ['duplicate', 22], ['consent', 16], ['advisor', 12], ['age', 10], ['state', 6], ['contact', 4]],
      cycle: [7, 14],
      subids: [
        { id: 'opx_search_brand', label: 'Search — brand',      share: 0.30, quality: 1.28 },
        { id: 'opx_search_gen',   label: 'Search — generic',    share: 0.26, quality: 1.05 },
        { id: 'opx_native_a',     label: 'Native — placement A', share: 0.24, quality: 0.86 },
        { id: 'opx_display_rt',   label: 'Display — retarget',  share: 0.20, quality: 0.62 }
      ]
    },
    {
      id: 'OPX-ANN-AGED', name: 'Annuity — Aged 6mo', product: 'Annuity',
      kind: 'aged', perDay: [16, 26], acceptRate: 0.62,
      sold: { priority: 0.012, hot: 0.020, auction: 0.09, marketplace: 0.13 },
      rejectMix: [['duplicate', 34], ['age', 24], ['contact', 16], ['ipqs', 12], ['advisor', 6], ['consent', 5], ['state', 3]],
      cycle: [11, 22],
      subids: [
        { id: 'opx_aged_batch1', label: 'Aged batch 1', share: 0.34, quality: 0.92 },
        { id: 'opx_aged_batch2', label: 'Aged batch 2', share: 0.33, quality: 1.02 },
        { id: 'opx_aged_batch3', label: 'Aged batch 3', share: 0.33, quality: 0.88 }
      ]
    },
    {
      id: 'OPX-LIFE-FRESH', name: 'Life — Fresh Web', product: 'Life',
      kind: 'fresh', perDay: [4, 8], acceptRate: 0.74,
      sold: { priority: 0.10, hot: 0.11, auction: 0.06, marketplace: 0.05 },
      rejectMix: [['ipqs', 28], ['consent', 20], ['duplicate', 18], ['contact', 14], ['state', 10], ['advisor', 6], ['age', 4]],
      cycle: [6, 13],
      subids: [
        { id: 'opx_life_search', label: 'Search — life',   share: 0.42, quality: 1.16 },
        { id: 'opx_life_social', label: 'Social — life',   share: 0.33, quality: 0.94 },
        { id: 'opx_life_email',  label: 'Email — partner', share: 0.25, quality: 0.74 }
      ]
    },
    {
      id: 'OPX-ANN-FB', name: 'Annuity — Social', product: 'Annuity',
      kind: 'fresh', perDay: [6, 12], acceptRate: 0.68,
      sold: { priority: 0.075, hot: 0.085, auction: 0.07, marketplace: 0.07 },
      rejectMix: [['age', 26], ['ipqs', 22], ['duplicate', 18], ['consent', 14], ['contact', 11], ['advisor', 6], ['state', 3]],
      cycle: [9, 17],
      subids: [
        { id: 'opx_fb_lookalike', label: 'Social — lookalike', share: 0.38, quality: 1.10 },
        { id: 'opx_fb_interest',  label: 'Social — interest',  share: 0.34, quality: 0.90 },
        { id: 'opx_fb_broad',     label: 'Social — broad',     share: 0.28, quality: 0.55 }
      ]
    }
  ];

  /* Coverage: weighted to show the Pacific/Mountain late-shift gap called out
     in the framework's Volume & Coverage pillar. */
  var STATES = [
    ['TX', 14], ['FL', 13], ['OH', 8], ['PA', 8], ['NC', 7], ['GA', 7],
    ['MI', 6], ['TN', 5], ['MO', 5], ['IN', 4], ['AZ', 4], ['CO', 3],
    ['WA', 3], ['OR', 2], ['CA', 6], ['NV', 2], ['UT', 2], ['ID', 1]
  ];
  var WESTERN = { AZ: 1, CO: 1, WA: 1, OR: 1, CA: 1, NV: 1, UT: 1, ID: 1 };

  var HOUR_SEGMENTS = [
    ['early',   8],   /* 6a–9a  */
    ['morning', 26],  /* 9a–12p */
    ['midday',  24],  /* 12p–3p */
    ['afternoon', 22],/* 3p–6p  */
    ['evening', 16],  /* 6p–9p  — the late shift we are short on */
    ['late',     4]   /* 9p+    */
  ];
  var HOUR_SEGMENT_LABEL = {
    early: '6a–9a', morning: '9a–12p', midday: '12p–3p',
    afternoon: '3p–6p', evening: '6p–9p', late: '9p+'
  };

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
  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  function hourForSegment(seg) {
    var ranges = {
      early: [6, 9], morning: [9, 12], midday: [12, 15],
      afternoon: [15, 18], evening: [18, 21], late: [21, 24]
    };
    var r = ranges[seg];
    return intBetween(r[0], r[1] - 1);
  }

  function generate() {
    var leads = [];
    var counter = 41200;
    var start = addDays(TODAY, -(HISTORY_DAYS - 1));

    for (var dayIdx = 0; dayIdx < HISTORY_DAYS; dayIdx++) {
      var day = addDays(start, dayIdx);
      var dow = day.getDay();
      /* Weekends run lighter — traffic patterns should look like traffic. */
      var dowFactor = (dow === 0) ? 0.55 : (dow === 6) ? 0.68 : 1;
      /* A slow upward drift over the window so trends are not flat noise. */
      var drift = 0.86 + (dayIdx / HISTORY_DAYS) * 0.30;

      for (var c = 0; c < CAMPAIGNS.length; c++) {
        var camp = CAMPAIGNS[c];
        var base = between(camp.perDay[0], camp.perDay[1]);
        var count = Math.max(0, Math.round(base * dowFactor * drift));

        for (var i = 0; i < count; i++) {
          leads.push(makeLead(camp, day, ++counter));
        }
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

    /* Acceptance scales with sub-ID quality — this is what makes the sub-ID
       drilldown worth building: the account average hides the bad publisher. */
    var accept = Math.min(0.94, camp.acceptRate * (0.72 + 0.28 * q));
    var isPaid = rnd() < accept;

    var lead = {
      id: 'FZ-' + seq,
      receivedAt: received,
      campaignId: camp.id,
      campaignKind: camp.kind,
      product: camp.product,
      subid: sub.id,
      subidLabel: sub.label,
      state: state,
      hourSegment: seg,
      status: isPaid ? 'paid' : 'free',
      rejectReason: null,
      soldType: null,
      soldAt: null,
      daysToSale: null,

      /* ---- RevShare-visible ---------------------------------------- */
      saleAmount: 0,
      partnerShare: 0,

      /* ---- INTERNAL ONLY. Never leaves queryLeads(). ---------------- */
      _leadCost: 0,
      _margin: 0,
      _buyerName: null,
      _csrName: null,
      _callResult: null,
      _ipqsScore: Math.round(between(18, 96)),
      _clawback: false,
      _badContact: false
    };

    if (!isPaid) {
      lead.rejectReason = weighted(camp.rejectMix);
      return lead;
    }

    /* --- Paid leads: outcome ------------------------------------------- */

    lead._leadCost = round2(between(11, 34));

    var r = rnd();
    var pPriority = camp.sold.priority * q;
    var pHot      = camp.sold.hot * q;
    var pAuction  = camp.sold.auction;
    var pMarket   = camp.sold.marketplace;

    var soldType = null;
    if (r < pPriority) soldType = 'priority';
    else if (r < pPriority + pHot) soldType = 'hot';
    else if (r < pPriority + pHot + pAuction) soldType = 'auction';
    else if (r < pPriority + pHot + pAuction + pMarket) soldType = 'marketplace';

    if (soldType) {
      var cycle = Math.round(between(camp.cycle[0], camp.cycle[1]));
      var soldAt = addDays(received, cycle);
      /* A lead cannot have sold in the future. Leads inside the maturity
         buffer are simply still cooking — that is not missing data. */
      if (soldAt <= TODAY) {
        lead.soldType = soldType;
        lead.soldAt = soldAt;
        lead.daysToSale = cycle;
        lead.saleAmount = round2(salePrice(soldType));
        lead.partnerShare = round2(lead.saleAmount * 0.40);
        lead._margin = round2(lead.saleAmount - lead._leadCost - lead.partnerShare);
        lead._buyerName = pick(['Meridian Retirement', 'Crestline Financial', 'Oakhaven Advisors',
                                'Summit Wealth Partners', 'Brightwater Group']);
      }
    }

    lead._csrName = pick(['D. Alvarez', 'M. Chen', 'R. Whitfield', 'T. Okafor', 'J. Reyes']);
    lead._callResult = pick(['Contacted — qualified', 'Contacted — not qualified',
                             'No answer', 'Voicemail', 'Callback scheduled']);
    lead._badContact = rnd() < (0.07 / Math.max(0.5, q));
    lead._clawback = lead.soldType ? rnd() < 0.035 : false;

    return lead;
  }

  function salePrice(type) {
    if (type === 'priority')    return between(210, 340);
    if (type === 'hot')         return between(140, 225);
    if (type === 'auction')     return between(38, 72);
    return between(18, 44);     /* marketplace */
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  var ALL_LEADS = generate();

  /* ====================================================================== */
  /* THE FIREWALL                                                           */
  /* ====================================================================== */

  /* Columns each partner type is permitted to receive. Anything not named
     here is never copied onto the returned object. Adding a column to the
     dashboard means adding it to this list on purpose. */
  var COLUMNS = {
    base: [
      'id', 'receivedAt', 'campaignId', 'campaignKind', 'product',
      'subid', 'subidLabel', 'state', 'hourSegment',
      'status', 'rejectReason', 'soldType', 'soldAt', 'daysToSale'
    ],
    revshare: ['saleAmount', 'partnerShare']
  };

  var PARTNER_TYPES = {
    revshare: {
      key: 'revshare',
      name: 'OptiLabX Media',
      compModel: 'Revenue Share — 40%',
      shortModel: 'RevShare 40%',
      seesEarnings: true
    },
    cpl: {
      key: 'cpl',
      name: 'Cardinal Reach LLC',
      compModel: 'Tiered CPL',
      shortModel: 'Tiered CPL',
      seesEarnings: false
    }
  };

  /**
   * The only way the UI is allowed to reach lead data.
   *
   * @param {object} opts
   *   partnerType {'revshare'|'cpl'}  required — decides the column list
   *   from, to    {Date}              inclusive date window
   *   campaignId  {string}            'all' or a campaign id
   *   subid       {string}            'all' or a sub-id
   * @returns {Array<object>} projected rows — redacted by construction
   */
  function queryLeads(opts) {
    return runQuery(opts, 'receivedAt');
  }

  /**
   * The same projection, filtered on the date the lead SOLD rather than the
   * date it arrived.
   *
   * WHY BOTH EXIST — this is the single most important modelling decision on
   * the dashboard, and getting it wrong is what makes a report look broken:
   *
   *   Volume questions  ("what did I send, did it get accepted")
   *      → attribute to the RECEIVED date.
   *   Outcome questions ("what sold this week, what did I earn")
   *      → attribute to the SOLD date.
   *
   * Leads take 9–12 days to cook. If outcomes are attributed to the received
   * date, then a Today / Yesterday / Last-7-days view can only ever report
   * zero sales and zero earnings — not because nothing sold, but because
   * nothing sent that recently has had time to. A partner reads that as "the
   * numbers are wrong again," and they would be right to.
   *
   * Conversion RATES are the third case and cannot use either window: a rate
   * needs a cohort that has finished maturing. Those are reported against the
   * trailing 30 days with the maturity buffer applied — the same basis the
   * health score uses, so the two pages never disagree.
   */
  function queryLeadsBySold(opts) {
    return runQuery(opts, 'soldAt');
  }

  function runQuery(opts, dateField) {
    opts = opts || {};
    var type = opts.partnerType === 'revshare' ? 'revshare' : 'cpl';
    var cols = COLUMNS.base.concat(type === 'revshare' ? COLUMNS.revshare : []);

    var from = opts.from || addDays(TODAY, -6);
    var to = opts.to || TODAY;
    var fromMs = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    var toMs = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime();

    var out = [];
    for (var i = 0; i < ALL_LEADS.length; i++) {
      var src = ALL_LEADS[i];
      var d = src[dateField];
      if (!d) continue;
      var t = d.getTime();
      if (t < fromMs || t > toMs) continue;
      if (opts.campaignId && opts.campaignId !== 'all' && src.campaignId !== opts.campaignId) continue;
      if (opts.subid && opts.subid !== 'all' && src.subid !== opts.subid) continue;

      /* Allowlist projection. Note this is a copy, not a reference — the
         caller never holds a handle on the internal record. */
      var row = {};
      for (var c = 0; c < cols.length; c++) row[cols[c]] = src[cols[c]];
      out.push(row);
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Date range presets                                                     */
  /* ---------------------------------------------------------------------- */

  /* Every one of these works. That is the single highest-value fix in the
     rebuild — the current portal renders current-month-total only. */
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
      /* Falls through for a plain day-count preset, and for 'custom' arriving
         without usable dates — that case must land on a bounded window, not
         an unbounded one. RANGES.custom has no `days`, so guard on the type
         rather than on the key existing. */
      var cfg = RANGES[key];
      var d = (cfg && typeof cfg.days === 'number') ? cfg.days : 6;
      from = addDays(TODAY, -d); to = TODAY;
    }
    if (from > to) { var tmp = from; from = to; to = tmp; }
    return { key: key, from: from, to: to, label: RANGES[key] ? RANGES[key].label : 'Custom range' };
  }

  /* Same length window immediately before the current one — for tile deltas. */
  function priorWindow(range) {
    var span = daysBetween(range.from, range.to) + 1;
    return { from: addDays(range.from, -span), to: addDays(range.from, -1) };
  }

  /* ---------------------------------------------------------------------- */
  /* Metrics — computed from PROJECTED rows only                            */
  /* ---------------------------------------------------------------------- */

  /* Outcome metrics honour a 10-day maturity buffer (framework §4: the 9–12
     day cook cycle). A lead received four days ago has not failed to sell —
     it has not finished cooking, and counting it drags the number down. */
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

  function computeMetrics(rows, asOf) {
    asOf = asOf || TODAY;

    var raw = rows.length;
    var paid = 0, free = 0, mature = 0, maturePaid = 0;
    var priority = 0, hot = 0, auction = 0, marketplace = 0;
    var cycles = [];
    var earnings = 0, saleTotal = 0;
    var hasEarnings = false;
    var rejects = {};
    var immaturePaid = 0;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status === 'paid') {
        paid++;
        if (isMature(r, asOf)) { maturePaid++; } else { immaturePaid++; }
      } else {
        free++;
        if (r.rejectReason) rejects[r.rejectReason] = (rejects[r.rejectReason] || 0) + 1;
      }
      if (isMature(r, asOf)) mature++;

      if (r.soldType === 'priority') priority++;
      else if (r.soldType === 'hot') hot++;
      else if (r.soldType === 'auction') auction++;
      else if (r.soldType === 'marketplace') marketplace++;

      if (r.daysToSale != null) cycles.push(r.daysToSale);

      /* Present only when the projection included them. */
      if (r.partnerShare !== undefined) {
        hasEarnings = true;
        earnings += r.partnerShare || 0;
        saleTotal += r.saleAmount || 0;
      }
    }

    var soldPH = priority + hot;
    var soldAny = soldPH + auction + marketplace;

    /* Priority/Hot rate is measured against MATURED paid leads, so a busy
       week does not look like a collapse just because it is recent. */
    var phRate = maturePaid ? soldPH / maturePaid : 0;

    var points = (priority * SOLD_TYPES.priority.points) +
                 (hot * SOLD_TYPES.hot.points) +
                 (auction * SOLD_TYPES.auction.points) +
                 (marketplace * SOLD_TYPES.marketplace.points);

    return {
      raw: raw,
      paid: paid,
      free: free,
      acceptanceRate: raw ? paid / raw : 0,
      maturePaid: maturePaid,
      immaturePaid: immaturePaid,
      priority: priority,
      hot: hot,
      auction: auction,
      marketplace: marketplace,
      soldPriorityHot: soldPH,
      soldAny: soldAny,
      priorityHotRate: phRate,
      soldRate: maturePaid ? soldAny / maturePaid : 0,
      pointsPerPaid: maturePaid ? points / maturePaid : 0,
      medianCycle: median(cycles),
      rejects: rejects,
      hasEarnings: hasEarnings,
      earnings: round2(earnings),
      saleTotal: round2(saleTotal)
    };
  }

  /* Daily series for the trend charts.
     `dateField` picks the attribution basis — see queryLeadsBySold() above. */
  function dailySeries(rows, range, dateField) {
    dateField = dateField || 'receivedAt';
    var byDay = {};
    var cursor = new Date(range.from.getTime());
    var days = [];
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

  /* The trailing-30-day matured cohort — the only honest basis for a
     conversion RATE, and the same window the health score scores on. */
  function cohort(opts) {
    var range = { from: addDays(TODAY, -29), to: TODAY };
    var rows = queryLeads({
      partnerType: opts.partnerType,
      from: range.from, to: range.to,
      campaignId: opts.campaignId, subid: opts.subid
    });
    return { range: range, rows: rows, metrics: computeMetrics(rows) };
  }

  /* Group rows by an arbitrary key, with metrics per group. */
  function groupBy(rows, keyFn) {
    var buckets = {};
    for (var i = 0; i < rows.length; i++) {
      var k = keyFn(rows[i]);
      (buckets[k] = buckets[k] || []).push(rows[i]);
    }
    return Object.keys(buckets).map(function (k) {
      return { key: k, rows: buckets[k], metrics: computeMetrics(buckets[k]) };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Duplicate self-check                                                   */
  /* ---------------------------------------------------------------------- */

  /* Returns a BOOLEAN and, at most, the month it last sold. No buyer, no
     price, no lead id, no name. Spec §3.2 Module C: "this is a suppression-
     list API in disguise" — the response shape is the containment.

     The lookup is deterministic on the digits so the same number always
     returns the same answer during a demo. */
  function checkDuplicate(phoneRaw) {
    var digits = String(phoneRaw || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    if (digits.length !== 10) {
      return { ok: false, error: 'Enter a 10-digit US phone number.' };
    }

    var h = 0;
    for (var i = 0; i < digits.length; i++) h = (h * 31 + digits.charCodeAt(i)) >>> 0;

    /* ~22% hit rate keeps the demo honest — most numbers are clean. */
    var isDupe = (h % 100) < 22;
    var result = { ok: true, phone: formatPhone(digits), duplicate: isDupe };

    if (isDupe) {
      var monthsAgo = h % 12;                       // 0–11 months back
      var d = new Date(TODAY.getFullYear(), TODAY.getMonth() - monthsAgo, 1);
      result.lastSoldMonth = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    return result;
  }

  function formatPhone(d) {
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }

  /* ---------------------------------------------------------------------- */
  /* Exports                                                                */
  /* ---------------------------------------------------------------------- */

  global.FZData = {
    TODAY: TODAY,
    MATURITY_DAYS: MATURITY_DAYS,
    CAMPAIGNS: CAMPAIGNS,
    PARTNER_TYPES: PARTNER_TYPES,
    REJECT_REASONS: REJECT_REASONS,
    SOLD_TYPES: SOLD_TYPES,
    RANGES: RANGES,
    HOUR_SEGMENT_LABEL: HOUR_SEGMENT_LABEL,
    WESTERN: WESTERN,

    queryLeads: queryLeads,
    queryLeadsBySold: queryLeadsBySold,
    cohort: cohort,
    resolveRange: resolveRange,
    priorWindow: priorWindow,
    computeMetrics: computeMetrics,
    dailySeries: dailySeries,
    groupBy: groupBy,
    checkDuplicate: checkDuplicate,
    isMature: isMature,
    median: median,

    addDays: addDays,
    daysBetween: daysBetween,
    dayKey: dayKey,

    /* Internal-only aggregate used by the health engine. Deliberately NOT
       part of queryLeads — see health.js for why it never reaches the UI. */
    _internalAggregates: function (opts) {
      var range = opts.range;
      var fromMs = new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate()).getTime();
      var toMs = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate(), 23, 59, 59, 999).getTime();
      var margin = 0, revenue = 0, cost = 0, clawbacks = 0, badContacts = 0, paid = 0;
      for (var i = 0; i < ALL_LEADS.length; i++) {
        var l = ALL_LEADS[i];
        var t = l.receivedAt.getTime();
        if (t < fromMs || t > toMs) continue;
        if (opts.campaignId && opts.campaignId !== 'all' && l.campaignId !== opts.campaignId) continue;
        if (opts.subid && opts.subid !== 'all' && l.subid !== opts.subid) continue;
        if (l.status !== 'paid') continue;
        paid++;
        margin += l._margin;
        revenue += l.saleAmount;
        cost += l._leadCost;
        if (l._clawback) clawbacks++;
        if (l._badContact) badContacts++;
      }
      return {
        paid: paid,
        marginPct: revenue ? margin / revenue : 0,
        clawbackRate: paid ? clawbacks / paid : 0,
        badContactRate: paid ? badContacts / paid : 0
      };
    }
  };

})(window);
