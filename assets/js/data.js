/* ==========================================================================
   data.js — mock lead dataset + the redaction query layer
   --------------------------------------------------------------------------
   TWO THINGS LIVE IN THIS FILE, AND THE SECOND ONE IS THE IMPORTANT ONE.

   1. A deterministic generator that fabricates ~4 months of realistic lead
      traffic so the mock-up has something to render. Throwaway — in production
      it is replaced by a MySQL query.

   2. queryLeads() — the visibility firewall. An ALLOWLIST projection: each
      returned row is built field-by-field from a per-partner-type column list,
      so a field a partner may not see is never copied onto the object and
      cannot be read out of the DOM, a CSV export, or the console.

      THIS IS THE PATTERN THE PHP BUILD SHOULD COPY. Two different SELECT
      lists, not one SELECT plus an `if` in the template:

        // RevShare partner
        SELECT l.id, l.received_at, l.subid, l.campaign_id, l.status,
               l.reject_reason, l.asset_band, l.sold_type, l.sold_at,
               l.days_to_sale, l.sale_amount,
               ROUND(l.sale_amount * p.rev_share_pct, 2) AS partner_share
          FROM leads l JOIN partners p ON p.id = l.partner_id
         WHERE l.partner_id = ? AND l.received_at BETWEEN ? AND ?

        // Flat / tiered CPL partner — sale_amount is not in the statement at
        // all, and outcome columns are nulled on rejected rows.
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

      Columns in NEITHER list, for ANY partner type:
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

  /* Rejection reasons in the affiliate's language, each with the fix.
     `age` is rendered through rejectLabel() because the accepted band is a
     negotiated commercial term that differs by partner. */
  var REJECT_REASONS = {
    duplicate: {
      label: 'Duplicate — sold as Priority/Hot in last 365 days',
      fix: 'Screen the number in Duplicate Check before you pay to acquire it.'
    },
    assets: {
      label: 'Investable assets under $25,000',
      fix: 'Under $25K never pays under any model. Add an assets question to the funnel.'
    },
    advisor: {
      label: 'Financial advisor or industry professional',
      fix: 'Add an occupation exclusion or suppress advisor lists.'
    },
    consent: {
      label: 'Consent / sign-up not captured',
      fix: 'Confirm the TCPA disclosure is on the page and the certificate is posting.'
    },
    ipqs: {
      label: 'Failed contact validation',
      fix: 'Phone or email did not validate. Check traffic source quality.'
    },
    age: {
      label: 'Age outside accepted criteria',
      fix: 'Add an age gate to the funnel before the lead posts.'
    },
    state: {
      label: 'State not accepted',
      fix: 'New York is never accepted. See Coverage for the states we want most.'
    },
    contact: {
      label: 'Bad contact — wrong number or disconnected',
      fix: 'Tighten phone verification at the source.'
    }
  };

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
         with the partner's own band. */
  var PARTNER_TYPES = {
    revshare: {
      key: 'revshare',
      name: 'Annuity Heritage Group',
      compModel: 'Revenue share — 40%',
      shortModel: 'RevShare 40%',
      seesEarnings: true,
      revSharePct: 0.40,
      ageBand: '45–75',
      products: 'Annuity',
      integration: 'Their funnel → our API'
    },
    cpl: {
      key: 'cpl',
      name: 'OptiLabX Media',
      compModel: 'Tiered CPL — $102 / $90 / $27',
      shortModel: 'Tiered CPL',
      seesEarnings: false,
      revSharePct: 0,
      ageBand: '45–79',                 /* negotiated exception, not an error */
      products: 'Annuity + Life',
      integration: 'Our landing pages'
    }
  };

  function partner(partnerType) {
    return PARTNER_TYPES[partnerType === 'revshare' ? 'revshare' : 'cpl'];
  }

  /** Criteria labels must carry the partner's negotiated band. */
  function rejectLabel(key, partnerType) {
    if (key === 'age') return 'Age outside ' + partner(partnerType).ageBand + ' criteria';
    return REJECT_REASONS[key] ? REJECT_REASONS[key].label : key;
  }
  function rejectFix(key) {
    return REJECT_REASONS[key] ? REJECT_REASONS[key].fix : '';
  }

  /* ---------------------------------------------------------------------- */
  /* Campaigns                                                              */
  /* ---------------------------------------------------------------------- */

  /* Heritage's fresh/aged split is the live example of why campaigns must be
     broken out natively: a small excellent campaign and a large low-yield one
     blend into a single mediocre-looking account. */
  var CAMPAIGNS = [
    {
      id: '596', name: 'Annuity — Fresh', partnerType: 'revshare',
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
      id: '597', name: 'Annuity — Aged under 6mo', partnerType: 'revshare',
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
      id: '600', name: 'Annuity — Aged over 6mo', partnerType: 'revshare',
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
      id: 'OPX-ANN-LP', name: 'Annuity — Landing page', partnerType: 'cpl',
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
      id: 'OPX-ANN-EMAIL', name: 'Annuity — Email', partnerType: 'cpl',
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
      id: 'OPX-ANN-SPAN', name: 'Annuity — Spanish', partnerType: 'cpl',
      product: 'Annuity', kind: 'fresh', perDay: [4, 8], acceptRate: 0.72,
      sold: { priority: 0.10, hot: 0.10, auction: 0.05, marketplace: 0.05 },
      rejectMix: [['ipqs', 25], ['assets', 20], ['duplicate', 18], ['consent', 15], ['age', 12], ['advisor', 6], ['state', 4]],
      cycle: [8, 15],
      subids: [
        { id: 'opx_span_search', label: 'Spanish — search', share: 0.58, quality: 1.14 },
        { id: 'opx_span_social', label: 'Spanish — social', share: 0.42, quality: 0.88 }
      ]
    },
    {
      id: 'OPX-LIFE-LP', name: 'Life — Landing page', partnerType: 'cpl',
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

  function campaignsFor(partnerType) {
    return CAMPAIGNS.filter(function (c) { return c.partnerType === partnerType; });
  }

  /* ---------------------------------------------------------------------- */
  /* Geography & timing                                                     */
  /* ---------------------------------------------------------------------- */

  /* New York is a hard exclusion and is deliberately absent from supply here;
     the few that arrive are generated as rejects. */
  var STATES = [
    ['TX', 14], ['FL', 13], ['OH', 8], ['PA', 8], ['NC', 7], ['GA', 7],
    ['MI', 6], ['TN', 5], ['MO', 5], ['IN', 4], ['AZ', 4], ['CO', 3],
    ['WA', 3], ['CA', 6], ['NV', 2], ['UT', 2], ['NM', 1], ['KS', 1],
    ['NE', 1], ['SD', 1]
  ];

  /* Underserved high-retiree states plus the ones we are currently short in.
     A partner who fills these earns budget. */
  var FOCUS_STATES = { CA: 1, NV: 1, AZ: 1, NM: 1, WA: 1 };
  var SHORT_STATES = { CO: 1, UT: 1, NE: 1, SD: 1, KS: 1 };
  function isCoverageState(st) { return !!(FOCUS_STATES[st] || SHORT_STATES[st]); }

  /* Arrival windows. Early-morning arrivals convert materially better, so
     that is the window we ask partners to grow — not the evening. */
  /* Early has to carry enough volume that its conversion rate is readable —
     at ~9% of traffic the sample was small enough that noise swamped the
     lift and the card contradicted its own footnote. */
  var HOUR_SEGMENTS = [
    ['early',    16],   /* 6a–9a  — the golden window */
    ['morning',  25],
    ['midday',   22],
    ['afternoon', 20],
    ['evening',  13],
    ['late',      4]
  ];
  var HOUR_SEGMENT_LABEL = {
    early: '6a–9a', morning: '9a–12p', midday: '12p–3p',
    afternoon: '3p–6p', evening: '6p–9p', late: '9p+'
  };
  var HOUR_SEGMENT_ORDER = ['early', 'morning', 'midday', 'afternoon', 'evening', 'late'];
  /* Early arrivals convert better; late arrivals worse. */
  var HOUR_YIELD = {
    early: 2.05, morning: 1.15, midday: 0.95, afternoon: 0.85, evening: 0.70, late: 0.55
  };

  var DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
      /* Monday–Wednesday is the strongest revenue window, Wednesday biggest;
         weekends run light and carry the worst COGS. */
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
      partnerType: camp.partnerType,
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
      _clawback: false,
      _badContact: false
    };

    /* Under $25K investable never pays, under any comp model. */
    var forcedReject = !band.payable;
    var accept = Math.min(0.94, camp.acceptRate * (0.72 + 0.28 * q));
    var isPaid = !forcedReject && rnd() < accept;

    var pct = partner(camp.partnerType).revSharePct;

    if (!isPaid) {
      lead.status = 'free';
      lead.rejectReason = forcedReject ? 'assets' : weighted(camp.rejectMix);

      /* REJECTED-BUT-SOLD. A lead we declined can still find a buyer, and it
         costs us nothing because we never paid for it.

         RevShare partners SEE these and are paid on them — confirmed by Logan
         Aug 2026, overriding the blanket rule in the context doc. CPL partners
         must never learn they exist; see the row rule in runQuery(). */
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
    lead._clawback = lead.soldType ? rnd() < 0.035 : false;

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
       band and the 6–9a window are the two biggest levers a partner has. */
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

  var ALL_LEADS = generate();

  /* ====================================================================== */
  /* THE FIREWALL                                                           */
  /* ====================================================================== */

  var COLUMNS = {
    /* Identity and intake. Every partner type gets all of this, including the
       rejection reason — a partner cannot fix what they cannot see. */
    base: [
      'id', 'receivedAt', 'campaignId', 'campaignName', 'campaignKind', 'product',
      'subid', 'subidLabel', 'state', 'hourSegment', 'assetBand',
      'status', 'rejectReason'
    ],
    /* What happened after intake. Withheld on REJECTED rows for CPL. */
    outcome: ['soldType', 'soldAt', 'daysToSale'],
    /* Money. RevShare only, on every row including rejected-but-sold. */
    revshare: ['saleAmount', 'partnerShare']
  };

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
    var isRev = opts.partnerType === 'revshare';
    var cols = COLUMNS.base
      .concat(COLUMNS.outcome)
      .concat(isRev ? COLUMNS.revshare : []);

    var from = opts.from || addDays(TODAY, -6);
    var to = opts.to || TODAY;
    var fromMs = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
    var toMs = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999).getTime();
    var wantPartner = isRev ? 'revshare' : 'cpl';

    var out = [];
    for (var i = 0; i < ALL_LEADS.length; i++) {
      var src = ALL_LEADS[i];
      if (src.partnerType !== wantPartner) continue;
      var d = src[dateField];
      if (!d) continue;
      var t = d.getTime();
      if (t < fromMs || t > toMs) continue;
      if (opts.campaignId && opts.campaignId !== 'all' && src.campaignId !== opts.campaignId) continue;
      if (opts.subid && opts.subid !== 'all' && src.subid !== opts.subid) continue;

      /* ---- THE ROW RULE -------------------------------------------------
         For a CPL partner a rejected lead dies at the door: they see that it
         arrived and why it was declined, and nothing after that.

         Enforced here rather than in the view because it is not just about
         hiding a column — it changes which ROWS exist. A sold-date query must
         not return a rejected lead at all, or a CPL partner could infer from
         a row count alone that we work leads we declined. */
      var dropOutcome = !isRev && src.status === 'free';
      if (dropOutcome && dateField === 'soldAt') continue;

      var row = {};
      for (var c = 0; c < cols.length; c++) {
        var k = cols[c];
        if (dropOutcome && COLUMNS.outcome.indexOf(k) !== -1) continue;
        row[k] = src[k];
      }
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
   * @param opts.rateBasis 'paid' | 'all'
   *   'paid' (CPL) — of the leads we ACCEPTED and paid for, how many
   *      converted. The right question for a partner paid per accepted lead.
   *   'all' (RevShare) — of EVERY lead submitted. A RevShare partner is paid
   *      on any sale, accepted or not, so dividing by accepted leads alone
   *      overstates conversion and undervalues the volume they send.
   */
  function computeMetrics(rows, asOf, opts) {
    asOf = asOf || TODAY;
    var basis = (opts && opts.rateBasis) === 'all' ? 'all' : 'paid';

    var raw = rows.length;
    var paid = 0, free = 0, mature = 0, maturePaid = 0, immaturePaid = 0;
    var rejectedSold = 0, rejectedSoldPH = 0, rejectedEarnings = 0;
    var byType = { priority: 0, hot: 0, auction: 0, marketplace: 0, appointment: 0, livetransfer: 0 };
    var cycles = [], rejects = {}, salePrices = [];
    var earnings = 0, saleTotal = 0, hasEarnings = false;
    var byBand = {}, bySegment = {}, byState = {}, byDow = {};

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

      if (r.soldType && byType[r.soldType] !== undefined) byType[r.soldType]++;

      if (r.soldType && r.status === 'free') {
        rejectedSold++;
        if (isPH) rejectedSoldPH++;
        rejectedEarnings += r.partnerShare || 0;
      }

      if (r.daysToSale != null) cycles.push(r.daysToSale);
      if (r.saleAmount) salePrices.push(r.saleAmount);

      if (r.partnerShare !== undefined) {
        hasEarnings = true;
        earnings += r.partnerShare || 0;
        saleTotal += r.saleAmount || 0;
      }

      /* Breakdowns the affiliate can act on. */
      var bBand = bucket(byBand, r.assetBand);
      var bSeg = bucket(bySegment, r.hourSegment);
      var bSt = bucket(byState, r.state);
      var bDow = bucket(byDow, r.receivedAt.getDay());
      [bBand, bSeg, bSt, bDow].forEach(function (b) {
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

    var rateDenom = basis === 'all' ? mature : maturePaid;
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
      avgSalePrice: salePrices.length ? round2(salePrices.reduce(function (a, b) { return a + b; }, 0) / salePrices.length) : null,
      rejects: rejects,

      hasEarnings: hasEarnings,
      earnings: round2(earnings),
      saleTotal: round2(saleTotal),

      byBand: byBand, bySegment: bySegment, byState: byState, byDow: byDow
    };
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
      partnerType: opts.partnerType,
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

  /* ---------------------------------------------------------------------- */
  /* Spend & volume targets                                                 */
  /* ---------------------------------------------------------------------- */

  /* NOT YET BUILT — no admin UI sets these. Hard-coded so the affiliate-facing
     half can be reviewed. Volume and/or spend, either or both; a null target
     means "not set" and must not render. Always worded as a TARGET, never a
     cap — partners hear "cap" as a limit and go quiet. */
  var TARGETS = {
    revshare: { volume: 1500, spend: 9000, spendLabel: 'Revenue share payout' },
    cpl:      { volume: 1400, spend: null, spendLabel: 'Spend' }
  };

  function targetsFor(partnerType) {
    return TARGETS[partnerType === 'revshare' ? 'revshare' : 'cpl'];
  }

  function targetProgress(opts) {
    var t = targetsFor(opts.partnerType);
    var monthStart = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    var monthEnd = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0);
    var daysInMonth = monthEnd.getDate();
    var daysElapsed = TODAY.getDate();
    var daysLeft = daysInMonth - daysElapsed;

    var rows = queryLeads({
      partnerType: opts.partnerType,
      from: monthStart, to: TODAY,
      campaignId: opts.campaignId, subid: opts.subid
    });
    var m = computeMetrics(rows, TODAY, { rateBasis: opts.rateBasis });
    var volumeActual = m.raw;

    /* Payout is an OUTCOME for RevShare — they are paid when a lead SELLS,
       9–12 days after it arrives. On the received basis this reports $0 for
       the first week and a half of every month. CPL is the opposite: we owe
       on acceptance, so it stays on the received basis. */
    var spendActual = null;
    if (m.hasEarnings) {
      var soldMtd = queryLeadsBySold({
        partnerType: opts.partnerType,
        from: monthStart, to: TODAY,
        campaignId: opts.campaignId, subid: opts.subid
      });
      spendActual = computeMetrics(soldMtd, TODAY, { rateBasis: opts.rateBasis }).earnings;
    } else if (opts.cplRate) {
      spendActual = round2(m.paid * opts.cplRate);
    }

    function pace(actual, target) {
      if (target == null || !target) return null;
      var expected = target * (daysElapsed / daysInMonth);
      /* Severity is judged against where they should be TODAY, not against
         the full month — at day 5 of 31, 14% of a monthly target is fine. */
      var ratio = expected ? actual / expected : 1;
      return {
        target: target, actual: actual, pct: actual / target,
        expected: expected, ratio: ratio, aheadBy: actual - expected,
        onPace: ratio >= 0.97,
        severity: ratio >= 0.97 ? '' : ratio >= 0.85 ? 'is-warning'
                : ratio >= 0.70 ? 'is-serious' : 'is-critical',
        perDayNeeded: daysLeft > 0 ? Math.max(0, (target - actual) / daysLeft) : 0,
        projected: daysElapsed ? (actual / daysElapsed) * daysInMonth : 0
      };
    }

    return {
      monthLabel: TODAY.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      daysElapsed: daysElapsed, daysInMonth: daysInMonth, daysLeft: daysLeft,
      spendLabel: t.spendLabel,
      volume: pace(volumeActual, t.volume),
      spend: spendActual == null ? null : pace(spendActual, t.spend)
    };
  }

  function dailyVolumeTarget(partnerType) {
    var t = targetsFor(partnerType);
    if (!t.volume) return null;
    var daysInMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 0).getDate();
    return t.volume / daysInMonth;
  }

  /* ---------------------------------------------------------------------- */
  /* Duplicate self-check                                                   */
  /* ---------------------------------------------------------------------- */

  /* Returns a BOOLEAN and at most the month it last sold. No buyer, no price,
     no lead id, no name. This is a suppression-list API in disguise, so the
     response shape is the containment. */
  function checkDuplicate(phoneRaw) {
    var digits = String(phoneRaw || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    if (digits.length !== 10) return { ok: false, error: 'Enter a 10-digit US phone number.' };

    var h = 0;
    for (var i = 0; i < digits.length; i++) h = (h * 31 + digits.charCodeAt(i)) >>> 0;

    var isDupe = (h % 100) < 22;
    var result = { ok: true, phone: formatPhone(digits), duplicate: isDupe };
    if (isDupe) {
      var monthsAgo = h % 12;
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
    campaignsFor: campaignsFor,
    PARTNER_TYPES: PARTNER_TYPES,
    partner: partner,
    REJECT_REASONS: REJECT_REASONS,
    rejectLabel: rejectLabel,
    rejectFix: rejectFix,
    SOLD_TYPES: SOLD_TYPES,
    NORTH_STAR_TYPES: NORTH_STAR_TYPES,
    NEW_TIER_TYPES: NEW_TIER_TYPES,
    ASSET_BANDS: ASSET_BANDS,
    ASSET_BY_KEY: ASSET_BY_KEY,
    RANGES: RANGES,
    HOUR_SEGMENT_LABEL: HOUR_SEGMENT_LABEL,
    HOUR_SEGMENT_ORDER: HOUR_SEGMENT_ORDER,
    DOW_LABEL: DOW_LABEL,
    FOCUS_STATES: FOCUS_STATES,
    SHORT_STATES: SHORT_STATES,
    isCoverageState: isCoverageState,

    queryLeads: queryLeads,
    queryLeadsBySold: queryLeadsBySold,
    cohort: cohort,
    targetsFor: targetsFor,
    targetProgress: targetProgress,
    dailyVolumeTarget: dailyVolumeTarget,
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

    /* Internal-only aggregate for the health engine. Deliberately NOT part of
       queryLeads — see health.js for why it never reaches the UI. */
    _internalAggregates: function (opts) {
      var range = opts.range;
      var wantPartner = opts.partnerType === 'revshare' ? 'revshare' : 'cpl';
      var fromMs = new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate()).getTime();
      var toMs = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate(), 23, 59, 59, 999).getTime();
      var margin = 0, revenue = 0, clawbacks = 0, badContacts = 0, paid = 0;
      for (var i = 0; i < ALL_LEADS.length; i++) {
        var l = ALL_LEADS[i];
        if (l.partnerType !== wantPartner) continue;
        var t = l.receivedAt.getTime();
        if (t < fromMs || t > toMs) continue;
        if (opts.campaignId && opts.campaignId !== 'all' && l.campaignId !== opts.campaignId) continue;
        if (opts.subid && opts.subid !== 'all' && l.subid !== opts.subid) continue;
        if (l.status !== 'paid') continue;
        paid++;
        margin += l._margin;
        revenue += l.saleAmount;
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
