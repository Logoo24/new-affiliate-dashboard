/* ==========================================================================
   charts.js — hand-rolled SVG charts, no library
   --------------------------------------------------------------------------
   Deliberately dependency-free. A PHP page can emit this SVG server-side or
   let this script draw it client-side; either way there is no build step and
   nothing to vendor.

   Mark specs held to throughout:
     · columns  ≤24px thick, 4px rounded data-end, square at the baseline
     · a 2px gap IN THE SURFACE COLOUR separates stacked segments and
       neighbouring bars — never a stroke drawn around a mark
     · lines 2px, end markers r≥4 with a 2px surface ring
     · gridlines and axes are solid hairlines one step off the surface
     · axis text and value labels wear text tokens, never the series colour
     · every chart has a table-view twin, so no value is gated behind a hover
   ========================================================================== */

(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GAP = 2;               /* the surface gap, in px */
  var MAX_BAR = 24;

  /* A column chart's target can be ONE flat number (cfg.targetLine.value) or
     a PER-DAY array (cfg.targetLine.values, same length as cfg.days) — the
     latter is what a day-of-week-weighted target needs, since Sunday can
     legitimately be 0 while every other day is not. Callers that only have a
     single number keep working unchanged; day i simply reads values[i] when
     an array is supplied. Returns null when there is no target that day. */
  function targetForDay(cfg, i) {
    if (!cfg.targetLine) return null;
    if (cfg.targetLine.values) {
      var v = cfg.targetLine.values[i];
      return (v == null) ? null : v;
    }
    return cfg.targetLine.value;
  }

  /* What a target is measured AGAINST for a given day: the full stacked
     total by default, or one named series (cfg.targetLine.compareKey) when
     the target is defined in terms of a sub-segment — an accepted-lead
     target should compare against the accepted series, not accepted+
     rejected combined. */
  function compareValueForDay(cfg, d, stackTotal) {
    if (cfg.targetLine && cfg.targetLine.compareKey) return d[cfg.targetLine.compareKey] || 0;
    return stackTotal;
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) {
      if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    }
    return node;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* Resolve a series colour AT RENDER TIME, not at config time.
     Callers pass `varName: '--series-1'` rather than a literal hex, so a theme
     change (or an OS light/dark flip mid-session) repaints with that theme's
     own validated step instead of the one captured when the chart mounted. */
  function seriesColor(s) {
    return s.varName ? cssVar(s.varName) : s.color;
  }

  function niceCeil(v) {
    if (v <= 5) return 5;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      var c = steps[i] * mag;
      if (c >= v) return Math.round(c);
    }
    return Math.ceil(v / mag) * mag;
  }

  function fmtDay(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtDayFull(d) {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtInt(n) { return n.toLocaleString('en-US'); }

  /* Path for a rect whose TOP corners are rounded and bottom corners square —
     the "4px rounded data-end, square at the baseline" spec. */
  function topRoundedPath(x, y, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) +
           'L' + x + ',' + (y + r) +
           'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
           'L' + (x + w - r) + ',' + y +
           'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
           'L' + (x + w) + ',' + (y + h) + 'Z';
  }

  /* ---------------------------------------------------------------------- */
  /* Tooltip                                                                */
  /* ---------------------------------------------------------------------- */

  function makeTooltip(wrap) {
    var tip = document.createElement('div');
    tip.className = 'tooltip';
    wrap.appendChild(tip);

    return {
      show: function (html, x, y) {
        tip.innerHTML = html;
        tip.classList.add('is-on');
        var w = tip.offsetWidth, h = tip.offsetHeight;
        var left = x + 14;
        if (left + w > wrap.clientWidth) left = x - w - 14;
        if (left < 0) left = 4;
        var top = y - h - 10;
        if (top < 0) top = y + 16;
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      },
      hide: function () { tip.classList.remove('is-on'); }
    };
  }

  function tooltipRows(title, rows) {
    var html = '<div class="tt-title">' + title + '</div>';
    rows.forEach(function (r) {
      html += '<div class="tt-row">' +
        (r.color ? '<span class="sw" style="background:' + r.color + '"></span>' : '<span class="sw" style="background:transparent"></span>') +
        '<span class="k">' + r.label + '</span>' +
        '<span class="v">' + r.value + '</span></div>';
    });
    return html;
  }

  /* ---------------------------------------------------------------------- */
  /* Stacked column chart                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * @param {HTMLElement} host   .chart-wrap element
   * @param {object} cfg
   *   days   [{date, ...}]
   *   series [{key, label, color}]  drawn bottom → top
   *   yLabel string
   */
  function columns(host, cfg) {
    host.__cfg = cfg;
    host.__kind = 'columns';
    render();

    function render() {
      host.querySelectorAll('svg, .chart-table').forEach(function (n) { n.remove(); });
      if (host.__mode === 'table') { host.appendChild(buildTable(cfg)); return; }

      var W = Math.max(320, host.clientWidth || 640);
      var padL = 42, padR = 14, padT = 12, padB = 30;
      var plotH = 190;
      var H = plotH + padT + padB;
      var plotW = W - padL - padR;

      var surface = cssVar('--surface-1');
      var gridColor = cssVar('--grid');
      var axisColor = cssVar('--axis');
      var muted = cssVar('--ink-muted');

      var days = cfg.days;
      var n = days.length || 1;

      var max = 0;
      days.forEach(function (d, i) {
        var t = 0;
        cfg.series.forEach(function (s) { t += d[s.key] || 0; });
        if (t > max) max = t;
        /* Keep every day's target inside the plot — a reference mark drawn
           off the top of the chart is worse than no reference at all. */
        var tv = targetForDay(cfg, i);
        if (tv != null && tv > max) max = tv;
      });
      var yMax = niceCeil(max || 1);

      var svg = el('svg', {
        width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': cfg.ariaLabel || 'Daily column chart'
      });

      /* --- gridlines + y ticks (solid hairlines, recessive) ------------- */
      var ticks = 4;
      for (var t = 0; t <= ticks; t++) {
        var val = (yMax / ticks) * t;
        var y = padT + plotH - (val / yMax) * plotH;
        svg.appendChild(el('line', {
          x1: padL, x2: padL + plotW, y1: y, y2: y,
          stroke: t === 0 ? axisColor : gridColor, 'stroke-width': 1
        }));
        var lbl = el('text', {
          x: padL - 8, y: y + 4, 'text-anchor': 'end',
          fill: muted, 'font-size': 10.5, 'font-variant-numeric': 'tabular-nums'
        });
        lbl.textContent = fmtInt(Math.round(val));
        svg.appendChild(lbl);
      }

      /* --- bands ------------------------------------------------------- */
      var band = plotW / n;
      var barW = Math.min(MAX_BAR, Math.max(3, band - 6));

      /* x labels: thin them out until they cannot collide */
      var labelEvery = Math.max(1, Math.ceil(n / Math.floor(plotW / 58)));

      days.forEach(function (d, i) {
        var cx = padL + band * i + band / 2;
        var x = cx - barW / 2;

        /* stack bottom → top */
        var acc = 0;
        var stackTotal = 0;
        cfg.series.forEach(function (s) { stackTotal += d[s.key] || 0; });

        cfg.series.forEach(function (s, si) {
          var v = d[s.key] || 0;
          if (v <= 0) return;
          var hFull = (v / yMax) * plotH;
          var yTop = padT + plotH - ((acc + v) / yMax) * plotH;
          acc += v;

          var isTop = true;
          for (var j = si + 1; j < cfg.series.length; j++) {
            if ((d[cfg.series[j].key] || 0) > 0) { isTop = false; break; }
          }

          /* Surface gap: shave the bottom of every segment that has another
             segment beneath it, so white does the separating. */
          var hasBelow = si > 0 && acc - v > 0;
          var h = hFull - (hasBelow ? GAP : 0);
          if (h <= 0.5) return;

          var node;
          var fill = seriesColor(s);
          if (isTop) {
            node = el('path', { d: topRoundedPath(x, yTop, barW, h, 4), fill: fill });
          } else {
            node = el('rect', { x: x, y: yTop, width: barW, height: h, fill: fill });
          }
          svg.appendChild(node);
        });

        /* x label */
        if (i % labelEvery === 0 || i === n - 1) {
          var tx = el('text', {
            x: cx, y: padT + plotH + 17, 'text-anchor': 'middle',
            fill: muted, 'font-size': 10.5
          });
          tx.textContent = fmtDay(d.date);
          svg.appendChild(tx);
        }

        /* --- hit target: full-height, band-wide, invisible -------------- */
        var hit = el('rect', {
          x: padL + band * i, y: padT, width: Math.max(band, 1), height: plotH,
          fill: 'transparent', style: 'cursor:crosshair'
        });
        hit.addEventListener('mouseenter', function () {
          var rows = cfg.series.map(function (s) {
            return { color: seriesColor(s), label: s.label, value: fmtInt(d[s.key] || 0) };
          });
          if (cfg.series.length > 1) {
            rows.push({ color: null, label: 'Total', value: fmtInt(stackTotal) });
          }
          var dayTarget = targetForDay(cfg, i);
          if (dayTarget != null) {
            var cmp = compareValueForDay(cfg, d, stackTotal);
            rows.push({ color: null, label: cfg.targetLine.compareLabel || 'Target', value: fmtInt(Math.round(dayTarget)) });
            rows.push({
              color: null, label: cmp >= dayTarget ? 'Over target' : 'Under target',
              value: (cmp >= dayTarget ? '+' : '') + fmtInt(Math.round(cmp - dayTarget))
            });
          }
          host.__tip.show(tooltipRows(fmtDayFull(d.date), rows), cx, padT + plotH / 2);
          hover.setAttribute('x', padL + band * i);
          hover.setAttribute('width', Math.max(band, 1));
          hover.style.opacity = '1';
        });
        hit.addEventListener('mouseleave', function () {
          host.__tip.hide();
          hover.style.opacity = '0';
        });
        svg.appendChild(hit);
      });

      /* --- target reference ---------------------------------------------
         Dashed ON PURPOSE. The no-dashing rule applies to gridlines and axes,
         where dashing falsely implies a threshold. Here it IS a threshold, so
         the dash is what separates it from the grid it crosses.

         Drawn per DAY, not as one flat line across the whole chart. A target
         that varies by day of week — Sunday genuinely at 0 while weekdays are
         not — cannot be represented by a single height, and a flat line
         would either misstate Sunday or misstate every other day. Each day
         gets its own short tick spanning that day's band, at that day's
         target height; days are deliberately NOT connected to each other,
         since a connecting line would imply a smooth ramp between Saturday
         and Sunday that is not real — the drop is a step, not a slope. */
      if (cfg.targetLine) {
        var labelled = false;
        days.forEach(function (d, i) {
          var tv = targetForDay(cfg, i);
          if (tv == null) return;
          var ty = padT + plotH - (tv / yMax) * plotH;
          var x0 = padL + band * i + band * 0.08;
          var x1 = padL + band * (i + 1) - band * 0.08;
          svg.appendChild(el('line', {
            x1: x0, x2: x1, y1: ty, y2: ty,
            stroke: cssVar('--ink-2'), 'stroke-width': 1.5,
            'stroke-dasharray': '4 3', 'stroke-linecap': 'round'
          }));
          /* Label the first tick only — repeating it on every day would be
             the "a number on every point" anti-pattern the rest of this
             chart deliberately avoids. */
          if (!labelled) {
            labelled = true;
            var tlbl = el('text', {
              x: x0, y: ty - 6, 'text-anchor': 'start',
              fill: cssVar('--ink-2'), 'font-size': 10.5, 'font-weight': 650
            });
            tlbl.textContent = cfg.targetLine.label;
            svg.appendChild(tlbl);
          }
        });
      }

      /* hover wash sits behind the hit rects but above the bars' background */
      var hover = el('rect', {
        x: 0, y: padT, width: 0, height: plotH,
        fill: cssVar('--ink'), opacity: 0, style: 'opacity:0;transition:opacity 80ms', 'fill-opacity': 0.04
      });
      svg.insertBefore(hover, svg.firstChild);

      host.appendChild(svg);
    }

    host.__render = render;
  }

  /* ---------------------------------------------------------------------- */
  /* Line chart (single series)                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * @param {object} cfg
   *   points [{date, score}]
   *   color, yMin, yMax, bands [{from,to,color,label}]
   */
  function line(host, cfg) {
    host.__cfg = cfg;
    host.__kind = 'line';
    render();

    function render() {
      host.querySelectorAll('svg, .chart-table').forEach(function (n) { n.remove(); });
      if (host.__mode === 'table') { host.appendChild(buildLineTable(cfg)); return; }

      var W = Math.max(320, host.clientWidth || 640);
      var padL = 34, padR = 46, padT = 12, padB = 28;
      var plotH = 170;
      var H = plotH + padT + padB;
      var plotW = W - padL - padR;

      var surface = cssVar('--surface-1');
      var gridColor = cssVar('--grid');
      var axisColor = cssVar('--axis');
      var muted = cssVar('--ink-muted');
      var ink = cssVar('--ink');
      var color = cfg.colorVar ? cssVar(cfg.colorVar) : (cfg.color || cssVar('--series-1'));

      var pts = cfg.points;
      var yMin = cfg.yMin != null ? cfg.yMin : 0;
      var yMax = cfg.yMax != null ? cfg.yMax : 100;

      var svg = el('svg', {
        width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': cfg.ariaLabel || 'Trend line'
      });

      function X(i) { return padL + (pts.length === 1 ? plotW / 2 : (plotW * i) / (pts.length - 1)); }
      function Y(v) { return padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

      /* --- tier bands as a very light wash ------------------------------ */
      (cfg.bands || []).forEach(function (b) {
        var yTop = Y(b.to), yBot = Y(b.from);
        svg.appendChild(el('rect', {
          x: padL, y: yTop, width: plotW, height: Math.max(0, yBot - yTop),
          fill: seriesColor(b), 'fill-opacity': 0.07
        }));
      });

      /* --- gridlines ---------------------------------------------------- */
      [0, 25, 50, 75, 100].forEach(function (v) {
        if (v < yMin || v > yMax) return;
        var y = Y(v);
        svg.appendChild(el('line', {
          x1: padL, x2: padL + plotW, y1: y, y2: y,
          stroke: v === yMin ? axisColor : gridColor, 'stroke-width': 1
        }));
        var lbl = el('text', {
          x: padL - 7, y: y + 4, 'text-anchor': 'end',
          fill: muted, 'font-size': 10.5, 'font-variant-numeric': 'tabular-nums'
        });
        lbl.textContent = v;
        svg.appendChild(lbl);
      });

      /* --- the line, 2px, round join/cap -------------------------------- */
      var d = pts.map(function (p, i) {
        return (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(p.score).toFixed(1);
      }).join(' ');
      svg.appendChild(el('path', {
        d: d, fill: 'none', stroke: color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));

      /* --- x labels ----------------------------------------------------- */
      var labelEvery = Math.max(1, Math.ceil(pts.length / Math.floor(plotW / 62)));
      pts.forEach(function (p, i) {
        if (i % labelEvery !== 0 && i !== pts.length - 1) return;
        var tx = el('text', {
          x: X(i), y: padT + plotH + 17, 'text-anchor': 'middle',
          fill: muted, 'font-size': 10.5
        });
        tx.textContent = fmtDay(p.date);
        svg.appendChild(tx);
      });

      /* --- end marker: r≥4 with a 2px surface ring ---------------------- */
      var last = pts[pts.length - 1];
      var lx = X(pts.length - 1), ly = Y(last.score);
      svg.appendChild(el('circle', { cx: lx, cy: ly, r: 5, fill: color, stroke: surface, 'stroke-width': 2 }));

      /* direct label at the end — the one label this chart gets */
      var endLbl = el('text', {
        x: lx + 11, y: ly + 4, fill: ink, 'font-size': 12.5, 'font-weight': 650
      });
      endLbl.textContent = last.score;
      svg.appendChild(endLbl);

      /* --- crosshair + per-point hit targets ---------------------------- */
      var cross = el('line', {
        x1: 0, x2: 0, y1: padT, y2: padT + plotH,
        stroke: axisColor, 'stroke-width': 1, opacity: 0
      });
      svg.appendChild(cross);
      var focus = el('circle', {
        cx: 0, cy: 0, r: 5, fill: color, stroke: surface, 'stroke-width': 2, opacity: 0
      });
      svg.appendChild(focus);

      var slot = pts.length > 1 ? plotW / (pts.length - 1) : plotW;
      pts.forEach(function (p, i) {
        var hitW = Math.max(slot, 24);
        var hit = el('rect', {
          x: X(i) - hitW / 2, y: padT, width: hitW, height: plotH,
          fill: 'transparent', style: 'cursor:crosshair'
        });
        hit.addEventListener('mouseenter', function () {
          cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i));
          cross.setAttribute('opacity', 1);
          focus.setAttribute('cx', X(i)); focus.setAttribute('cy', Y(p.score));
          focus.setAttribute('opacity', 1);
          host.__tip.show(tooltipRows('30 days ending ' + fmtDayFull(p.date), [
            { color: color, label: cfg.seriesLabel || 'Health score', value: p.score }
          ]), X(i), Y(p.score));
        });
        hit.addEventListener('mouseleave', function () {
          cross.setAttribute('opacity', 0);
          focus.setAttribute('opacity', 0);
          host.__tip.hide();
        });
        svg.appendChild(hit);
      });

      host.appendChild(svg);
    }

    host.__render = render;
  }

  /* ---------------------------------------------------------------------- */
  /* Gauge — the health-score dial                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * One dial, shared by the Partnership summary and the Health scorecard so
   * the two can never drift apart. Recessive axis arc, tick marks every 10
   * points with majors at 0/50/100, a tapered needle in the caller-supplied
   * severity colour, score + tier badge beneath.
   *
   * @param cfg.score      0–100
   * @param cfg.tier       {label, badge}
   * @param cfg.sevSuffix  '' | '-warning' | '-serious' | '-critical'
   * @param cfg.scale      overall size multiplier (default 1)
   * @param cfg.hint       optional muted line under the badge
   * @param cfg.extraHtml  optional HTML appended inside the value row (e.g. a tip button)
   */
  function gauge(host, cfg) {
    var k = cfg.scale || 1;
    var needleColor = cssVar('--meter-fill' + (cfg.sevSuffix || ''));
    var axis = cssVar('--axis');
    var muted = cssVar('--ink-muted');
    var surface = cssVar('--surface-1');

    var W = Math.round(224 * k), HGT = Math.round(132 * k);
    var cx = W / 2, cy = Math.round(116 * k), R = Math.round(92 * k);

    function pt(t, r) {
      var a = Math.PI * (1 - t);
      return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    }
    function f(n) { return n.toFixed(1); }

    var svg = '';
    var a0 = pt(0, R), a1 = pt(1, R);
    svg += '<path d="M' + f(a0[0]) + ',' + f(a0[1]) + ' A' + R + ',' + R + ' 0 1,1 ' +
      f(a1[0]) + ',' + f(a1[1]) + '" fill="none" stroke="' + axis + '" stroke-width="3"/>';

    for (var i = 0; i <= 10; i++) {
      var t = i / 10;
      var major = (i === 0 || i === 5 || i === 10);
      var o = pt(t, R - 4 * k), n2 = pt(t, R - (major ? 16 : 11) * k);
      svg += '<line x1="' + f(o[0]) + '" y1="' + f(o[1]) + '" x2="' + f(n2[0]) + '" y2="' + f(n2[1]) +
        '" stroke="' + muted + '" stroke-width="' + (major ? 2 : 1.25) + '"/>';
    }
    svg += '<text x="' + f(cx - R) + '" y="' + (cy + 14) + '" text-anchor="middle" fill="' + muted + '" font-size="11">0</text>' +
           '<text x="' + f(cx + R) + '" y="' + (cy + 14) + '" text-anchor="middle" fill="' + muted + '" font-size="11">100</text>';

    var tScore = Math.max(0, Math.min(1, cfg.score / 100));
    var tipPt = pt(tScore, R - 22 * k);
    var ang = Math.PI * (1 - tScore);
    var px = Math.sin(ang) * 4, py = Math.cos(ang) * 4;
    svg += '<polygon points="' +
        f(cx - px) + ',' + f(cy - py) + ' ' +
        f(cx + px) + ',' + f(cy + py) + ' ' +
        f(tipPt[0]) + ',' + f(tipPt[1]) + '" fill="' + needleColor + '"/>';
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="7" fill="' + needleColor +
      '" stroke="' + surface + '" stroke-width="2"/>';

    host.innerHTML =
      '<div class="gauge-wrap">' +
      /* WIDTH IS FLUID, the viewBox does the scaling. The dial used to render
         at a fixed 224px whatever it was dropped into, which left it looking
         shrunken in the Partnership summary card — a small drawing floating
         in a lot of empty card. It now fills the card up to a sensible cap,
         so the same component reads right at both sizes. */
      '<svg viewBox="0 0 ' + W + ' ' + HGT + '" role="img" ' +
        'style="width:100%;max-width:' + W + 'px;height:auto" ' +
        'aria-label="Health score ' + cfg.score + ' out of 100, ' + cfg.tier.label + '">' + svg + '</svg>' +
      '<div style="display:flex;align-items:baseline;gap:10px;margin-top:10px">' +
        '<span class="gauge-value">' + cfg.score + '</span>' +
        '<span class="badge ' + cfg.tier.badge + '"><span class="dot"></span>' + cfg.tier.label + '</span>' +
        (cfg.extraHtml || '') +
      '</div>' +
      (cfg.hint ? '<div class="gauge-hint">' + cfg.hint + '</div>' : '') +
      '</div>';
  }

  /* ---------------------------------------------------------------------- */
  /* Bars — ranked horizontal magnitude                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * A ranked horizontal bar chart, for the case a pie handles badly: many
   * categories where most of the tail is small.
   *
   * WHY THIS EXISTS. The rejection breakdown used a pie. With three reasons
   * carrying 96% of the volume and a long tail under 2% each, every tail
   * slice collapsed to a hairline — the chart read as a couple of wedges and
   * a fan of lines, and only slices over 8% could hold a label at all, so the
   * rest of the reading happened in the legend. A ranked bar gives every row
   * the same height whatever its share, puts the name and the number ON the
   * row, and grows down rather than out, so it fits a card without a 520px
   * square.
   *
   * The ramp is the same ordinal blue as the pie (darkest = biggest), so the
   * two views of the same data stay recognisably the same data. Order is the
   * ranking, which is the whole point — do not re-sort by name.
   *
   * @param cfg.bars       [{label, value}]
   * @param cfg.total      denominator for the share text (defaults to the sum)
   * @param cfg.maxBars    keep the top N, fold the rest into "Other" (default 12)
   * @param cfg.valueLabel noun for the tooltip row (default 'Leads')
   * @param cfg.onSelect   fn(bar) — makes rows clickable
   */
  function bars(host, cfg) {
    host.__cfg = cfg;
    host.__kind = 'bars';
    render();

    function render() {
      host.querySelectorAll('svg, .chart-table, .pie-legend').forEach(function (n) { n.remove(); });
      if (host.__mode === 'table') { host.appendChild(buildBarTable(cfg)); return; }

      var max = cfg.maxBars || 12;
      var all = cfg.bars.slice()
        .filter(function (b) { return b.value > 0; })
        .sort(function (a, b) { return b.value - a.value; });

      if (!all.length) {
        host.innerHTML = '<div class="empty">Nothing to chart in this window.</div>';
        return;
      }
      if (all.length > max) {
        var head = all.slice(0, max - 1);
        var tail = all.slice(max - 1);
        head.push({ label: 'Other (' + tail.length + ')',
                    value: tail.reduce(function (a, b) { return a + b.value; }, 0) });
        all = head;
      }

      var total = cfg.total || all.reduce(function (a, b) { return a + b.value; }, 0);
      var peak = all[0].value || 1;

      /* Geometry. Rows are a fixed height so the chart's size is a function
         of how many reasons there are, not of an arbitrary square. */
      var ROW = 26, GAP = 6, PAD_T = 4, PAD_B = 4;
      var W = Math.max(280, host.clientWidth || 460);
      var LABEL_W = Math.round(Math.min(190, Math.max(120, W * 0.34)));
      var VALUE_W = 92;
      var trackX = LABEL_W + 10;
      var trackW = Math.max(40, W - trackX - VALUE_W);
      var H = PAD_T + all.length * ROW + (all.length - 1) * GAP + PAD_B;

      var ink = cssVar('--ink');
      var muted = cssVar('--ink-muted');
      var track = cssVar('--surface-2');
      var ramp = ['--pie-1', '--pie-2', '--pie-3', '--pie-4', '--pie-5', '--pie-6'];

      var svg = el('svg', {
        width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': cfg.ariaLabel || 'Ranked breakdown'
      });

      all.forEach(function (b, i) {
        var y = PAD_T + i * (ROW + GAP);
        var color = cssVar(ramp[Math.min(i, ramp.length - 1)]);
        var w = Math.max(2, Math.round((b.value / peak) * trackW));
        var share = total ? b.value / total : 0;

        /* Name, left, truncated by the SVG's own clip rather than by
           guessing character widths. */
        var clipId = 'barclip' + i + '-' + Math.round(W);
        var clip = el('clipPath', { id: clipId });
        clip.appendChild(el('rect', { x: 0, y: y, width: LABEL_W, height: ROW }));
        svg.appendChild(clip);

        var name = el('text', {
          x: 0, y: y + ROW / 2 + 4, 'font-size': 13, fill: ink,
          'clip-path': 'url(#' + clipId + ')'
        });
        name.textContent = b.label;
        svg.appendChild(name);

        svg.appendChild(el('rect', {
          x: trackX, y: y + 3, width: trackW, height: ROW - 6, rx: 3, fill: track
        }));
        svg.appendChild(el('rect', {
          x: trackX, y: y + 3, width: w, height: ROW - 6, rx: 3, fill: color
        }));

        /* Count and share sit AFTER the bar, on the surface — never inside
           the fill, where a short bar would clip them. */
        var val = el('text', {
          x: W, y: y + ROW / 2 + 4, 'text-anchor': 'end', 'font-size': 12.5, fill: ink
        });
        val.textContent = fmtInt(b.value);
        svg.appendChild(val);

        var pctText = el('text', {
          x: W - VALUE_W + 46, y: y + ROW / 2 + 4, 'text-anchor': 'end',
          'font-size': 12, fill: muted
        });
        pctText.textContent = (share * 100).toFixed(1) + '%';
        svg.appendChild(pctText);

        var hit = el('rect', {
          x: 0, y: y, width: W, height: ROW, fill: 'transparent',
          style: 'cursor:' + (cfg.onSelect && b.key ? 'pointer' : 'default')
        });
        hit.addEventListener('mouseenter', function () {
          host.__tip.show(tooltipRows(b.label, [
            { color: color, label: cfg.valueLabel || 'Leads', value: fmtInt(b.value) },
            { color: null, label: 'Share', value: (share * 100).toFixed(1) + '%' }
          ]), trackX + w / 2, y);
        });
        hit.addEventListener('mouseleave', function () { host.__tip.hide(); });
        if (cfg.onSelect && b.key) {
          hit.addEventListener('click', function () { cfg.onSelect(b); });
        }
        svg.appendChild(hit);
      });

      host.appendChild(svg);
    }

    host.__render = render;
  }

  function buildBarTable(cfg) {
    var rows = cfg.bars.slice()
      .filter(function (b) { return b.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });
    var total = cfg.total || rows.reduce(function (a, b) { return a + b.value; }, 0);
    var t = document.createElement('table');
    t.className = 'data chart-table';
    t.innerHTML = '<thead><tr><th>Reason</th><th class="num">' +
      (cfg.valueLabel || 'Leads') + '</th><th class="num">Share</th></tr></thead><tbody>' +
      rows.map(function (b) {
        return '<tr><td>' + b.label + '</td><td class="num">' + fmtInt(b.value) +
          '</td><td class="num">' + (total ? (b.value / total * 100).toFixed(1) : '0.0') +
          '%</td></tr>';
      }).join('') + '</tbody>';
    return t;
  }

  /* ---------------------------------------------------------------------- */
  /* Multi-line — two or more series on one time axis                       */
  /* ---------------------------------------------------------------------- */

  /**
   * The existing line() draws one series. This draws several against a shared
   * category axis, for the case where the comparison BETWEEN series is the
   * point — Priority rate against Hot rate, month over month.
   *
   * Colours come from the validated two-series pair (--series-1 blue,
   * --series-2 coral): the only combination in the palette that clears the
   * colourblind gate. Every series also gets a legend entry and its own
   * end-of-line value, so the colour is never the sole channel.
   *
   * A NULL POINT IS A GAP, NOT A ZERO. Months we hold no data for break the
   * line rather than dropping it to the floor — drawing 0% for an unknown
   * month invents a collapse that never happened.
   *
   * @param cfg.labels  ['Jun 2026', ...] one per x position
   * @param cfg.series  [{key,label,colorVar,values:[n|null,...],dashFrom}]
   *                    dashFrom = index from which the line is dashed, used
   *                    to mark a month that is still settling
   * @param cfg.fmt     value formatter for labels and tooltip
   */
  function multiLine(host, cfg) {
    host.__cfg = cfg;
    host.__kind = 'multiLine';
    render();

    function render() {
      host.querySelectorAll('svg, .chart-table, .legend').forEach(function (n) { n.remove(); });

      var labels = cfg.labels || [];
      var series = cfg.series || [];
      var fmt = cfg.fmt || function (v) { return String(v); };

      var present = [];
      labels.forEach(function (_, i) {
        if (series.some(function (sr) { return sr.values[i] != null; })) present.push(i);
      });
      if (present.length === 0) {
        host.innerHTML = '<div class="empty">Nothing to chart yet.</div>';
        return;
      }

      var W = Math.max(320, host.clientWidth || 640);
      var padL = 44, padR = 58, padT = 14, padB = 30;
      var plotH = 180;
      var H = plotH + padT + padB;
      var plotW = W - padL - padR;

      var gridColor = cssVar('--grid');
      var axisColor = cssVar('--axis');
      var muted = cssVar('--ink-muted');
      var surface = cssVar('--surface-1');

      /* Scale to the data, with headroom, rather than a fixed 0-100 — these
         are single-digit percentages and a 0-100 axis would flatten them
         into one indistinguishable line at the bottom. */
      var maxV = 0;
      series.forEach(function (sr) {
        sr.values.forEach(function (v) { if (v != null && v > maxV) maxV = v; });
      });
      var yMax = cfg.yMax != null ? cfg.yMax : Math.max(1, Math.ceil(maxV * 1.25));
      var yMin = 0;

      var n = labels.length;
      function x(i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); }
      function y(v) { return padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

      var svg = el('svg', {
        width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': cfg.ariaLabel || 'Trend by month'
      });

      /* gridlines + y labels */
      var TICKS = 4;
      for (var t = 0; t <= TICKS; t++) {
        var vv = yMin + (yMax - yMin) * (t / TICKS);
        var yy = y(vv);
        svg.appendChild(el('line', {
          x1: padL, y1: yy, x2: padL + plotW, y2: yy,
          stroke: gridColor, 'stroke-width': 1
        }));
        var lab = el('text', {
          x: padL - 8, y: yy + 4, 'text-anchor': 'end',
          'font-size': 11, fill: muted
        });
        lab.textContent = fmt(vv);
        svg.appendChild(lab);
      }

      /* x labels — thinned so they never collide */
      var step = Math.ceil(n / 7);
      labels.forEach(function (l, i) {
        if (i % step !== 0 && i !== n - 1) return;
        var tx = el('text', {
          x: x(i), y: padT + plotH + 18, 'text-anchor': 'middle',
          'font-size': 11, fill: muted
        });
        tx.textContent = l;
        svg.appendChild(tx);
      });

      svg.appendChild(el('line', {
        x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH,
        stroke: axisColor, 'stroke-width': 1
      }));

      series.forEach(function (sr) {
        var color = cssVar(sr.colorVar || '--series-1');
        /* Break the path at gaps rather than bridging them. */
        var run = [], runs = [];
        sr.values.forEach(function (v, i) {
          if (v == null) { if (run.length) { runs.push(run); run = []; } return; }
          run.push(i);
        });
        if (run.length) runs.push(run);

        runs.forEach(function (r) {
          if (r.length === 1) return;   /* a lone point is drawn as a dot below */
          var solid = [], dashed = [];
          r.forEach(function (i, k) {
            var pt = x(i) + ',' + y(sr.values[i]);
            if (sr.dashFrom != null && i >= sr.dashFrom) {
              if (!dashed.length && k > 0) dashed.push(x(r[k - 1]) + ',' + y(sr.values[r[k - 1]]));
              dashed.push(pt);
            } else solid.push(pt);
          });
          if (solid.length > 1) svg.appendChild(el('path', {
            d: 'M' + solid.join(' L'), fill: 'none', stroke: color,
            'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
          }));
          if (dashed.length > 1) svg.appendChild(el('path', {
            d: 'M' + dashed.join(' L'), fill: 'none', stroke: color,
            'stroke-width': 2.5, 'stroke-dasharray': '5 4',
            'stroke-linejoin': 'round', 'stroke-linecap': 'round'
          }));
        });

        sr.values.forEach(function (v, i) {
          if (v == null) return;
          svg.appendChild(el('circle', {
            cx: x(i), cy: y(v), r: 3.5, fill: color, stroke: surface, 'stroke-width': 1.5
          }));
        });

        /* End-of-line value, so each series is readable without the legend. */
        var last = null;
        sr.values.forEach(function (v, i) { if (v != null) last = i; });
        if (last != null) {
          var vl = el('text', {
            x: x(last) + 8, y: y(sr.values[last]) + 4,
            'font-size': 12, 'font-weight': 650, fill: color
          });
          vl.textContent = fmt(sr.values[last]);
          svg.appendChild(vl);
        }
      });

      /* One hover band per month, reporting every series at once — the
         comparison between them is the reason this chart exists. */
      present.forEach(function (i) {
        var bandW = plotW / Math.max(1, n - 1);
        var hit = el('rect', {
          x: x(i) - bandW / 2, y: padT, width: bandW, height: plotH,
          fill: 'transparent'
        });
        hit.addEventListener('mouseenter', function () {
          host.__tip.show(tooltipRows(labels[i], series.map(function (sr) {
            return {
              color: cssVar(sr.colorVar || '--series-1'),
              label: sr.label,
              value: sr.values[i] == null ? '—' : fmt(sr.values[i])
            };
          }).concat(cfg.note && cfg.note[i] ? [{ color: null, label: '', value: cfg.note[i] }] : [])),
            x(i), padT);
        });
        hit.addEventListener('mouseleave', function () { host.__tip.hide(); });
        svg.appendChild(hit);
      });

      host.appendChild(svg);

      var legend = document.createElement('div');
      legend.className = 'legend';
      legend.innerHTML = series.map(function (sr) {
        return '<span class="legend-item"><span class="legend-swatch" style="background:' +
          cssVar(sr.colorVar || '--series-1') + '"></span>' + sr.label + '</span>';
      }).join('') + (cfg.legendNote
        ? '<span class="legend-item" style="color:var(--ink-muted)">' + cfg.legendNote + '</span>'
        : '');
      host.appendChild(legend);
    }

    host.__render = render;
  }

  /* ---------------------------------------------------------------------- */
  /* Pie — part-to-whole                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Deliberately a SEQUENTIAL RAMP, not categorical colours. The slices are
   * an ordered set (biggest reason first), and a pie compares every slice
   * against every other, which is the case the categorical palette caps at
   * three. One hue ordered dark→light carries "biggest" without needing six
   * hues that would fail the colourblind gates.
   *
   * Segments are separated by a 2px stroke in the surface colour — the same
   * surface-gap rule as stacked bars, never a border drawn around a mark.
   *
   * @param cfg.slices [{label, value}]  pre-sorted or not; sorted here
   * @param cfg.maxSlices  fold the tail into "Other" beyond this (default 6)
   */
  function pie(host, cfg) {
    host.__cfg = cfg;
    host.__kind = 'pie';
    render();

    function render() {
      host.querySelectorAll('svg, .chart-table, .pie-legend').forEach(function (n) { n.remove(); });
      if (host.__mode === 'table') { host.appendChild(buildPieTable(cfg)); return; }

      var slices = prepare(cfg);
      var total = slices.reduce(function (a, s) { return a + s.value; }, 0);
      if (!total) {
        host.innerHTML = '<div class="empty">Nothing to chart in this window.</div>';
        return;
      }

      var W = Math.max(260, Math.min(host.clientWidth || 420, 520));
      var H = 260, cx = W / 2, cy = H / 2, R = 96;
      var surface = cssVar('--surface-1');
      var ink = cssVar('--ink');

      var svg = el('svg', {
        width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': cfg.ariaLabel || 'Share of rejections by reason'
      });

      var a0 = -Math.PI / 2;   /* start at 12 o'clock */
      slices.forEach(function (s, i) {
        var frac = s.value / total;
        var a1 = a0 + frac * Math.PI * 2;
        var large = frac > 0.5 ? 1 : 0;
        var x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
        var x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);

        var d = (frac >= 0.999)
          /* A single 100% slice cannot be drawn as an arc — it is a circle. */
          ? null
          : 'M' + cx + ',' + cy + ' L' + x0.toFixed(1) + ',' + y0.toFixed(1) +
            ' A' + R + ',' + R + ' 0 ' + large + ',1 ' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' Z';

        var node = d
          ? el('path', { d: d, fill: s.color, stroke: surface, 'stroke-width': 2 })
          : el('circle', { cx: cx, cy: cy, r: R, fill: s.color });
        svg.appendChild(node);

        /* Label only slices with room for one; the rest read off the legend. */
        if (frac >= 0.08) {
          var mid = (a0 + a1) / 2;
          var lx = cx + (R * 0.62) * Math.cos(mid);
          var ly = cy + (R * 0.62) * Math.sin(mid);
          var t = el('text', {
            x: lx.toFixed(1), y: (ly + 4).toFixed(1), 'text-anchor': 'middle',
            'font-size': 12.5, 'font-weight': 650,
            /* Ink or white by slice luminance, the one case where text sits
               inside a filled mark. */
            fill: s.dark ? '#fff' : ink
          });
          t.textContent = Math.round(frac * 100) + '%';
          svg.appendChild(t);
        }

        var hit = el('path', {
          d: d || ('M' + cx + ',' + cy + ' m' + (-R) + ',0 a' + R + ',' + R + ' 0 1,0 ' + (R * 2) + ',0 a' + R + ',' + R + ' 0 1,0 ' + (-R * 2) + ',0'),
          fill: 'transparent', style: 'cursor:default'
        });
        hit.addEventListener('mouseenter', function () {
          host.__tip.show(tooltipRows(s.label, [
            { color: s.color, label: 'Leads', value: fmtInt(s.value) },
            { color: null, label: 'Share', value: (frac * 100).toFixed(1) + '%' }
          ]), cx, cy - R / 2);
        });
        hit.addEventListener('mouseleave', function () { host.__tip.hide(); });
        svg.appendChild(hit);

        a0 = a1;
      });

      host.appendChild(svg);

      var legend = document.createElement('div');
      legend.className = 'legend pie-legend';
      legend.innerHTML = slices.map(function (s) {
        return '<span class="legend-item"><span class="legend-swatch" style="background:' +
          s.color + '"></span>' + s.label + ' <span style="color:var(--ink-muted)">' +
          fmtInt(s.value) + '</span></span>';
      }).join('');
      host.appendChild(legend);
    }

    host.__render = render;
  }

  /* Sort desc, fold the tail into Other, and assign ramp steps. */
  function prepare(cfg) {
    var max = cfg.maxSlices || 6;
    var all = cfg.slices.slice()
      .filter(function (s) { return s.value > 0; })
      .sort(function (a, b) { return b.value - a.value; });

    var slices = all;
    if (all.length > max) {
      var head = all.slice(0, max - 1);
      var tail = all.slice(max - 1);
      head.push({
        label: 'Other (' + tail.length + ')',
        value: tail.reduce(function (a, s) { return a + s.value; }, 0)
      });
      slices = head;
    }

    /* Ordered ramp, darkest = biggest. Steps come from the validated blue
       ordinal ramp; the light end still clears the surface. */
    var ramp = ['--pie-1', '--pie-2', '--pie-3', '--pie-4', '--pie-5', '--pie-6'];
    slices.forEach(function (s, i) {
      s.color = cssVar(ramp[Math.min(i, ramp.length - 1)]);
      s.dark = i < 3;
    });
    return slices;
  }

  function buildPieTable(cfg) {
    var slices = prepare(cfg);
    var total = slices.reduce(function (a, s) { return a + s.value; }, 0) || 1;
    var wrap = document.createElement('div');
    wrap.className = 'chart-table table-wrap';
    var t = document.createElement('table');
    t.className = 'data';
    t.innerHTML = '<thead><tr><th>Reason</th><th class="num">Leads</th><th class="num">Share</th></tr></thead>' +
      '<tbody>' + slices.map(function (s) {
        return '<tr><td>' + s.label + '</td><td class="num">' + fmtInt(s.value) +
          '</td><td class="num">' + ((s.value / total) * 100).toFixed(1) + '%</td></tr>';
      }).join('') + '</tbody>';
    wrap.appendChild(t);
    return wrap;
  }

  /* ---------------------------------------------------------------------- */
  /* Table-view twins                                                       */
  /* ---------------------------------------------------------------------- */

  function buildTable(cfg) {
    var wrap = document.createElement('div');
    wrap.className = 'chart-table table-wrap';
    var t = document.createElement('table');
    t.className = 'data';

    var head = '<thead><tr><th>Day</th>';
    cfg.series.forEach(function (s) { head += '<th class="num">' + s.label + '</th>'; });
    if (cfg.series.length > 1) head += '<th class="num">Total</th>';
    if (cfg.targetLine) head += '<th class="num">Target</th><th class="num">Vs target</th>';
    head += '</tr></thead>';

    var body = '<tbody>';
    cfg.days.forEach(function (d, i) {
      body += '<tr><td>' + fmtDayFull(d.date) + '</td>';
      var total = 0;
      cfg.series.forEach(function (s) {
        var v = d[s.key] || 0; total += v;
        body += '<td class="num">' + fmtInt(v) + '</td>';
      });
      if (cfg.series.length > 1) body += '<td class="num">' + fmtInt(total) + '</td>';
      if (cfg.targetLine) {
        var dayTarget = targetForDay(cfg, i);
        if (dayTarget == null) {
          body += '<td class="num">—</td><td class="num">—</td>';
        } else {
          var tv = Math.round(dayTarget);
          var cmp = Math.round(compareValueForDay(cfg, d, total));
          var diff = cmp - tv;
          body += '<td class="num">' + fmtInt(tv) + '</td>' +
                  '<td class="num">' + (diff >= 0 ? '+' : '') + fmtInt(diff) + '</td>';
        }
      }
      body += '</tr>';
    });
    body += '</tbody>';

    t.innerHTML = head + body;
    wrap.appendChild(t);
    return wrap;
  }

  function buildLineTable(cfg) {
    var wrap = document.createElement('div');
    wrap.className = 'chart-table table-wrap';
    var t = document.createElement('table');
    t.className = 'data';
    var rows = cfg.points.map(function (p) {
      return '<tr><td>' + fmtDayFull(p.date) + '</td><td class="num">' + p.score + '</td></tr>';
    }).join('');
    t.innerHTML = '<thead><tr><th>30 days ending</th><th class="num">' +
      (cfg.seriesLabel || 'Score') + '</th></tr></thead><tbody>' + rows + '</tbody>';
    wrap.appendChild(t);
    return wrap;
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                 */
  /* ---------------------------------------------------------------------- */

  /* The tooltip belongs to ITS OWN host, stored on the element.
     This used to be a single module-level `tip`, which meant mounting a
     second chart overwrote the first one's reference — both charts then drove
     the tooltip that lived inside the last-mounted wrapper. Stacked, that
     looked like a small vertical offset; side by side on a wide screen, the
     popup appeared in the neighbouring chart about a thousand pixels away. */
  function mount(host, kind, cfg) {
    host.querySelectorAll('.tooltip').forEach(function (n) { n.remove(); });
    host.__tip = makeTooltip(host);
    if (kind === 'columns') columns(host, cfg);
    else if (kind === 'pie') pie(host, cfg);
    else if (kind === 'bars') bars(host, cfg);
    else if (kind === 'multiLine') multiLine(host, cfg);
    else line(host, cfg);
    registerResize(host);
  }

  var resizeHosts = [];
  var resizeBound = false;
  function registerResize(host) {
    if (resizeHosts.indexOf(host) === -1) resizeHosts.push(host);
    if (resizeBound) return;
    resizeBound = true;
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        resizeHosts.forEach(function (h) { if (h.__render && h.isConnected) h.__render(); });
      }, 140);
    });
  }

  /* Toggle a chart between its plot and its table twin. */
  function setMode(host, mode) {
    host.__mode = mode;
    /* the tooltip element must survive the re-render */
    var keep = host.querySelector('.tooltip');
    if (host.__render) host.__render();
    if (keep && !host.querySelector('.tooltip')) host.appendChild(keep);
  }

  global.FZCharts = {
    mount: mount,
    setMode: setMode,
    gauge: gauge,
    cssVar: cssVar,
    fmtDay: fmtDay,
    fmtDayFull: fmtDayFull
  };

})(window);
