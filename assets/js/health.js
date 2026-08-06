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

  /* Parked parts are EXCLUDED and the rest renormalised — never scored zero.
     A component whose input the data cannot supply is not a failing grade,
     and treating it as one silently penalises every partner for a gap on our
     side. Same rule as the parked operations pillar, one level down. */
  function weightedAvg(parts) {
    var sum = 0, w = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].parked) continue;
      sum += parts[i].score * parts[i].weight;
      w += parts[i].weight;
    }
    return w ? sum / w : 0;
  }

  /* THIS REPORT IS READ BY THE AFFILIATE, NOT BY US.
     ----------------------------------------------------------------------
     These labels and actions were originally the internal Scale / No-Scale
     vocabulary — "Intervene", "push more budget", "move CPL to the level that
     restores a 45%+ margin". That is what WE decide about a partner, and none
     of it belongs in front of one: it exposes our margin floor, our pricing
     lever, and reads as a threat rather than as feedback.

     Every tier is now named for what is true of THEIR TRAFFIC, and every
     action is something THEY can act on. The internal thresholds are
     unchanged, so this still reconciles with the Scale/No-Scale scorecard —
     only the words a partner sees are different. `internal` is kept so our
     own tooling can still speak its own language.

     Cross-check before editing: HANDOFF.md, "affiliate-facing framing". */
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
   *   partnerId, campaignId, subid
   *   range       {from, to}   — rolling 30 days by default
   *   demandTarget {number}    — paid leads we want from this partner per window
   */
  function score(opts) {
    opts = opts || {};
    var range = opts.range || {
      from: D.addDays(D.TODAY, -29),
      to: D.TODAY
    };
    /* Volume reference for the "Volume vs target" score component.
       CPL targets are weekly and account for ACCEPTED leads (see
       cplWeeklyProgress in data.js) — not the right shape for a 30-day RAW
       submission count. Revenue-share partners have no target at all by
       design: "more is generally better," governed only by this score, not
       by a number they're expected to hit.

       So the reference here is always SELF-referential — this partner's own
       trailing 4-week average, scaled to 30 days — for both comp models.
       That is also just a better question for a health score to ask than "did
       you hit an admin's number": "are you sending more or less than your own
       recent normal," which rewards real growth without requiring a target to
       exist at all. Falls back to a flat 900 only when there is no history
       yet to be self-referential against. */
    var demandTarget = opts.demandTarget;
    if (!demandTarget) {
      var selfBaseline = D.avgWeeklyVolume(opts.partnerId) * (30 / 7);
      demandTarget = selfBaseline > 0 ? Math.round(selfBaseline) : 900;
    }

    var rows = D.queryLeads({
      partnerId: opts.partnerId || 'ahg',
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
      partnerId: opts.partnerId,
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
      /* Parked whenever margin is not computable from the source. With the
         real export it never is: Lead Cost is the $1 phantom COGS, so any
         margin derived from it is fiction. Parked, not zero. */
      { key: 'margin',  label: 'Margin', weight: 0.35, internal: true,
        parked: !internal.marginUsable,
        score: internal.marginUsable ? norm(internal.marginPct, 0.25, 0.60) : 0 },
      /* Deliberately always the ACCEPTED-lead basis, for every partner type.
         The RevShare overview reports conversion against all submitted leads
         because that is how they are paid — but the tier thresholds below are
         calibrated on the accepted basis, and scoring RevShare partners on
         the lower all-leads rate would push them a tier down for no reason
         other than a change of denominator. Labelled so the two pages read as
         two different questions rather than a contradiction. */
      { key: 'phrate',  label: 'Priority/Hot conversion (of accepted)', weight: 0.30,
        score: norm(m.priorityHotRate, 0.04, 0.18),
        display: pct(m.priorityHotRate) },
      /* The point system (Priority 10 / Hot 8 / Auction & Marketplace
         negative) is OUR scoring shorthand. A partner reading "0.02 points
         per paid lead" learns nothing, so this shows the thing the points
         actually measure: how much of what sold landed in the top two tiers. */
      { key: 'points',  label: 'Share of sales in the top tiers', weight: 0.20,
        score: norm(m.pointsPerPaid, -0.5, 1.6),
        display: m.soldAny
          ? pct((m.soldPriorityHot + m.soldNewTiers) / m.soldAny)
          : '—' },
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
        parked: !internal.badContactUsable,
        score: internal.badContactUsable ? norm(0.22 - internal.badContactRate, 0, 0.18) : 0 },
      { key: 'clawback', label: 'Clawback / over-unfire rate', weight: 0.14, internal: true,
        score: norm(0.14 - internal.clawbackRate, 0, 0.12) }
    ];

    /* ---- Pillar 3 — Speed & operations (~10%) — PARKED ----------------- */
    var opsParts = [
      { key: 'speed',    label: 'How fast we call your leads', weight: 0.60, parked: true, display: 'not yet reported' },
      { key: 'attempts', label: 'How many times we call them', weight: 0.40, parked: true, display: 'not yet reported' }
    ];

    /* ---- Pillar 4 — Volume & coverage (~10%) --------------------------- */
    var daily = D.dailySeries(rows, range);
    var dailyCounts = daily.map(function (d) { return d.raw; });
    var cv = coefficientOfVariation(dailyCounts);

    /* Three coverage gaps, and they are different kinds of gap:
         GEOGRAPHY — states carrying unfilled budget. Pacific and Mountain are
           the standing shortfall, so they dominate.
         TIME OF DAY — the two ideal reception windows, 9–11a and 3–7p
           consumer local time. These are the hours the floor is busiest and
           where leads convert best.
         DAY OF WEEK — how close their weekly split runs to the ideal split.
           Sunday volume is the usual culprit: nothing sent Sunday is worked
           until Monday morning.

       NOTE: an earlier version of this scored a 6–9a "early arrival" window.
       That window was invented and contradicted the call-centre hours (the
       floor opens at 9a), so it is gone. Do not reintroduce it. */
    var coverageStateCount = 0, idealWindowCount = 0, haveClock = 0;
    for (var i = 0; i < rows.length; i++) {
      if (D.isCoverageState(rows[i].state)) coverageStateCount++;
      if (rows[i].hourSegment) haveClock++;
      if (D.isIdealSegment(rows[i].hourSegment)) idealWindowCount++;
    }
    var coverageStateShare = rows.length ? coverageStateCount / rows.length : 0;
    /* If the source carries no clock, the window component is unknowable.
       Measure it over the rows that DO have one, and drop it from the score
       entirely when none do — scoring an absent field as zero would penalise
       a partner for a gap in our export. */
    var idealWindowShare = haveClock ? idealWindowCount / haveClock : 0;

    /* Day-of-week alignment as total variation distance from the ideal split:
       half the sum of absolute deltas, so 0 = identical and 1 = disjoint. */
    var split = D.dowSplit(rows);
    var tvd = split.reduce(function (a, d) { return a + Math.abs(d.delta); }, 0) / 2;
    var dowAlignment = 1 - tvd;

    var TARGET_STATES = 0.28;
    var TARGET_IDEAL_WINDOW = 0.50;
    var TARGET_DOW_ALIGNMENT = 0.90;

    var coverageParts = [
      norm(coverageStateShare, 0.05, TARGET_STATES),
      norm(dowAlignment, 0.60, TARGET_DOW_ALIGNMENT)
    ];
    if (haveClock) coverageParts.push(norm(idealWindowShare, 0.20, TARGET_IDEAL_WINDOW));
    var coverageScore = coverageParts.reduce(function (a, b) { return a + b; }, 0) / coverageParts.length;

    var volParts = [
      /* Compare LIKE WITH LIKE. `TARGETS.volume` is a submitted-lead target —
         it drives the targets card and the dashed line on Leads by day, both
         of which count raw volume. Scoring accepted leads against it silently
         penalised every partner by their rejection rate on top of the volume
         they actually sent. */
      { key: 'sufficiency', label: 'Volume vs target', weight: 0.40,
        score: norm(m.raw / demandTarget, 0.30, 1.0),
        display: m.raw.toLocaleString('en-US') + ' of ' + demandTarget.toLocaleString('en-US') + ' leads' },
      { key: 'consistency', label: 'Day-to-day consistency', weight: 0.25,
        score: norm(1 - cv, 0.30, 0.85),
        display: 'CV ' + cv.toFixed(2) },
      { key: 'coverage', label: 'State, window & day coverage', weight: 0.35,
        score: coverageScore,
        display: pct(coverageStateShare) + ' short states · ' +
                 (haveClock ? pct(idealWindowShare) + ' in ideal windows · ' : '') +
                 pct(dowAlignment) + ' day-split match' }
    ];

    /* ---- Pillars ------------------------------------------------------- */
    var pillars = [
      /* Pillar names are what the affiliate is being measured ON, not our
         internal category names. "Economics" in particular read as OUR
         economics, which is precisely what they must not be scored against
         in public. The note about a hidden margin input is gone for the same
         reason — telling a partner they are graded on a number we will not
         show them invites exactly one question, and it is not a good one. */
      { key: 'economics', label: 'Conversion & value', weight: 0.50, parts: econParts,
        score: weightedAvg(econParts) },
      { key: 'quality', label: 'Lead quality & consistency', weight: 0.30, parts: qualParts,
        score: weightedAvg(qualParts) },
      { key: 'operations', label: 'How we work your leads', weight: 0.10, parts: opsParts,
        score: null, parked: true,
        note: 'Not scored yet — we are not reporting call timing back to you, so it is left ' +
              'out of your score entirely rather than counted against you.' },
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
      rows: rows,
      coverage: {
        stateShare: coverageStateShare,
        stateTarget: TARGET_STATES,
        idealWindowShare: idealWindowShare,
        idealWindowTarget: TARGET_IDEAL_WINDOW,
        dowAlignment: dowAlignment,
        dowAlignmentTarget: TARGET_DOW_ALIGNMENT,
        dowSplit: split
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
        partnerId: opts.partnerId,
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

  /**
   * The three coverage widgets, as data.
   *
   * These are ASKS, not rules. We accept leads any day and any hour — see
   * D.COVERAGE_NOTE, which every rendering of these must carry. Weighting a
   * partner's sends this way gets faster contact and a cleaner read on their
   * traffic; it does not gate anything.
   */
  function coverage(result, opts) {
    opts = opts || {};
    var c = result.coverage;

    /* 1. States carrying unfilled budget, richest first. */
    var states = D.stateDemand({ limit: opts.stateLimit || 6 });
    var runsWestern = states.some(function (s) { return s.western; });

    /* 2. Arrival windows — their actual split, with the two ideal ones
          flagged. Rendered from the same rows the score was built on. */
    var windows = D.windowSplit(result.rows || []);

    /* 3. Day-of-week split against the ideal. */
    var days = c.dowSplit;

    return {
      note: D.COVERAGE_NOTE,
      operatingHours: D.OPERATING_HOURS,
      states: {
        rows: states,
        totalUnused: states.reduce(function (a, s) { return a + s.unusedBudget; }, 0),
        totalLeads: states.reduce(function (a, s) { return a + s.leadsNeeded; }, 0),
        share: c.stateShare,
        target: c.stateTarget,
        onTarget: c.stateShare >= c.stateTarget
      },
      windows: {
        rows: windows,
        ideal: D.IDEAL_WINDOWS,
        share: c.idealWindowShare,
        target: c.idealWindowTarget,
        onTarget: c.idealWindowShare >= c.idealWindowTarget,
        /* Only surfaced when the partner actually runs western states —
           Saturday closes at 8p ET, which is 5p Pacific. */
        westernCaveat: runsWestern ? D.OPERATING_HOURS.saturdayWestCaveat : null
      },
      days: {
        rows: days,
        alignment: c.dowAlignment,
        target: c.dowAlignmentTarget,
        onTarget: c.dowAlignment >= c.dowAlignmentTarget,
        /* The single biggest deviation, so the card can lead with it. */
        worst: days.slice().sort(function (a, b) {
          return Math.abs(b.delta) - Math.abs(a.delta);
        })[0] || null
      }
    };
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
    coverage: coverage,
    tierFor: tierFor,
    meterClass: meterClass,
    TIERS: TIERS
  };

})(window);
