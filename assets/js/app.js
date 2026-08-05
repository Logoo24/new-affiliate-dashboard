/* ==========================================================================
   app.js — shell, filter state, formatting helpers
   --------------------------------------------------------------------------
   Filter state lives in the QUERY STRING, and the filter row is a real
   <form method="get"> that reloads the page. That is not laziness — it is the
   shape a PHP build actually takes, and it means every view in this mock-up is
   linkable, bookmarkable, and back-button-correct the way the production page
   will be. Nothing here assumes a client-side router or a JSON API.
   ========================================================================== */

(function (global) {
  'use strict';

  var D = global.FZData;

  var NAV = [
    { href: 'index.html',          label: 'Performance',      ico: '▤' },
    { href: 'leads.html',          label: 'Leads',            ico: '☰' },
    { href: 'health.html',         label: 'Health scorecard', ico: '◈' },
    { href: 'duplicate-check.html',label: 'Duplicate check',  ico: '⌕' },
    { href: 'setup.html',          label: 'Setup & docs',     ico: '⚙' }
  ];

  /* ---------------------------------------------------------------------- */
  /* Query-string state                                                     */
  /* ---------------------------------------------------------------------- */

  function params(opts) {
    /* Performance defaults to Last 7 days, as specified. The lead table opts
       into 30 — leads take 9–12 days to cook, so a 7-day default there would
       open on a sold column that is blank for every row, which is exactly the
       "I can't tell which ones are selling" complaint this replaces. */
    var fallback = (opts && opts.defaultRange) || '7d';
    var q = new URLSearchParams(global.location.search);

    /* Partner context: query string wins, then the last choice made in this
       tab. The sessionStorage fallback keeps the switcher working when the
       page is opened somewhere that drops query strings (some preview panes
       and embedded viewers do). In production none of this exists — the
       partner comes off the session and cannot be chosen at all. */
    var partnerType = q.get('partner');
    if (partnerType !== 'cpl' && partnerType !== 'revshare') {
      try { partnerType = sessionStorage.getItem('fz_partner'); } catch (e) { partnerType = null; }
    }
    partnerType = partnerType === 'cpl' ? 'cpl' : 'revshare';
    try { sessionStorage.setItem('fz_partner', partnerType); } catch (e) {}
    var rangeKey = q.get('range') || fallback;
    if (!D.RANGES[rangeKey]) rangeKey = fallback;

    var from = parseDate(q.get('from'));
    var to = parseDate(q.get('to'));
    var range = D.resolveRange(rangeKey, from, to);

    return {
      partnerType: partnerType,
      partner: D.PARTNER_TYPES[partnerType],
      rangeKey: rangeKey,
      range: range,
      campaignId: q.get('campaign') || 'all',
      subid: q.get('subid') || 'all',
      status: q.get('status') || 'all',
      sold: q.get('sold') || 'all',
      page: Math.max(1, parseInt(q.get('p'), 10) || 1)
    };
  }

  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  function isoDate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* Carry the current context onto another page. */
  function linkTo(href, state, extra) {
    var q = new URLSearchParams();
    q.set('partner', state.partnerType);
    q.set('range', state.rangeKey);
    if (state.rangeKey === 'custom') {
      q.set('from', isoDate(state.range.from));
      q.set('to', isoDate(state.range.to));
    }
    if (state.campaignId !== 'all') q.set('campaign', state.campaignId);
    if (state.subid !== 'all') q.set('subid', state.subid);
    for (var k in (extra || {})) q.set(k, extra[k]);
    return href + '?' + q.toString();
  }

  /* ---------------------------------------------------------------------- */
  /* Shell                                                                  */
  /* ---------------------------------------------------------------------- */

  function shell(state, opts) {
    var active = opts.active;
    var side = document.querySelector('[data-shell="sidebar"]');
    var top = document.querySelector('[data-shell="topbar"]');
    var p = state.partner;

    if (side) {
      side.innerHTML =
        '<div class="brand">' +
          '<div class="brand-mark">Financialize</div>' +
          '<div class="brand-sub">Partner Portal</div>' +
        '</div>' +
        '<nav class="nav">' +
          '<div class="nav-label">Reporting</div>' +
          NAV.map(function (n) {
            return '<a href="' + linkTo(n.href, state) + '"' +
              (n.href === active ? ' class="is-active"' : '') + '>' +
              '<span class="ico">' + n.ico + '</span>' + n.label + '</a>';
          }).join('') +
        '</nav>' +
        '<div class="sidebar-foot">' +
          esc(p.name) + '<br>' +
          '<span style="opacity:.8">' + esc(p.compModel) + '</span>' +
        '</div>';
    }

    if (top) {
      top.innerHTML =
        '<div class="page-title">' +
          '<h1>' + esc(opts.title) + '</h1>' +
          (opts.subtitle ? '<p>' + opts.subtitle + '</p>' : '') +
        '</div>' +
        '<div class="ctx" title="Mock-up affordance only. In production the partner type comes from the session, and the two views are two different SQL projections — see HANDOFF.md.">' +
          '<span class="ctx-label">Viewing as</span>' +
          '<select id="ctx-partner">' +
            '<option value="revshare"' + (state.partnerType === 'revshare' ? ' selected' : '') + '>RevShare partner — OptiLabX Media</option>' +
            '<option value="cpl"' + (state.partnerType === 'cpl' ? ' selected' : '') + '>CPL partner — Cardinal Reach LLC</option>' +
          '</select>' +
        '</div>';

      var sel = document.getElementById('ctx-partner');
      if (sel) {
        sel.addEventListener('change', function () {
          try { sessionStorage.setItem('fz_partner', sel.value); } catch (e) {}
          var q = new URLSearchParams(global.location.search);
          q.set('partner', sel.value);
          q.delete('p');
          global.location.search = q.toString();
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Filter row                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Renders the shared filter row. `fields` picks which controls appear so
   * every page scopes the same way from one row above the content.
   */
  function filterBar(host, state, fields) {
    fields = fields || ['range', 'campaign', 'subid'];
    var isCustom = state.rangeKey === 'custom';

    var html = '<form class="filters" method="get" id="filter-form">' +
      '<input type="hidden" name="partner" value="' + state.partnerType + '">';

    if (fields.indexOf('range') !== -1) {
      html += '<div class="field"><label for="f-range">Date range</label>' +
        '<select id="f-range" name="range">' +
        Object.keys(D.RANGES).map(function (k) {
          return '<option value="' + k + '"' + (k === state.rangeKey ? ' selected' : '') + '>' +
            D.RANGES[k].label + '</option>';
        }).join('') +
        '</select></div>';

      html += '<div class="field" id="custom-from" style="' + (isCustom ? '' : 'display:none') + '">' +
        '<label for="f-from">From</label>' +
        '<input type="date" id="f-from" name="from" value="' + isoDate(state.range.from) + '"></div>' +
        '<div class="field" id="custom-to" style="' + (isCustom ? '' : 'display:none') + '">' +
        '<label for="f-to">To</label>' +
        '<input type="date" id="f-to" name="to" value="' + isoDate(state.range.to) + '"></div>';
    }

    if (fields.indexOf('campaign') !== -1) {
      html += '<div class="field"><label for="f-campaign">Campaign</label>' +
        '<select id="f-campaign" name="campaign">' +
        '<option value="all"' + (state.campaignId === 'all' ? ' selected' : '') + '>All campaigns</option>' +
        D.CAMPAIGNS.map(function (c) {
          return '<option value="' + c.id + '"' + (c.id === state.campaignId ? ' selected' : '') + '>' +
            esc(c.name) + '</option>';
        }).join('') +
        '</select></div>';
    }

    if (fields.indexOf('subid') !== -1) {
      var subs = [];
      D.CAMPAIGNS.forEach(function (c) {
        if (state.campaignId !== 'all' && c.id !== state.campaignId) return;
        c.subids.forEach(function (s) { subs.push(s); });
      });
      html += '<div class="field"><label for="f-subid">Sub-ID</label>' +
        '<select id="f-subid" name="subid">' +
        '<option value="all"' + (state.subid === 'all' ? ' selected' : '') + '>All sub-IDs</option>' +
        subs.map(function (s) {
          return '<option value="' + s.id + '"' + (s.id === state.subid ? ' selected' : '') + '>' +
            esc(s.label) + ' (' + esc(s.id) + ')</option>';
        }).join('') +
        '</select></div>';
    }

    if (fields.indexOf('status') !== -1) {
      html += '<div class="field"><label for="f-status">Status</label>' +
        '<select id="f-status" name="status">' +
        [['all', 'All leads'], ['paid', 'Accepted (paid)'], ['free', 'Rejected (free)']].map(function (o) {
          return '<option value="' + o[0] + '"' + (state.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') +
        '</select></div>';
    }

    if (fields.indexOf('sold') !== -1) {
      html += '<div class="field"><label for="f-sold">Sold type</label>' +
        '<select id="f-sold" name="sold">' +
        [['all', 'Any outcome'], ['ph', 'Priority or Hot'], ['priority', 'Priority'], ['hot', 'Hot'],
         ['auction', 'Auction'], ['marketplace', 'Marketplace'], ['unsold', 'Not yet sold']].map(function (o) {
          return '<option value="' + o[0] + '"' + (state.sold === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') +
        '</select></div>';
    }

    html += '<div class="spacer"></div>' +
      '<button type="submit" class="btn btn-primary">Apply</button>' +
      /* Only advertise the window on pages that actually scope by it — the
         scorecard is fixed to a rolling 30 days and saying "7 days" there
         would be a lie in small type. */
      (fields.indexOf('range') !== -1
        ? '<span class="applied">' + rangeSummary(state.range) + '</span>'
        : '') +
      '</form>';

    host.innerHTML = html;

    /* Show the custom date inputs only when Custom is chosen, and re-submit
       on preset change so the control feels immediate. */
    var rangeSel = document.getElementById('f-range');
    if (rangeSel) {
      rangeSel.addEventListener('change', function () {
        var custom = rangeSel.value === 'custom';
        document.getElementById('custom-from').style.display = custom ? '' : 'none';
        document.getElementById('custom-to').style.display = custom ? '' : 'none';
        if (!custom) document.getElementById('filter-form').submit();
      });
    }
    ['f-campaign', 'f-subid', 'f-status', 'f-sold'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.addEventListener('change', function () { document.getElementById('filter-form').submit(); });
    });
  }

  function rangeSummary(range) {
    var days = D.daysBetween(range.from, range.to) + 1;
    var f = range.from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    var t = range.to.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (days === 1) return f + ' · 1 day';
    return f + ' – ' + t + ' · ' + days + ' days';
  }

  /* ---------------------------------------------------------------------- */
  /* Formatting                                                             */
  /* ---------------------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtInt(n) { return (n || 0).toLocaleString('en-US'); }
  function fmtPct(v, dp) {
    if (v == null || isNaN(v)) return '—';
    return (v * 100).toFixed(dp == null ? 1 : dp) + '%';
  }
  function fmtMoney(n) {
    if (n == null) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney0(n) {
    if (n == null) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtDateTime(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function soldBadge(soldType) {
    if (!soldType) {
      return '<span class="badge badge-unsold"><span class="dot"></span>Not yet sold</span>';
    }
    var map = {
      priority: 'badge-priority', hot: 'badge-hot',
      auction: 'badge-auction', marketplace: 'badge-market'
    };
    return '<span class="badge ' + map[soldType] + '"><span class="dot"></span>' +
      D.SOLD_TYPES[soldType].label + '</span>';
  }

  function deltaHtml(current, prior, opts) {
    opts = opts || {};
    if (current == null || prior == null || prior === 0) {
      return '<div class="tile-delta delta-flat">no prior-period baseline</div>';
    }
    var change = (current - prior) / Math.abs(prior);
    var up = change > 0.005, down = change < -0.005;
    var good = opts.lowerIsBetter ? down : up;
    var cls = (!up && !down) ? 'delta-flat' : (good ? 'delta-up' : 'delta-down');
    var arrow = (!up && !down) ? '→' : (up ? '↑' : '↓');
    return '<div class="tile-delta ' + cls + '">' + arrow + ' ' +
      Math.abs(change * 100).toFixed(1) + '% vs prior ' + (opts.periodLabel || 'period') + '</div>';
  }

  /* ---------------------------------------------------------------------- */
  /* CSV export                                                             */
  /* ---------------------------------------------------------------------- */

  /* Built from the PROJECTED rows, so a CPL partner's export cannot contain a
     revenue column even by accident — there is no revenue field on the object.
     This retires the daily manual CSV currently sent to Heritage by hand. */
  function exportCsv(rows, columns, filename) {
    var lines = [columns.map(function (c) { return quote(c.label); }).join(',')];
    rows.forEach(function (r) {
      lines.push(columns.map(function (c) { return quote(c.value(r)); }).join(','));
    });
    var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function quote(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------------------------------------------------------------------- */
  /* Chart view toggle (plot ⇄ table twin)                                  */
  /* ---------------------------------------------------------------------- */

  function viewToggle(host, chartHost) {
    host.innerHTML =
      '<div class="view-toggle">' +
        '<button type="button" class="is-on" data-mode="chart">Chart</button>' +
        '<button type="button" data-mode="table">Table</button>' +
      '</div>';
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        host.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        global.FZCharts.setMode(chartHost, b.dataset.mode);
      });
    });
  }

  global.FZApp = {
    params: params,
    shell: shell,
    filterBar: filterBar,
    linkTo: linkTo,
    isoDate: isoDate,
    rangeSummary: rangeSummary,
    esc: esc,
    fmtInt: fmtInt,
    fmtPct: fmtPct,
    fmtMoney: fmtMoney,
    fmtMoney0: fmtMoney0,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    soldBadge: soldBadge,
    deltaHtml: deltaHtml,
    exportCsv: exportCsv,
    viewToggle: viewToggle
  };

})(window);
