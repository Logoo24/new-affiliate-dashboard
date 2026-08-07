/* ==========================================================================
   health.js — the Lead Health Score engine, v2
   --------------------------------------------------------------------------
   Redesigned Aug 7 2026 with Logan, against Michael's five criteria
   (acceptance, downstream sales quality, margins, complaints, compliance).
   Full reasoning: HANDOFF.md "DECISION — Lead Health Score v2".

   FOUR PILLARS, affiliate-visible, built ONLY from what the affiliate
   controls:

     Conversion & value      40%  does the traffic turn into good sales
     Delivered quality       35%  is the lead a real, reachable person
     Compliance & trust      15%  is it clean  — ALSO A GATE (see below)
     Consistency & coverage  10%  steady flow, in the places we need

   WHAT IS DELIBERATELY NOT HERE:
   - The v1 "Speed & operations" pillar (speed-to-lead, call attempts) is
     DELETED, not parked. Those measure OUR call floor's diligence, not the
     affiliate's traffic. Scoring a partner down because we dialled slowly is
     unfair, and even displaying it hands every partner a standing argument
     ("my score is low because you didn't call"). They remain internal ops
     diagnostics — their home is Courtney's Module F. Do not reintroduce.
   - The v1 hidden margin input is REMOVED from the score. A partner with bad
     margin is mispriced — fixed with the CPL lever, not by their behaviour —
     and a visible number moved by an invisible input cannot be explained to
     the person being scored. Margin lives in the INTERNAL OVERLAY (rendered
     on the internal Data connections page), beside the score, never in it.

   HOW EVERY NUMBER IS SCORED — the fairness mechanics:

   1. PERCENTILE CALIBRATION. Each metric scores as the partner's standing
      among our own book (p25 ≈ 25, median ≈ 50, p75 ≈ 75), not against an
      invented target. Pools are computed from the live dataset per CAMPAIGN
      CLASS and recalibrated quarterly in production.
   2. CAMPAIGN-CLASS BENCHMARKS. Fresh annuity, aged annuity and life convert
      differently BY DESIGN — partners run aged campaigns because we asked
      them to. Each campaign is scored against its own class, then the account
      rolls up volume-weighted. One account-level benchmark would quietly mark
      down every partner whose mix we shaped.
   3. SHRINKAGE. Small-sample rates are pulled toward the class median
      (n·v + K·median)/(n + K), so a 150-lead partner reads as "slightly
      below average, low confidence" — not a crisis, not a triumph. Rates
      earn their own value as volume grows.
   4. BANDED ACCEPTANCE. Acceptance scores in steps (≥p50 full credit, then
      down), never continuously — a continuous score invites trimming
      marginal-but-profitable volume to polish a vanity rate. Above the bar
      is above the bar.
   5. GATE, NOT AVERAGE, for compliance. A TCPA complaint or unreviewed
      creatives running is not launderable by a good acceptance rate: any
      critical compliance failure CAPS the total score at 45.
   6. MISSING DATA IS EXCLUDED AND RENORMALISED, never scored zero. Same v1
      rule: a gap on our side must not cost the partner points.

   EARLY-WARNING FLAGS (separate from the score, on purpose): the score is
   stable — matured cohorts, weekly refresh — which makes it a lagging
   detector. flags[] compares the last 7 days of fast signals (duplicates,
   IPQS, acceptance) against the partner's own trailing baseline and raises
   a chip + internal alert. Score = judgment, stable. Flag = detection,
   fast. Never blend them.

   Attribution rules are unchanged from v1: every rate on the trailing
   30-day matured cohort (10-day buffer), volume on received date, accepted
   basis for conversion rates on every comp model (thresholds are calibrated
   that way; the labels say "of accepted" so the Performance page reads as a
   different question, not a contradiction).
   ========================================================================== */

(function (global) {
  'use strict';

  var D = global.FZData;

  /* ---------------------------------------------------------------------- */
  /* Tiers — affiliate-facing labels, internal vocabulary preserved          */
  /* ---------------------------------------------------------------------- */
  var TIERS = [
    { key: 'scale', label: 'Excellent', internal: 'Scale',
      min: 80, badge: 'badge-good', tone: 'good',
      action: 'Your leads are converting well above our benchmark. We have room for more ' +
              'volume at this quality — talk to your account manager about scaling up.' },
    { key: 'healthy', label: 'Healthy', internal: 'Healthy',
      min: 60, badge: 'badge-info', tone: 'info',
      action: 'Solid, steady performance. The pillar breakdown below shows where your ' +
              'biggest remaining upside is.' },
    { key: 'watch', label: 'Needs attention', internal: 'Watch',
      min: 45, badge: 'badge-warn', tone: 'warning',
      action: 'Something in your current traffic mix is holding results back. The rejection ' +
              'reasons and targeting guidance below are the fastest places to look.' },
    { key: 'intervene', label: 'Lead quality issue', internal: 'Intervene',
      min: 0, badge: 'badge-crit', tone: 'critical',
      action: 'A large share of your leads are not reaching a qualified sale. Start with your ' +
              'top rejection reasons, then check the Targeting page for the criteria and the ' +
              'states we need most. Your account manager will reach out to work through it ' +
              'with you.' }
  ];

  function tierFor(score) {
    for (var i = 0; i < TIERS.length; i++) {
      if (score >= TIERS[i].min) return TIERS[i];
    }
    return TIERS[TIERS.length - 1];
  }

  /* The score a critical compliance failure caps at — the top of the
     "Lead quality issue" band, so a gated partner can never read Healthy. */
  var GATE_CAP = 45;

  /* ---------------------------------------------------------------------- */
  /* Small math helpers                                                      */
  /* ---------------------------------------------------------------------- */
  function norm(value, worst, best) {
    if (value == null || isNaN(value)) return null;
    var t = (value - worst) / (best - worst);
    return Math.max(0, Math.min(100, t * 100));
  }
  function mean(a) {
    return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0;
  }
  function stdev(a) {
    if (a.length < 2) return null;
    var m = mean(a);
    return Math.sqrt(mean(a.map(function (v) { return (v - m) * (v - m); })));
  }
  function coefficientOfVariation(values) {
    if (values.length < 2) return 1;
    var m = mean(values);
    if (!m) return 1;
    return stdev(values) / m;
  }
  function median(sorted) {
    if (!sorted.length) return null;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  function pct(v) {
    if (v == null || isNaN(v)) return '—';
    return (v * 100).toFixed(1) + '%';
  }

  /* Parked parts are EXCLUDED and the rest renormalised — never scored zero. */
  function weightedAvg(parts) {
    var sum = 0, w = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].parked || parts[i].score == null) continue;
      sum += parts[i].score * parts[i].weight;
      w += parts[i].weight;
    }
    return w ? sum / w : null;
  }

  /* ---------------------------------------------------------------------- */
  /* Campaign classes — benchmark within like-for-like                       */
  /* ---------------------------------------------------------------------- */
  function classOf(c) {
    if (!c) return 'fresh';
    if (/life/i.test(c.product)) return 'life';
    return c.kind === 'aged' ? 'aged' : 'fresh';
  }
  var CLASS_LABEL = { fresh: 'Fresh annuity', aged: 'Aged annuity', life: 'Life' };

  /* ---------------------------------------------------------------------- */
  /* Metric definitions                                                      */
  /* ---------------------------------------------------------------------- */
  /* higherBetter, shrinkage constant K (null = no shrinkage), and fallback
     linear bounds for when a percentile pool is too small to rank against.
     K is in units of the metric's own denominator (matured accepted for
     conversion, raw submitted for quality). */
  var METRIC_DEFS = {
    ph:        { higherBetter: true,  K: 100, fallback: [0.04, 0.18] },
    topTier:   { higherBetter: true,  K: null, fallback: [0.30, 0.90] },
    sold:      { higherBetter: true,  K: 100, fallback: [0.05, 0.35] },
    cycle:     { higherBetter: false, K: null, fallback: null /* custom */ },
    accept:    { higherBetter: true,  K: 50,  fallback: [0.40, 0.85] },
    dupe:      { higherBetter: false, K: 50,  fallback: null /* custom */ },
    ipqs:      { higherBetter: false, K: 50,  fallback: null /* custom */ },
    stability: { higherBetter: false, K: null, fallback: null /* custom */ },
    pacing:    { higherBetter: false, K: null, fallback: null /* custom */ },
    stateFit:  { higherBetter: true,  K: null, fallback: [0.05, 0.28] }
  };

  /* Fallback scores for inverse metrics when no pool exists (v1 formulas). */
  function fallbackScore(key, v) {
    if (v == null || isNaN(v)) return null;
    switch (key) {
      case 'cycle':     return norm(20 - v, 0, 12);
      case 'dupe':      return norm(0.20 - v, 0, 0.18);
      case 'ipqs':      return norm(0.15 - v, 0, 0.13);
      case 'stability': return norm(0.12 - v, 0, 0.10);
      case 'pacing':    return norm(1 - v, 0.30, 0.85);
      default:
        var fb = METRIC_DEFS[key].fallback;
        return fb ? norm(v, fb[0], fb[1]) : null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Calibration pools                                                       */
  /* ---------------------------------------------------------------------- */
  /* Built once per session from the trailing 30 days of the whole book:
     every campaign with ≥ MIN_POOL_ROWS submitted contributes one value per
     metric to its class pool. Scores are then percentile ranks within the
     class pool (falling back to the global pool, then to linear bounds).
     In production this is a stored calibration table, recomputed quarterly
     — NOT on every request — so a partner's score cannot move because
     someone else's traffic shifted mid-week. See ADMIN-MAPPING §6. */
  var MIN_POOL_ROWS = 40;
  var MIN_POOL_SIZE = 4;
  var _pools = null;

  function campaignMetricValues(m) {
    var raw = m.raw || 0;
    return {
      ph: m.priorityHotRate,
      topTier: m.soldAny ? (m.soldPriorityHot + m.soldNewTiers) / m.soldAny : null,
      sold: m.sellThrough,
      cycle: m.medianCycle,
      accept: m.acceptanceRate,
      dupe: raw ? (m.rejects.duplicate || 0) / raw : null,
      ipqs: raw ? (m.rejects.ipqs || 0) / raw : null
    };
  }

  function buildPools() {
    if (_pools) return _pools;
    _pools = { fresh: {}, aged: {}, life: {}, _all: {} };
    var from = D.addDays(D.TODAY, -29);
    Object.keys(D.PARTNERS).forEach(function (pid) {
      D.campaignsFor(pid).forEach(function (c) {
        var rows = D.queryLeads({ partnerId: pid, campaignId: c.id, from: from, to: D.TODAY });
        if (rows.length < MIN_POOL_ROWS) return;
        var m = D.computeMetrics(rows, D.TODAY);
        var vals = campaignMetricValues(m);
        var cls = classOf(c);
        Object.keys(vals).forEach(function (k) {
          if (vals[k] == null || isNaN(vals[k])) return;
          (_pools[cls][k] = _pools[cls][k] || []).push(vals[k]);
          (_pools._all[k] = _pools._all[k] || []).push(vals[k]);
        });
      });
    });
    Object.keys(_pools).forEach(function (cls) {
      Object.keys(_pools[cls]).forEach(function (k) {
        _pools[cls][k].sort(function (a, b) { return a - b; });
      });
    });
    return _pools;
  }

  function poolFor(cls, key) {
    var pools = buildPools();
    var p = (pools[cls] && pools[cls][key]) || [];
    /* The CLASS pool wins even when it is small. A two-entry aged pool is a
       coarse benchmark, but falling back to the global pool would score aged
       campaigns against fresh ones — punishing partners for running the
       campaigns we asked for, which is the exact unfairness class pools
       exist to prevent. When a partner IS the whole class, the benchmark is
       self-referential; that is honest for a book this size, and the pools
       deepen as campaigns are added. Production recalibrates quarterly. */
    if (p.length >= 1) return p;
    var g = pools._all[key] || [];
    return g.length >= MIN_POOL_SIZE ? g : null;
  }

  function poolMedian(cls, key) {
    var p = poolFor(cls, key);
    return p ? median(p) : null;
  }

  /* Percentile rank 0–100 within the pool (ties count half). */
  function percentileScore(cls, key, v) {
    if (v == null || isNaN(v)) return null;
    var p = poolFor(cls, key);
    if (!p) return fallbackScore(key, v);
    var below = 0, equal = 0;
    for (var i = 0; i < p.length; i++) {
      if (p[i] < v) below++;
      else if (p[i] === v) equal++;
    }
    var rank = ((below + equal / 2) / p.length) * 100;
    return METRIC_DEFS[key].higherBetter ? rank : 100 - rank;
  }

  /* Shrink a small-sample rate toward the class median. */
  function shrink(key, cls, v, n) {
    var K = METRIC_DEFS[key].K;
    if (K == null || v == null || n == null) return v;
    var med = poolMedian(cls, key);
    if (med == null) return v;
    return (n * v + K * med) / (n + K);
  }

  /* Banded, not continuous — see mechanics note #4 in the header. */
  function bandedAcceptScore(p) {
    if (p == null) return null;
    if (p >= 50) return 95;
    if (p >= 25) return 75;
    if (p >= 10) return 45;
    return 20;
  }

  /* ---------------------------------------------------------------------- */
  /* Per-campaign scoring — conversion + quality parts                       */
  /* ---------------------------------------------------------------------- */
  function scoreUnit(m, cls) {
    var raw = m.raw || 0;
    var vals = campaignMetricValues(m);

    var conv = [
      { key: 'ph', label: 'Priority/Hot conversion (of accepted)', weight: 0.45,
        score: percentileScore(cls, 'ph', shrink('ph', cls, vals.ph, m.maturePaid)),
        display: pct(vals.ph) },
      { key: 'topTier', label: 'Share of sales in the top tiers', weight: 0.20,
        score: vals.topTier == null ? null : percentileScore(cls, 'topTier', vals.topTier),
        parked: vals.topTier == null,
        display: vals.topTier == null ? '—' : pct(vals.topTier) },
      { key: 'sold', label: 'Sold rate (of accepted)', weight: 0.20,
        score: percentileScore(cls, 'sold', shrink('sold', cls, vals.sold, m.maturePaid)),
        display: pct(vals.sold) },
      { key: 'cycle', label: 'Median sales cycle', weight: 0.15,
        score: vals.cycle == null ? null : percentileScore(cls, 'cycle', vals.cycle),
        parked: vals.cycle == null,
        display: vals.cycle == null ? '—' : vals.cycle + 'd' }
    ];

    /* Quality: validity signals weigh MORE than raw acceptance — acceptance
       measures fit-to-filter, which is the weakest health signal here. */
    var acceptPct = percentileScore(cls, 'accept', shrink('accept', cls, vals.accept, raw));
    var qual = [
      { key: 'badcontact', label: 'Bad-contact rate', weight: 0.24, internal: true,
        parked: true, score: null,
        parkNote: 'needs the call-outcome feed' },
      { key: 'ipqs', label: 'Contact-validation rejects', weight: 0.22,
        score: percentileScore(cls, 'ipqs', shrink('ipqs', cls, vals.ipqs, raw)),
        display: pct(vals.ipqs) },
      { key: 'dupe', label: 'Duplicate rate', weight: 0.20,
        score: percentileScore(cls, 'dupe', shrink('dupe', cls, vals.dupe, raw)),
        display: pct(vals.dupe) },
      { key: 'accept', label: 'Acceptance rate (banded)', weight: 0.20,
        score: bandedAcceptScore(acceptPct),
        display: pct(vals.accept) },
      /* Stability is account-level by design — weekly acceptance at single-
         campaign grain is too noisy to judge anyone on. Filled in by the
         caller at scope level; parked here. */
      { key: 'stability', label: 'Acceptance stability', weight: 0.14, parked: true, score: null }
    ];

    return { conv: conv, qual: qual, vals: vals };
  }

  /* ---------------------------------------------------------------------- */
  /* The score                                                               */
  /* ---------------------------------------------------------------------- */
  /**
   * @param {object} opts — partnerId, campaignId, subid, range, asOf,
   *                        _light (skip flags + campaign detail, for trend)
   */
  function score(opts) {
    opts = opts || {};
    var asOf = opts.asOf || D.TODAY;
    var range = opts.range || { from: D.addDays(asOf, -29), to: asOf };
    var pid = opts.partnerId;
    var scoped = opts.campaignId && opts.campaignId !== 'all';

    var rows = D.queryLeads({
      partnerId: pid, from: range.from, to: range.to,
      campaignId: opts.campaignId, subid: opts.subid
    });
    var m = D.computeMetrics(rows, asOf);

    /* ---- units: one per campaign, benchmarked against its class --------- */
    var campaigns = D.campaignsFor(pid).filter(function (c) {
      return !scoped || c.id === opts.campaignId;
    });
    var units = [];
    campaigns.forEach(function (c) {
      var urows = rows.filter(function (r) { return r.campaignId === c.id; });
      if (!urows.length) return;
      var um = D.computeMetrics(urows, asOf);
      var cls = classOf(c);
      var u = scoreUnit(um, cls);
      units.push({
        campaign: c, cls: cls, m: um,
        weight: um.raw,
        convScore: weightedAvg(u.conv), qualScore: weightedAvg(u.qual),
        conv: u.conv, qual: u.qual
      });
    });
    /* Sub-ID scope (or rows with no campaign match): score as one unit
       against the global pool via the dominant class. */
    if (!units.length && rows.length) {
      var u1 = scoreUnit(m, 'fresh');
      units.push({ campaign: null, cls: 'fresh', m: m, weight: m.raw,
        convScore: weightedAvg(u1.conv), qualScore: weightedAvg(u1.qual),
        conv: u1.conv, qual: u1.qual });
    }

    var totalW = units.reduce(function (a, u) { return a + u.weight; }, 0) || 1;
    function rollup(field) {
      var s = 0, w = 0;
      units.forEach(function (u) {
        if (u[field] == null) return;
        s += u[field] * u.weight; w += u.weight;
      });
      return w ? s / w : null;
    }
    function rollupPart(pillar, key) {
      var s = 0, w = 0;
      units.forEach(function (u) {
        var part = u[pillar].filter(function (x) { return x.key === key; })[0];
        if (!part || part.parked || part.score == null) return;
        s += part.score * u.weight; w += u.weight;
      });
      return w ? s / w : null;
    }

    /* ---- scope-level metrics: stability, pacing, coverage --------------- */
    /* Acceptance stability: std-dev of weekly acceptance over 8 weeks. */
    var stabRows = opts._light ? null : D.queryLeads({
      partnerId: pid, from: D.addDays(asOf, -55), to: asOf,
      campaignId: opts.campaignId, subid: opts.subid
    });
    var stabilityStd = null;
    if (stabRows && stabRows.length) {
      var weeks = {};
      stabRows.forEach(function (r) {
        var wk = Math.floor((asOf - r.receivedAt) / (7 * 864e5));
        (weeks[wk] = weeks[wk] || { raw: 0, paid: 0 });
        weeks[wk].raw++;
        if (r.status === 'paid') weeks[wk].paid++;
      });
      var weekly = Object.keys(weeks).map(function (k) { return weeks[k]; })
        .filter(function (w) { return w.raw >= 20; })
        .map(function (w) { return w.paid / w.raw; });
      if (weekly.length >= 4) stabilityStd = stdev(weekly);
    }

    var daily = D.dailySeries(rows, range);
    var cv = coefficientOfVariation(daily.map(function (d) { return d.raw; }));
    var coverageStateCount = 0;
    rows.forEach(function (r) { if (D.isCoverageState(r.state)) coverageStateCount++; });
    var stateShare = rows.length ? coverageStateCount / rows.length : 0;

    /* ---- compliance — inputs are admin/systems the tech team is building.
       All null today → every part parked, pillar renormalised away, gate
       inactive. The moment any input lands it starts counting. ------------ */
    var comp = D.complianceFor(pid);
    var compParts = [
      { key: 'consent', label: 'Consent certificate coverage', weight: 0.30,
        parked: comp.consentPct == null,
        score: comp.consentPct == null ? null : norm(comp.consentPct, 0.85, 1.0),
        display: comp.consentPct == null ? 'not yet collected' : pct(comp.consentPct) },
      { key: 'complaints', label: 'Complaint incidents (90d)', weight: 0.30,
        parked: comp.incidents == null,
        score: comp.incidents == null ? null : norm(2 - comp.incidents.length, 0, 2),
        display: comp.incidents == null ? 'not yet collected' : String(comp.incidents.length) },
      { key: 'creatives', label: 'Creative review current', weight: 0.25,
        parked: comp.creativesCurrent == null,
        score: comp.creativesCurrent == null ? null : (comp.creativesCurrent ? 100 : 0),
        display: comp.creativesCurrent == null ? 'not yet collected'
          : (comp.creativesCurrent ? 'Yes' : 'No') },
      { key: 'unsub', label: 'Unsubscribe compliance (email)', weight: 0.15,
        parked: comp.unsubOk == null,
        score: comp.unsubOk == null ? null : (comp.unsubOk ? 100 : 0),
        display: comp.unsubOk == null ? 'not yet collected' : (comp.unsubOk ? 'OK' : 'Failing') }
    ];
    var gate = null;
    if (comp.incidents && comp.incidents.some(function (i) { return i.severity === 'critical' && !i.resolved; })) {
      gate = 'An unresolved critical compliance incident caps this score at ' + GATE_CAP + '.';
    } else if (comp.creativesCurrent === false) {
      gate = 'Creatives are running without a current compliance review — score capped at ' + GATE_CAP + '.';
    } else if (comp.unsubOk === false) {
      gate = 'Unsubscribe compliance is failing — score capped at ' + GATE_CAP + '.';
    }

    /* ---- assemble pillars ---------------------------------------------- */
    var domCls = units.length
      ? units.slice().sort(function (a, b) { return b.weight - a.weight; })[0].cls
      : 'fresh';

    var convParts = ['ph', 'topTier', 'sold', 'cycle'].map(function (k) {
      var proto = units.length ? units[0].conv.filter(function (x) { return x.key === k; })[0] : null;
      var s = rollupPart('conv', k);
      var av = campaignMetricValues(m);
      var disp = { ph: pct(av.ph), topTier: av.topTier == null ? '—' : pct(av.topTier),
                   sold: pct(av.sold), cycle: av.cycle == null ? '—' : av.cycle + 'd' }[k];
      return { key: k, label: proto ? proto.label : k,
        weight: { ph: 0.45, topTier: 0.20, sold: 0.20, cycle: 0.15 }[k],
        score: s, parked: s == null, display: disp };
    });

    var av2 = campaignMetricValues(m);
    var stabilityScore = stabilityStd == null ? null
      : percentileScore(domCls, 'stability', stabilityStd);
    var qualParts = [
      { key: 'badcontact', label: 'Bad-contact rate', weight: 0.24, parked: true, score: null,
        display: 'needs the call-outcome feed' },
      { key: 'ipqs', label: 'Contact-validation rejects', weight: 0.22,
        score: rollupPart('qual', 'ipqs'), display: pct(av2.ipqs) },
      { key: 'dupe', label: 'Duplicate rate', weight: 0.20,
        score: rollupPart('qual', 'dupe'), display: pct(av2.dupe) },
      { key: 'accept', label: 'Acceptance rate (banded)', weight: 0.20,
        score: rollupPart('qual', 'accept'), display: pct(av2.accept) },
      { key: 'stability', label: 'Acceptance stability', weight: 0.14,
        parked: stabilityScore == null, score: stabilityScore,
        display: stabilityStd == null ? '—' : '±' + (stabilityStd * 100).toFixed(1) + 'pp weekly' }
    ];
    qualParts.forEach(function (p) { if (p.score == null) p.parked = true; });
    convParts.forEach(function (p) { if (p.score == null) p.parked = true; });

    var consParts = [
      { key: 'pacing', label: 'Day-to-day pacing', weight: 0.55,
        score: percentileScore(domCls, 'pacing', cv),
        display: 'CV ' + cv.toFixed(2) },
      { key: 'stateFit', label: 'Volume in needed states', weight: 0.45,
        score: percentileScore(domCls, 'stateFit', stateShare),
        display: pct(stateShare) },
      /* Blocked on time-of-day landing in the export — ADMIN-MAPPING A1. */
      { key: 'windowFit', label: 'Send-window fit', weight: 0.0, parked: true, score: null,
        display: 'needs time of day on the export' }
    ];

    var compScore = weightedAvg(compParts);
    var pillars = [
      { key: 'conversion', label: 'Conversion & value', weight: 0.40,
        parts: convParts, score: weightedAvg(convParts) },
      { key: 'quality', label: 'Delivered quality', weight: 0.35,
        parts: qualParts, score: weightedAvg(qualParts) },
      { key: 'compliance', label: 'Compliance & trust', weight: 0.15,
        parts: compParts, score: compScore, parked: compScore == null,
        note: 'The systems that feed this pillar are being built. Until they land it is left ' +
              'out of your score entirely rather than counted against you.' },
      { key: 'consistency', label: 'Consistency & coverage', weight: 0.10,
        parts: consParts, score: weightedAvg(consParts) }
    ];

    var live = pillars.filter(function (p) { return !p.parked && p.score != null; });
    var liveWeight = live.reduce(function (a, p) { return a + p.weight; }, 0);
    live.forEach(function (p) { p.effectiveWeight = p.weight / liveWeight; });

    var base = live.reduce(function (a, p) { return a + p.score * p.effectiveWeight; }, 0);
    var final = Math.max(0, Math.min(100, base));
    if (gate) final = Math.min(final, GATE_CAP);
    var rounded = Math.round(final);

    /* ---- early-warning flags (fast signals vs own baseline) ------------- */
    var flags = [];
    if (!opts._light && stabRows) {
      var wkAgo = D.addDays(asOf, -6);
      var recent = { raw: 0, paid: 0, dupe: 0, ipqs: 0 };
      var basePeriod = { raw: 0, paid: 0, dupe: 0, ipqs: 0 };
      stabRows.forEach(function (r) {
        var b = r.receivedAt >= wkAgo ? recent : basePeriod;
        b.raw++;
        if (r.status === 'paid') b.paid++;
        if (r.rejectReason === 'duplicate') b.dupe++;
        if (r.rejectReason === 'ipqs') b.ipqs++;
      });
      if (recent.raw >= 30 && basePeriod.raw >= 100) {
        var rAcc = recent.paid / recent.raw, bAcc = basePeriod.paid / basePeriod.raw;
        var rDup = recent.dupe / recent.raw, bDup = basePeriod.dupe / basePeriod.raw;
        var rIpq = recent.ipqs / recent.raw, bIpq = basePeriod.ipqs / basePeriod.raw;
        if (bAcc - rAcc >= 0.10) flags.push({
          key: 'accept-drop', label: 'Acceptance falling',
          detail: 'Acceptance this week is ' + pct(rAcc) + ' against your recent ' + pct(bAcc) +
            '. The score has not moved yet — matured windows lag — but this is worth a look now.' });
        if (rDup >= bDup * 2 && rDup - bDup >= 0.03) flags.push({
          key: 'dupe-spike', label: 'Duplicate spike',
          detail: 'Duplicates this week are ' + pct(rDup) + ' against your recent ' + pct(bDup) +
            '. Check your suppression-file screening before sending more.' });
        if (rIpq >= bIpq * 2 && rIpq - bIpq >= 0.03) flags.push({
          key: 'ipqs-spike', label: 'Contact-validation spike',
          detail: 'Validation rejects this week are ' + pct(rIpq) + ' against your recent ' +
            pct(bIpq) + '. A new source or form change is the usual cause.' });
      }
    }

    /* ---- per-campaign summary for the campaign view --------------------- */
    var campaignScores = opts._light ? [] : units.map(function (u) {
      /* Campaign score = the two campaign-grain pillars, renormalised. */
      var cs = null;
      if (u.convScore != null && u.qualScore != null) {
        cs = (u.convScore * 0.40 + u.qualScore * 0.35) / 0.75;
      } else if (u.convScore != null) cs = u.convScore;
      else if (u.qualScore != null) cs = u.qualScore;
      var r = cs == null ? null : Math.round(gate ? Math.min(cs, GATE_CAP) : cs);
      return {
        campaign: u.campaign, cls: u.cls, clsLabel: CLASS_LABEL[u.cls],
        raw: u.m.raw, paid: u.m.paid, maturePaid: u.m.maturePaid,
        provisional: u.m.maturePaid < 100,
        score: r, tier: r == null ? null : tierFor(r),
        conv: u.conv, qual: u.qual,
        convScore: u.convScore == null ? null : Math.round(u.convScore),
        qualScore: u.qualScore == null ? null : Math.round(u.qualScore)
      };
    }).sort(function (a, b) { return b.raw - a.raw; });

    return {
      score: rounded,
      tier: tierFor(rounded),
      pillars: pillars,
      gate: gate,
      flags: flags,
      provisional: m.maturePaid < 100,
      maturePaid: m.maturePaid,
      metrics: m,
      range: range,
      rows: rows,
      campaigns: campaignScores,
      classLabel: CLASS_LABEL[domCls]
    };
  }

  /* 13 weekly readings — the 90-day trend, exactly how the weekly refresh
     behaves. _light skips flags and the campaign table for speed. */
  function trend(opts) {
    var points = [];
    for (var w = 12; w >= 0; w--) {
      var end = D.addDays(D.TODAY, -w * 7);
      var s = score({
        partnerId: opts.partnerId,
        campaignId: opts.campaignId,
        subid: opts.subid,
        range: { from: D.addDays(end, -29), to: end },
        asOf: end,
        _light: true
      });
      points.push({ date: end, score: s.score });
    }
    return points;
  }

  /* Severity class for a meter fill, from the same tier thresholds. */
  function meterClass(s) {
    if (s == null) return '';
    if (s >= 60) return '';
    if (s >= 45) return 'is-warning';
    if (s >= 30) return 'is-serious';
    return 'is-critical';
  }

  global.FZHealth = {
    score: score,
    trend: trend,
    tierFor: tierFor,
    meterClass: meterClass,
    classOf: classOf,
    CLASS_LABEL: CLASS_LABEL,
    GATE_CAP: GATE_CAP,
    TIERS: TIERS
  };

})(window);
