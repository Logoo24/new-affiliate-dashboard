/* ==========================================================================
   health.js — the Lead Health Score engine
   --------------------------------------------------------------------------
   Renders the framework in Affiliate_Lead_Health_System_Framework.md; it does
   not redefine it. Four pillars, weighted, normalised 0–100 against targets,
   with direct penalties for clawback and bad-contact rate.

     Economics              ~50%   (matured margin vs the 45% floor,
                                    Priority/Hot points, sold %, sales cycle)
     Delivered quality      ~30%   (acceptance, clawback, bad contact,
                                    duplicate rate, contact-validation rejects)
     Speed & operations     ~10%   PARKED — speed-to-lead and call-attempts
                                   are not on the lead table yet (spec §5)
     Volume & coverage      ~10%   (sufficiency, consistency, coverage gaps)

   PARKED PILLAR HANDLING: rather than score operations as zero — which would
   cap every partner at 90 and make the whole score look broken — the pillar is
   excluded and the remaining three are renormalised to 100. The UI shows it as
   parked so nobody mistakes the gap for a passing grade. When Zakira lands the
   two fields, set parked:false and the weights snap back on their own.

   ON THE MARGIN INPUT (open question §9.4): the affiliate sees the SAME number
   we do, and the Economics pillar does include margin. What they do not get is
   the margin figure itself or the weight on it, so the score cannot be
   reverse-engineered into our economics. Michael, Jul 7: "all you're doing is
   you're giving them a number." The internal margin value is read here and
   converted to a sub-score in this file — it is never attached to any object
   the view layer touches.
   ========================================================================== */

(function (global) {
  'use strict';

  var D = global.FZData;

  /* Linear normalisation to 0–100 with clamping. */
  function norm(value, worst, best) {
    if (value == null || isNaN(value)) return 0;
    var t = (value - worst) / (best - worst);
    return Math.max(0, Math.min(100, t * 100));
  }

  function weightedAvg(parts) {
    var sum = 0, w = 0;
    for (var i = 0; i < parts.length; i++) {
      sum += parts[i].score * parts[i].weight;
      w += parts[i].weight;
    }
    return w ? sum / w : 0;
  }

  var TIERS = [
    { key: 'scale',     label: 'Scale',     min: 80, badge: 'badge-good', tone: 'good',
      action: 'Push more budget. Candidate for a higher CPL or a better comp model.' },
    { key: 'healthy',   label: 'Healthy',   min: 60, badge: 'badge-info', tone: 'info',
      action: 'Hold allocation. Watch the trend week over week.' },
    { key: 'watch',     label: 'Watch',     min: 45, badge: 'badge-warn', tone: 'warning',
      action: 'Slow if margin is drifting toward the floor. Creative review and a list-quality conversation.' },
    { key: 'intervene', label: 'Intervene', min: 0,  badge: 'badge-crit', tone: 'critical',
      action: 'Two options: pause, or move CPL to the level that restores a 45%+ margin.' }
  ];

  function tierFor(score) {
    for (var i = 0; i < TIERS.length; i++) {
      if (score >= TIERS[i].min) return TIERS[i];
    }
    return TIERS[TIERS.length - 1];
  }

  /* Coefficient of variation on daily volume — the consistency component. */
  function coefficientOfVariation(values) {
    if (values.length < 2) return 1;
    var mean = values.reduce(function (a, b) { return a + b; }, 0) / values.length;
    if (!mean) return 1;
    var variance = values.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  /**
   * Score a window.
   *
   * @param {object} opts
   *   partnerType, campaignId, subid
   *   range       {from, to}   — rolling 30 days by default
   *   demandTarget {number}    — paid leads we want from this partner per window
   */
  function score(opts) {
    opts = opts || {};
    var range = opts.range || {
      from: D.addDays(D.TODAY, -29),
      to: D.TODAY
    };
    var demandTarget = opts.demandTarget || 900;

    var rows = D.queryLeads({
      partnerType: opts.partnerType || 'revshare',
      from: range.from,
      to: range.to,
      campaignId: opts.campaignId,
      subid: opts.subid
    });

    var m = D.computeMetrics(rows, opts.asOf || D.TODAY);

    /* Internal-only inputs. Read here, converted to sub-scores here, and
       never returned on the result object. */
    var internal = D._internalAggregates({
      range: range,
      campaignId: opts.campaignId,
      subid: opts.subid
    });

    /* ---- Rates the quality pillar needs ------------------------------- */
    var dupeCount = m.rejects.duplicate || 0;
    var ipqsCount = m.rejects.ipqs || 0;
    var duplicateRate = m.raw ? dupeCount / m.raw : 0;
    var ipqsRate = m.raw ? ipqsCount / m.raw : 0;

    /* ---- Pillar 1 — Economics (~50%) ---------------------------------- */
    var econParts = [
      { key: 'margin',  label: 'Margin vs 45% floor', weight: 0.35, internal: true,
        score: norm(internal.marginPct, 0.25, 0.60) },
      { key: 'phrate',  label: 'Priority/Hot conversion', weight: 0.30,
        score: norm(m.priorityHotRate, 0.04, 0.18),
        display: pct(m.priorityHotRate) },
      { key: 'points',  label: 'Sold-type points per paid lead', weight: 0.20,
        score: norm(m.pointsPerPaid, -0.5, 1.6),
        display: m.pointsPerPaid.toFixed(2) },
      { key: 'cycle',   label: 'Median sales cycle', weight: 0.15,
        score: m.medianCycle == null ? 0 : norm(20 - m.medianCycle, 0, 12),
        display: m.medianCycle == null ? '—' : m.medianCycle + 'd' }
    ];

    /* ---- Pillar 2 — Delivered quality & stability (~30%) --------------- */
    var qualParts = [
      { key: 'accept',  label: 'Acceptance rate', weight: 0.30,
        score: norm(m.acceptanceRate, 0.40, 0.85),
        display: pct(m.acceptanceRate) },
      { key: 'dupe',    label: 'Duplicate rate', weight: 0.22,
        score: norm(0.20 - duplicateRate, 0, 0.18),
        display: pct(duplicateRate) },
      { key: 'ipqs',    label: 'Contact-validation rejects', weight: 0.18,
        score: norm(0.15 - ipqsRate, 0, 0.13),
        display: pct(ipqsRate) },
      { key: 'badcontact', label: 'Bad-contact rate', weight: 0.16, internal: true,
        score: norm(0.22 - internal.badContactRate, 0, 0.18) },
      { key: 'clawback', label: 'Clawback / over-unfire rate', weight: 0.14, internal: true,
        score: norm(0.14 - internal.clawbackRate, 0, 0.12) }
    ];

    /* ---- Pillar 3 — Speed & operations (~10%) — PARKED ----------------- */
    var opsParts = [
      { key: 'speed',    label: 'Speed to lead', weight: 0.60, parked: true, display: 'awaiting field' },
      { key: 'attempts', label: 'Call attempts to convert', weight: 0.40, parked: true, display: 'awaiting field' }
    ];

    /* ---- Pillar 4 — Volume & coverage (~10%) --------------------------- */
    var daily = D.dailySeries(rows, range);
    var dailyCounts = daily.map(function (d) { return d.raw; });
    var cv = coefficientOfVariation(dailyCounts);

    var westernCount = 0, eveningCount = 0;
    for (var i = 0; i < rows.length; i++) {
      if (D.WESTERN[rows[i].state]) westernCount++;
      if (rows[i].hourSegment === 'evening' || rows[i].hourSegment === 'late') eveningCount++;
    }
    var westernShare = rows.length ? westernCount / rows.length : 0;
    var eveningShare = rows.length ? eveningCount / rows.length : 0;

    var TARGET_WESTERN = 0.22;
    var TARGET_EVENING = 0.25;
    var coverageScore = (norm(westernShare, 0.05, TARGET_WESTERN) +
                         norm(eveningShare, 0.05, TARGET_EVENING)) / 2;

    var volParts = [
      { key: 'sufficiency', label: 'Volume vs demand', weight: 0.40,
        score: norm(m.paid / demandTarget, 0.30, 1.0),
        display: m.paid + ' / ' + demandTarget },
      { key: 'consistency', label: 'Day-to-day consistency', weight: 0.25,
        score: norm(1 - cv, 0.30, 0.85),
        display: 'CV ' + cv.toFixed(2) },
      { key: 'coverage', label: 'State & hour coverage', weight: 0.35,
        score: coverageScore,
        display: pct(westernShare) + ' west · ' + pct(eveningShare) + ' evening' }
    ];

    /* ---- Pillars ------------------------------------------------------- */
    var pillars = [
      { key: 'economics', label: 'Economics', weight: 0.50, parts: econParts,
        score: weightedAvg(econParts),
        note: 'Includes an internal margin input that is not shown here.' },
      { key: 'quality', label: 'Delivered quality & stability', weight: 0.30, parts: qualParts,
        score: weightedAvg(qualParts) },
      { key: 'operations', label: 'Speed & operations', weight: 0.10, parts: opsParts,
        score: null, parked: true,
        note: 'Parked until speed-to-lead and call-attempt fields land on the lead table.' },
      { key: 'volume', label: 'Volume & coverage', weight: 0.10, parts: volParts,
        score: weightedAvg(volParts) }
    ];

    /* Renormalise across the live pillars only. */
    var live = pillars.filter(function (p) { return !p.parked; });
    var liveWeight = live.reduce(function (a, p) { return a + p.weight; }, 0);
    live.forEach(function (p) { p.effectiveWeight = p.weight / liveWeight; });

    var base = live.reduce(function (a, p) { return a + p.score * p.effectiveWeight; }, 0);

    /* ---- Direct penalties ---------------------------------------------- */
    var penalties = [];
    if (internal.clawbackRate > 0.10) {
      penalties.push({ label: 'Elevated clawback rate', points: 5 });
    }
    if (internal.badContactRate > 0.20) {
      penalties.push({ label: 'Elevated bad-contact rate', points: 5 });
    }
    var penaltyTotal = penalties.reduce(function (a, p) { return a + p.points; }, 0);

    var final = Math.max(0, Math.min(100, base - penaltyTotal));
    var rounded = Math.round(final);

    /* ---- Sample gate ---------------------------------------------------- */
    var provisional = m.maturePaid < 100;

    return {
      score: rounded,
      tier: tierFor(rounded),
      pillars: pillars,
      penalties: penalties,
      provisional: provisional,
      maturePaid: m.maturePaid,
      metrics: m,
      range: range,
      coverage: {
        westernShare: westernShare,
        westernTarget: TARGET_WESTERN,
        eveningShare: eveningShare,
        eveningTarget: TARGET_EVENING
      }
    };
  }

  /**
   * 13 weekly readings, each scored over the 30 days ending that week — the
   * 90-day trend line. This is genuinely how the weekly refresh behaves, so
   * the shape of the line is the shape production will draw.
   */
  function trend(opts) {
    var points = [];
    for (var w = 12; w >= 0; w--) {
      var end = D.addDays(D.TODAY, -w * 7);
      var start = D.addDays(end, -29);
      var s = score({
        partnerType: opts.partnerType,
        campaignId: opts.campaignId,
        subid: opts.subid,
        range: { from: start, to: end },
        asOf: end,
        demandTarget: opts.demandTarget
      });
      points.push({ date: end, score: s.score });
    }
    return points;
  }

  /* Coverage asks — the "send us more of this" list. */
  function coverageAsks(result) {
    var asks = [];
    if (result.coverage.westernShare < result.coverage.westernTarget) {
      asks.push({
        what: 'Pacific & Mountain states',
        detail: 'AZ, CO, WA, OR, CA, NV, UT, ID',
        now: pct(result.coverage.westernShare),
        target: pct(result.coverage.westernTarget)
      });
    }
    if (result.coverage.eveningShare < result.coverage.eveningTarget) {
      asks.push({
        what: 'Evening & late submissions',
        detail: '6p–9p and after 9p, submitter local time',
        now: pct(result.coverage.eveningShare),
        target: pct(result.coverage.eveningTarget)
      });
    }
    return asks;
  }

  function pct(v) {
    if (v == null || isNaN(v)) return '—';
    return (v * 100).toFixed(1) + '%';
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
    coverageAsks: coverageAsks,
    tierFor: tierFor,
    meterClass: meterClass,
    TIERS: TIERS
  };

})(window);
