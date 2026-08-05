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
      days.forEach(function (d) {
        var t = 0;
        cfg.series.forEach(function (s) { t += d[s.key] || 0; });
        if (t > max) max = t;
      });
      /* Keep the target inside the plot — a reference line drawn off the top
         of the chart is worse than no reference line. */
      if (cfg.targetLine && cfg.targetLine.value > max) max = cfg.targetLine.value;
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
          if (cfg.targetLine) {
            var tv = cfg.targetLine.value;
            rows.push({ color: null, label: 'Target', value: fmtInt(Math.round(tv)) });
            rows.push({
              color: null, label: stackTotal >= tv ? 'Over target' : 'Under target',
              value: (stackTotal >= tv ? '+' : '') + fmtInt(Math.round(stackTotal - tv))
            });
          }
          tip.show(tooltipRows(fmtDayFull(d.date), rows), cx, padT + plotH / 2);
          hover.setAttribute('x', padL + band * i);
          hover.setAttribute('width', Math.max(band, 1));
          hover.style.opacity = '1';
        });
        hit.addEventListener('mouseleave', function () {
          tip.hide();
          hover.style.opacity = '0';
        });
        svg.appendChild(hit);
      });

      /* --- target reference line --------------------------------------- */
      /* Dashed ON PURPOSE. The no-dashing rule applies to gridlines and axes,
         where dashing falsely implies a threshold. Here it IS a threshold, so
         the dash is what separates it from the grid it crosses. */
      if (cfg.targetLine && cfg.targetLine.value > 0) {
        var ty = padT + plotH - (cfg.targetLine.value / yMax) * plotH;
        svg.appendChild(el('line', {
          x1: padL, x2: padL + plotW, y1: ty, y2: ty,
          stroke: cssVar('--ink-2'), 'stroke-width': 1.5,
          'stroke-dasharray': '5 4', 'stroke-linecap': 'round'
        }));
        var tlbl = el('text', {
          x: padL + plotW, y: ty - 6, 'text-anchor': 'end',
          fill: cssVar('--ink-2'), 'font-size': 10.5, 'font-weight': 650
        });
        tlbl.textContent = cfg.targetLine.label;
        svg.appendChild(tlbl);
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
          tip.show(tooltipRows('30 days ending ' + fmtDayFull(p.date), [
            { color: color, label: cfg.seriesLabel || 'Health score', value: p.score }
          ]), X(i), Y(p.score));
        });
        hit.addEventListener('mouseleave', function () {
          cross.setAttribute('opacity', 0);
          focus.setAttribute('opacity', 0);
          tip.hide();
        });
        svg.appendChild(hit);
      });

      host.appendChild(svg);
    }

    host.__render = render;
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
    cfg.days.forEach(function (d) {
      body += '<tr><td>' + fmtDayFull(d.date) + '</td>';
      var total = 0;
      cfg.series.forEach(function (s) {
        var v = d[s.key] || 0; total += v;
        body += '<td class="num">' + fmtInt(v) + '</td>';
      });
      if (cfg.series.length > 1) body += '<td class="num">' + fmtInt(total) + '</td>';
      if (cfg.targetLine) {
        var tv = Math.round(cfg.targetLine.value);
        var diff = total - tv;
        body += '<td class="num">' + fmtInt(tv) + '</td>' +
                '<td class="num">' + (diff >= 0 ? '+' : '') + fmtInt(diff) + '</td>';
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

  var tip;

  function mount(host, kind, cfg) {
    if (!tip || tip.__host !== host) {
      host.querySelectorAll('.tooltip').forEach(function (n) { n.remove(); });
    }
    tip = makeTooltip(host);
    tip.__host = host;
    if (kind === 'columns') columns(host, cfg); else line(host, cfg);
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
    cssVar: cssVar,
    fmtDay: fmtDay,
    fmtDayFull: fmtDayFull
  };

})(window);
