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

  /* THE FINANCIALIZE MARK — the real asset, reverse (light-on-dark) cut,
     because the nav rail is navy in both themes.

     644x839, so it is TALLER THAN IT IS WIDE. Sized on height in CSS with
     width:auto; do not give it both dimensions — an earlier hand-traced SVG
     was forced into a near-square box and came out stretched. */
  var BRAND_MARK =
    '<img src="assets/img/financialize-mark.png" alt="" aria-hidden="true" ' +
      'width="644" height="839" decoding="async">';

  /* Icons are plain text glyphs, chosen to READ as the thing they sit next
     to: home, trend, rows, health, target, lookup, money, gear. Monochrome
     on purpose — they inherit the rail's ink like the labels do. */
  var NAV = [
    { href: 'partnership.html',    label: 'Partnership summary', ico: '⌂' },
    { href: 'performance.html',    label: 'Performance',      ico: '↗' },
    { href: 'leads.html',          label: 'Lead table',       ico: '☰' },
    { href: 'health.html',         label: 'Lead health',      ico: '♥' },
    { href: 'targeting.html',      label: 'Targeting',        ico: '◎' },
    { href: 'duplicate-check.html',label: 'Duplicates & suppression', ico: '⌕' },
    { href: 'compensation.html',   label: 'Compensation',     ico: '$' },
    { href: 'setup.html',          label: 'Setup & docs',     ico: '⚙' }
  ];

  var ACCOUNT_NAV = [
    { href: 'account.html', label: 'Account & users', ico: '☺' }
  ];

  /* TEMPORARY AND INTERNAL. Not part of the partner portal — it exists so the
     dev team can see the shape of the admin settings described in
     ADMIN-MAPPING.md. A partner must never see this group.
     DELETE BOTH THIS AND admin-preview.html BEFORE ANYTHING SHIPS. */
  var INTERNAL_NAV = [
    { href: 'admin-preview.html', label: 'Admin settings', ico: '⚒' },
    { href: 'data-source.html',   label: 'Data connections', ico: '⇄' }
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
       partner comes off the session and cannot be chosen at all.

       resolvePartnerId() still accepts the legacy 'revshare' / 'cpl' values
       that used to double as partner ids, so old links keep working. */
    var partnerId = q.get('partner');
    if (!partnerId) {
      try { partnerId = sessionStorage.getItem('fz_partner'); } catch (e) { partnerId = null; }
    }
    partnerId = D.resolvePartnerId(partnerId);
    try { sessionStorage.setItem('fz_partner', partnerId); } catch (e) {}
    var rangeKey = q.get('range') || fallback;
    if (!D.RANGES[rangeKey]) rangeKey = fallback;
    /* Whether the URL actually names a range. Only an explicit choice
       propagates to other pages — see linkTo(). */
    var rangeExplicit = !!q.get('range') && !!D.RANGES[q.get('range')];

    var from = parseDate(q.get('from'));
    var to = parseDate(q.get('to'));
    var range = D.resolveRange(rangeKey, from, to);

    return {
      partnerId: partnerId,
      partner: D.PARTNERS[partnerId],
      /* Comp models this partner is currently running. Length > 1 means a
         mixed account and the lead table will carry heterogeneous rows. */
      comps: D.compsFor(partnerId),
      rateBasis: D.rateBasisFor(partnerId),
      rangeKey: rangeKey,
      rangeExplicit: rangeExplicit,
      range: range,
      campaignId: q.get('campaign') || 'all',
      subid: q.get('subid') || 'all',
      status: q.get('status') || 'all',
      sold: q.get('sold') || 'all',
      /* Rejection reason. Set by the "Why leads were rejected" table on the
         Performance overview, which links a row straight into the lead table
         filtered to that reason. */
      reason: q.get('reason') || 'all',
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

  /* Carry the current context onto another page.

     THE RANGE ONLY TRAVELS WHEN THE USER ACTUALLY CHOSE ONE. Pages have
     different default windows on purpose — Performance and the lead table
     open on Last 30 days, Compensation on This month — and an implicit
     default carried in a nav link used to stomp them: landing on the
     Partnership summary (7d) and clicking Performance forced range=7d onto
     a page whose own default is 30d. An explicit pick (the filter form
     always names one) still follows the user from page to page. */
  function linkTo(href, state, extra) {
    var q = new URLSearchParams();
    q.set('partner', state.partnerId);
    if (state.rangeExplicit) {
      q.set('range', state.rangeKey);
      if (state.rangeKey === 'custom') {
        q.set('from', isoDate(state.range.from));
        q.set('to', isoDate(state.range.to));
      }
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
    wireTips();               /* every page gets the hover-descriptor layer */
    var active = opts.active;
    var side = document.querySelector('[data-shell="sidebar"]');
    var top = document.querySelector('[data-shell="topbar"]');
    var p = state.partner;

    if (side) {
      side.innerHTML =
        /* The whole block is the home link — mark and wordmark together.
           A logo that is decoration while only the nav navigates is a dead
           target people click anyway. */
        '<a class="brand" href="' + linkTo('partnership.html', state) + '">' +
          '<span class="brand-logo">' + BRAND_MARK + '</span>' +
          '<span>' +
            '<span class="brand-mark">Financialize</span>' +
            '<div class="brand-sub">Affiliate Portal</div>' +
          '</span>' +
        '</a>' +
        '<nav class="nav">' +
          '<div class="nav-label">Reporting</div>' +
          NAV.map(function (n) {
            return '<a href="' + linkTo(n.href, state) + '"' +
              (n.href === active ? ' class="is-active"' : '') + '>' +
              '<span class="ico">' + n.ico + '</span>' + n.label + '</a>';
          }).join('') +
          '<div class="nav-label" style="margin-top:14px">Account</div>' +
          ACCOUNT_NAV.map(function (n) {
            return '<a href="' + linkTo(n.href, state) + '"' +
              (n.href === active ? ' class="is-active"' : '') + '>' +
              '<span class="ico">' + n.ico + '</span>' + n.label + '</a>';
          }).join('') +
          '<div class="nav-label" style="margin-top:14px">Internal — temporary</div>' +
          INTERNAL_NAV.map(function (n) {
            return '<a href="' + linkTo(n.href, state) + '"' +
              (n.href === active ? ' class="is-active"' : '') + '>' +
              '<span class="ico">' + n.ico + '</span>' + n.label + '</a>';
          }).join('') +
        '</nav>' +
        /* Active/inactive here is DERIVED — one accepted lead in the trailing
           month — not a stored flag. No comp model here either: it is set per
           campaign and one model beside the account name misrepresents any
           partner running more than one. The whole block links to the Account
           page. */
        (function () {
          var act = D.isPartnerActive(state.partnerId);
          return '<a class="sidebar-foot" href="' + linkTo('account.html', state) + '" ' +
            'style="display:block;text-decoration:none;color:inherit;cursor:pointer">' +
            '<strong>' + esc(p.name) + '</strong><br>' +
            /* Pinned hex, not theme tokens: the rail is navy in BOTH themes,
               and light-mode --good-text is a dark green that vanishes on it.
               #22C55E and #fab219 both clear 3:1 on the navy surface. */
            '<span style="color:' + (act.active ? '#22C55E' : '#fab219') + ';font-weight:600">' +
              (act.active ? '● Active' : '● Inactive') + '</span>' +
            ' · ' + D.activeCampaignsFor(state.partnerId).length + ' active campaigns' +
          '</a>';
        })();
    }

    if (top) {
      top.innerHTML =
        '<div class="page-title">' +
          '<h1>' + esc(opts.title) + '</h1>' +
          (opts.subtitle ? '<p>' + opts.subtitle + '</p>' : '') +
        '</div>' +
        /* Built from PARTNERS rather than hardcoded, so the names cannot
           drift out of step with the data the way they previously did. */
        /* Reviewer scaffolding: the whole control disappears in production,
           where the partner comes off the session and cannot be chosen. The
           projection detail it used to name lives in HANDOFF, not in a
           tooltip. */
        '<div class="ctx" title="Preview control — not part of the partner view. Your account is set by your login.">' +
          '<span class="ctx-label">Viewing as</span>' +
          '<select id="ctx-partner">' +
            Object.keys(D.PARTNERS).map(function (k) {
              return '<option value="' + k + '"' + (state.partnerId === k ? ' selected' : '') + '>' +
                esc(D.PARTNERS[k].name) + '</option>';
            }).join('') +
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
      '<input type="hidden" name="partner" value="' + state.partnerId + '">';

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

    /* Campaigns belong to the partner, so the list is scoped to them. */
    var myCampaigns = D.campaignsFor(state.partnerId);

    if (fields.indexOf('campaign') !== -1) {
      html += '<div class="field"><label for="f-campaign">Campaign</label>' +
        '<select id="f-campaign" name="campaign">' +
        '<option value="all"' + (state.campaignId === 'all' ? ' selected' : '') + '>All campaigns</option>' +
        myCampaigns.map(function (c) {
          return '<option value="' + c.id + '"' + (c.id === state.campaignId ? ' selected' : '') + '>' +
            esc(c.name) + '</option>';
        }).join('') +
        '</select></div>';
    }

    if (fields.indexOf('subid') !== -1) {
      var subs = [];
      myCampaigns.forEach(function (c) {
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
        [['all', 'All leads'], ['paid', 'Accepted'], ['free', 'Rejected']].map(function (o) {
          return '<option value="' + o[0] + '"' + (state.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') +
        '</select></div>';
    }

    /* Reason is only meaningful on rejected rows, so choosing one also
       implies Status = Rejected. The select is built from the shared
       catalogue rather than a second hardcoded list — a reason added in
       data.js appears here with no change to this file. */
    if (fields.indexOf('reason') !== -1) {
      html += '<div class="field"><label for="f-reason">Rejection reason</label>' +
        '<select id="f-reason" name="reason">' +
        '<option value="all"' + (state.reason === 'all' ? ' selected' : '') + '>Any reason</option>' +
        D.REJECT_ORDER.map(function (k) {
          return '<option value="' + k + '"' + (state.reason === k ? ' selected' : '') + '>' +
            esc(D.rejectLabel(k)) + '</option>';
        }).join('') +
        '</select></div>';
    }

    if (fields.indexOf('sold') !== -1) {
      html += '<div class="field"><label for="f-sold">Sold type</label>' +
        '<select id="f-sold" name="sold">' +
        [['all', 'Any outcome'], ['ph', 'Priority or Hot'],
         ['livetransfer', 'Live transfer'], ['appointment', 'Appointment'],
         ['priority', 'Priority'], ['hot', 'Hot'],
         ['auction', 'Auction'], ['marketplace', 'Marketplace'], ['unsold', 'Not yet sold']].map(function (o) {
          return '<option value="' + o[0] + '"' + (state.sold === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') +
        '</select></div>';
    }

    /* Apply and the window summary share a centred flex row, so the date sits
       on the same optical line as the word "Apply" instead of hanging off the
       bottom edge of the button. */
    html += '<div class="spacer"></div>' +
      '<div class="filters-apply">' +
      '<button type="submit" class="btn btn-primary">Apply</button>' +
      /* Only advertise the window on pages that actually scope by it — the
         scorecard is fixed to a rolling 30 days and saying "7 days" there
         would be a lie in small type. */
      (fields.indexOf('range') !== -1
        ? '<span class="applied">' + rangeSummary(state.range) + '</span>'
        : '') +
      '</div></form>';

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
    ['f-campaign', 'f-subid', 'f-status', 'f-reason', 'f-sold'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.addEventListener('change', function () { document.getElementById('filter-form').submit(); });
    });
  }

  /* The score is named for what it covers, so a filtered page can never read
     as the account's number. Scoped to a campaign it is a CAMPAIGN health
     score; unscoped it is the AFFILIATE health score — the volume-weighted
     rollup of those campaigns. One helper so the three pages that show the
     score cannot drift apart. Sub-ID alone does not rename it: a sub-ID cuts
     across campaigns, so the scope is still the account. */
  function healthScoreLabel(state, opts) {
    var scoped = state && state.campaignId && state.campaignId !== 'all';
    var label = scoped ? 'Campaign health score' : 'Affiliate health score';
    return (opts && opts.lower) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
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
    if (!d) return '—';
    /* When the source carries no clock, every row would render "12:00 AM",
       which looks like data rather than the absence of it. */
    var notes = D.datasetNotes && D.datasetNotes();
    if (notes && notes.noTimeOfDay) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
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
      livetransfer: 'badge-livetransfer', appointment: 'badge-appointment',
      priority: 'badge-priority', hot: 'badge-hot',
      auction: 'badge-auction', marketplace: 'badge-market'
    };
    return '<span class="badge ' + (map[soldType] || '') + '"><span class="dot"></span>' +
      D.SOLD_TYPES[soldType].label + '</span>';
  }

  /* ---------------------------------------------------------------------- */
  /* Registry-driven lead cells                                             */
  /* ---------------------------------------------------------------------- */

  /* data.js owns WHICH columns exist for a comp model — that is the security
     boundary. This owns how each one LOOKS. Both the table and the CSV render
     through here, so a new registry entry shows up in both with one addition.

     Every branch treats a missing key as an em dash. That is not defensive
     padding: for a CPL row that was rejected, the outcome keys are genuinely
     absent from the object, and `'soldType' in row` is the permission check. */
  function leadCell(col, row, state) {
    switch (col.key) {
      case 'receivedAt':   return fmtDateTime(row.receivedAt);
      case 'id':           return '<span class="lead-id">' + esc(row.id) + '</span>';
      case 'campaignId':   return '<span style="color:var(--ink-2)">' + esc(row.campaignId) + '</span>';
      case 'assetBand':
        var band = D.ASSET_BY_KEY[row.assetBand];
        return esc(band ? band.label : '—');
      case 'hourSegment':  return esc(D.HOUR_SEGMENT_LABEL[row.hourSegment] || '—');
      case 'dow':          return esc(D.DOW_SHORT[row.dow] || '—');
      /* "Free" is our internal word for a lead that fired no pixel, i.e. one
         we owe nothing on. To the affiliate reading this it just means
         rejected, so say that. */
      case 'status':
        return row.status === 'paid'
          ? '<span class="pill-paid">Paid</span>'
          : '<span class="pill-free">Rejected</span>';
      /* The cell shows the EXACT value the system recorded ("Duplicate",
         "IPQS", "Age Filter"…) so this table reconciles 1:1 against any
         other report cut from the same data — see ADMIN-MAPPING §3. The
         explanation lives behind the hover descriptor, not in the label.
         Fallback to the bucket's plain label covers the XML-payload rows and
         the generated mock, which have no raw string. */
      case 'rejectReason':
        if (!row.rejectReason) return '—';
        return '<span style="color:var(--ink-2)">' +
          esc(row.rejectReasonRaw || D.rejectLabel(row.rejectReason)) + '</span>' +
          tip(D.rejectDesc(row.rejectReason, state.partnerId));
      case 'soldType':     return 'soldType' in row ? soldBadge(row.soldType) : '—';
      case 'soldAt':       return row.soldAt ? fmtDate(row.soldAt) : '—';
      case 'daysToSale':   return row.daysToSale == null ? '—' : String(row.daysToSale);
      case 'saleAmount':   return row.saleAmount ? fmtMoney(row.saleAmount) : '—';
      case 'partnerShare': return row.partnerShare ? fmtMoney(row.partnerShare) : '—';
      default:             return esc(row[col.key] == null ? '—' : row[col.key]);
    }
  }

  /** Same column, as a flat CSV value. */
  function leadCsvValue(col, row, state) {
    switch (col.key) {
      case 'receivedAt':   return row.receivedAt.toISOString();
      case 'assetBand':
        var band = D.ASSET_BY_KEY[row.assetBand];
        return band ? band.label : '';
      case 'hourSegment':  return D.HOUR_SEGMENT_LABEL[row.hourSegment] || '';
      case 'dow':          return D.DOW_LABEL[row.dow] || '';
      case 'status':       return row.status === 'paid' ? 'Paid' : 'Rejected';
      case 'rejectReason':
        /* CSV carries the exact system value too, so an affiliate's export
           reconciles against ours cell for cell. */
        return row.rejectReason
          ? (row.rejectReasonRaw || D.rejectLabel(row.rejectReason)) : '';
      case 'soldType':     return row.soldType ? D.SOLD_TYPES[row.soldType].label : '';
      case 'soldAt':       return row.soldAt ? isoDate(row.soldAt) : '';
      case 'daysToSale':   return row.daysToSale == null ? '' : row.daysToSale;
      case 'saleAmount':   return row.saleAmount ? row.saleAmount.toFixed(2) : '';
      case 'partnerShare': return row.partnerShare ? row.partnerShare.toFixed(2) : '';
      default:             return row[col.key] == null ? '' : row[col.key];
    }
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

  /**
   * Replace a card's body with an honest "this export cannot support it"
   * state. A widget fed a field the data does not carry renders zeros, and
   * zeros read as a finding — "your early-morning volume is 0%" is a lie when
   * the truth is "the export has no clock."
   */
  /* ======================================================================
     NOT CONNECTED YET — the one way this UI says "no data here"
     ----------------------------------------------------------------------
     THE DASHBOARD IS BUILT AGAINST A BACKEND, NOT AGAINST A FILE. While it
     is in testing it happens to be reading a lead export, but that is a
     temporary source and NOTHING AFFILIATE-FACING MAY MENTION IT. A partner
     reading "the lead export does not carry this" learns about our internal
     plumbing and reads a permanent-sounding limitation; the same gap phrased
     as "not connected yet" reads as a field that will fill in, which is what
     it is.

     So: a field with no source renders BLANK plus this note, never a zero,
     never an invented value, and never an explanation of where our data
     currently comes from. When the field is wired on the backend it simply
     populates and the note disappears — no copy change anywhere.

     Internal surfaces (admin-preview, the data-connections page, HANDOFF and
     ADMIN-MAPPING) are exempt: naming the export is exactly their job.
     ====================================================================== */
  function notConnected(what) {
    return '<span style="color:var(--ink-muted)">—</span>' +
      tip((what ? what + ' is not connected yet. ' : 'Not connected yet. ') +
          'This fills in automatically once the field is wired up on our side — ' +
          'there is nothing for you to do.');
  }

  /* Same idea, as plain text for places that cannot take markup. */
  var NOT_CONNECTED_TEXT = 'Not connected yet';

  function unsupported(cardEl, title, reason) {
    if (!cardEl) return;
    cardEl.querySelectorAll('.table-wrap, .card-body, .card-foot').forEach(function (n) { n.remove(); });
    var d = document.createElement('div');
    d.className = 'card-body';
    d.innerHTML =
      '<div class="notice notice-warn" style="margin:6px 0 0">' +
        '<span class="ico">▲</span><div><strong>' + esc(title) + '</strong><br>' +
        esc(reason) + '</div></div>';
    cardEl.appendChild(d);
  }

  /* ------------------------------------------------------------------------
     Hover descriptors — THE pattern for explaining anything on screen.
     ------------------------------------------------------------------------
     Wherever a label, header, badge or value needs an explanation, the
     explanation does NOT go in the label. The label stays short, and a small
     "i" button sits to its right; hovering (or keyboard-focusing) it shows a
     brief box. Usage from any page:

         html += 'Duplicate' + A.tip('Already sold as Priority or Hot in the last 365 days.');

     One fixed-position box is shared by every tip on the page and follows
     whichever button is hovered. Fixed positioning is deliberate: tips live
     inside .table-wrap containers that scroll, and an absolutely-positioned
     box would be clipped by them. */
  function tip(text, ariaLabel) {
    if (!text) return '';
    return '<button type="button" class="tip-btn" data-tip="' + esc(text) + '"' +
      ' aria-label="' + esc(ariaLabel || 'What does this mean?') + '">i</button>';
  }

  /**
   * Same bubble, but the body may carry markup — a short list rather than a
   * run-on sentence. Used by the health-score breakdown, where each pillar's
   * inputs read as bullets.
   *
   * The markup is OURS, assembled in page code from escaped values; this is
   * not a hole for user content. Anything variable going in must still pass
   * through esc() first, exactly as the callers do.
   */
  function tipHtml(html, ariaLabel) {
    if (!html) return '';
    return '<button type="button" class="tip-btn is-rich" data-tip-html="' + esc(html) + '"' +
      ' aria-label="' + esc(ariaLabel || 'What does this mean?') + '">i</button>';
  }

  function wireTips() {
    if (document.getElementById('fz-tipbox')) return;
    var box = document.createElement('div');
    box.id = 'fz-tipbox';
    box.setAttribute('role', 'tooltip');
    document.body.appendChild(box);

    function show(btn) {
      var rich = btn.getAttribute('data-tip-html');
      if (rich) { box.innerHTML = rich; box.classList.add('is-rich'); }
      else { box.textContent = btn.getAttribute('data-tip'); box.classList.remove('is-rich'); }
      box.style.display = 'block';
      var r = btn.getBoundingClientRect();
      var bw = box.offsetWidth, bh = box.offsetHeight;
      var left = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
      var top = r.top - bh - 8;
      if (top < 8) top = r.bottom + 8;          /* flip below near the top edge */
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
    }
    function hide() { box.style.display = 'none'; }

    document.addEventListener('mouseover', function (e) {
      var btn = e.target.closest && e.target.closest('.tip-btn');
      if (btn) show(btn); else if (!e.target.closest || !e.target.closest('#fz-tipbox')) hide();
    });
    document.addEventListener('focusin', function (e) {
      var btn = e.target.closest && e.target.closest('.tip-btn');
      if (btn) show(btn); else hide();
    });
    document.addEventListener('scroll', hide, true);
  }

  /**
   * A modal. Closes on the ✕, on the backdrop, and on Escape; focus moves to
   * the close button so keyboard users are not stranded behind it.
   */
  function openModal(opts) {
    var back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-label', opts.title || 'Information');
    back.innerHTML =
      '<div class="modal-card">' +
        '<div class="modal-head">' +
          '<h2>' + esc(opts.title || '') + '</h2>' +
          '<button type="button" class="modal-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="modal-body">' + (opts.html || '') + '</div>' +
      '</div>';

    function close() {
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (opts.returnFocusTo) opts.returnFocusTo.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('.modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    document.body.appendChild(back);
    back.querySelector('.modal-close').focus();
    return close;
  }

  /** Small circular "i" that opens a modal. Appended to `host`. */
  /**
   * Scroll to a target and, if it is a <details>, open it first.
   *
   * SMOOTH SCROLLING IS NOT UNIVERSALLY HONOURED — some engines and some
   * embedded viewers accept the call and never move. A navigation affordance
   * that silently does nothing is worse than an abrupt jump, so if nothing
   * has shifted shortly after, jump. Same fallback the Performance overview's
   * Acceptance-rate tile uses.
   */
  function revealAndScroll(target) {
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;

    /* Focus BEFORE scrolling, with preventScroll, so a keyboard user lands on
       the section rather than watching it slide past. */
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });

    var reduce = global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { target.scrollIntoView({ block: 'start' }); return; }

    var before = global.pageYOffset;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function () {
      if (Math.abs(global.pageYOffset - before) < 2 &&
          Math.abs(target.getBoundingClientRect().top) > 4) {
        target.scrollIntoView({ block: 'start' });
      }
    }, 350);
  }

  /**
   * @param opts.action  fn() — replaces the default modal. Use when the
   *   explanation already lives somewhere on the page: two copies of the same
   *   text drift apart, and the one in the modal is the one nobody updates.
   */
  /* ======================================================================
     CREATIVES UPLOAD — one widget, two homes
     ----------------------------------------------------------------------
     Rendered on the Targeting page (change what you are running) and on the
     per-campaign setup tracker (get a new campaign approved). Same component
     both places, because it is the same act and a partner should not have to
     learn it twice.

     THREE STATES, and the affiliate can only ever cause the first transition:

       none      -> "Upload creatives for approval"
       pending   -> "Pending review", upload button becomes "Upload a new version"
       approved  -> "Approved", the files are listed and viewable

     NOTHING AN AFFILIATE DOES CAN APPROVE THEIR OWN CREATIVE. submit() always
     lands on pending; approval is written by our side.

     PARTNER-FACING COPY IS ABOUT COMPLIANCE REVIEW AND NOTHING ELSE. The
     per-campaign creative record is also what lets us attribute leads back to
     the creative that produced them, but that is internal (ADMIN-MAPPING §8)
     and must not appear here in any form.
     ====================================================================== */
  function creativesPanel(host, opts) {
    if (!host) return;
    var partnerId = opts.partnerId, campaignId = opts.campaignId;

    function render() {
      var c = D.creativesFor(partnerId, campaignId);
      var isNone = c.status === 'none';

      var files = c.files.length
        ? '<div style="margin-top:12px">' +
            '<div class="tile-label">' + (c.status === 'approved' ? 'Approved creatives' : 'Submitted') +
            '</div>' +
            '<ul style="margin:6px 0 0;padding-left:18px;font-size:13.5px">' +
            c.files.map(function (f) {
              return '<li style="margin:3px 0">' + esc(f.name) +
                (c.status === 'approved'
                  ? ' <a href="#" data-cre-view="' + esc(f.name) + '">View</a>'
                  : '') + '</li>';
            }).join('') +
            '</ul></div>'
        : '';

      var when = c.status === 'approved' && c.reviewedAt
        ? 'Approved ' + fmtDate(c.reviewedAt) + '.'
        : c.status === 'pending' && c.submittedAt
        ? 'Uploaded ' + fmtDate(c.submittedAt) + '. Most reviews come back within two business days.'
        : '';

      host.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-primary" data-cre-upload>' +
            (isNone ? 'Upload creatives for approval' : 'Upload a new version') +
          '</button>' +
          '<span class="badge ' + c.badge + '"><span class="dot"></span>' +
            esc(c.statusLabel) + '</span>' +
          (c.status === 'pending'
            ? tip('We review every creative for compliance before it can run. You will see this ' +
                  'switch to Approved here, and your account manager will let you know if ' +
                  'anything needs changing.')
            : '') +
        '</div>' +
        (when ? '<div class="tile-sub" style="margin-top:8px">' + when + '</div>' : '') +
        (isNone
          ? '<div class="tile-sub" style="margin-top:8px">Every creative gets a compliance ' +
            'review before it runs. Upload what you plan to use and we will come back to you.</div>'
          : '') +
        files +
        '<input type="file" multiple accept="image/*,.pdf,.html,.zip" ' +
          'data-cre-file style="display:none">';

      var fileInput = host.querySelector('[data-cre-file]');
      host.querySelector('[data-cre-upload]').addEventListener('click', function () {
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        var picked = Array.prototype.slice.call(fileInput.files || []);
        if (!picked.length) return;
        D.submitCreatives(partnerId, campaignId, picked);
        render();
        if (opts.onChange) opts.onChange();
      });

      host.querySelectorAll('[data-cre-view]').forEach(function (a2) {
        a2.addEventListener('click', function (e) {
          e.preventDefault();
          openModal({
            title: a2.dataset.creView,
            html: '<div class="notice notice-info"><span class="ico">\u25c6</span><div>' +
              'Preview opens here once creative storage is connected. Your account manager can ' +
              'send you the approved file in the meantime.</div></div>',
            returnFocusTo: a2
          });
        });
      });
    }

    render();
    return { refresh: render };
  }

  /**
   * The team, by subject. Shared so the Setup page and anywhere else that
   * needs it stay identical.
   *
   * An entry with no email on file routes to the account manager rather than
   * printing an address we made up — a wrong mailto is worse than one more
   * hop, because the partner never learns the mail went nowhere.
   */
  function teamContacts() {
    var am = D.ACCOUNT_MANAGER;
    return '<div class="team-grid">' + D.TEAM_CONTACTS.map(function (c) {
      var mail = c.email
        ? '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>'
        : '<span style="color:var(--ink-muted)">via ' + esc(am.name) + '</span>' +
          tip('We do not have a direct address on file for ' + c.name + ' yet. Send it to ' +
              am.name + ' and it gets there \u2014 he routes it the same day.');
      return '<div class="team-card' + (c.primary ? ' is-primary' : '') + '">' +
        '<div class="team-what">' + esc(c.what) + '</div>' +
        '<div class="team-who">' + esc(c.name) + '</div>' +
        '<div class="team-role">' + esc(c.title) + '</div>' +
        '<div class="team-mail">' + mail + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function infoButton(host, opts) {
    if (!host) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'info-btn';
    b.textContent = 'i';
    b.setAttribute('aria-label', opts.ariaLabel || ('About ' + (opts.title || 'this')));
    b.title = opts.ariaLabel || ('About ' + (opts.title || 'this'));
    b.addEventListener('click', function () {
      if (opts.action) { opts.action(); return; }
      openModal({
        title: opts.title,
        html: typeof opts.html === 'function' ? opts.html() : opts.html,
        returnFocusTo: b
      });
    });
    host.appendChild(b);
    return b;
  }

  function quote(v) {
    if (v == null) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * Export control — download a CSV, or send it to Google Drive.
   *
   * The CSV download is real and works. **Google Drive is mocked**: it shows
   * the confirmation an affiliate would see and nothing leaves the browser.
   * Wiring it up needs a Drive OAuth scope per partner and a service account —
   * see HANDOFF.md before anyone assumes this half exists.
   *
   * Both paths serialise the SAME projected rows the table renders, so a CPL
   * partner's export cannot carry a revenue column: the field is not on the
   * object to begin with.
   */
  function exportControl(host, getExport) {
    host.innerHTML =
      '<div class="export">' +
        '<button type="button" class="btn btn-sm" data-export-toggle>Export ▾</button>' +
        '<div class="export-menu" data-export-menu>' +
          '<button type="button" data-export="csv">' +
            '<span class="ico">↓</span>' +
            '<span><strong>Download CSV</strong>' +
            '<span class="sub">Opens in Excel or Sheets</span></span>' +
          '</button>' +
          '<button type="button" data-export="drive">' +
            '<span class="ico">▲</span>' +
            '<span><strong>Send to Google Drive</strong>' +
            '<span class="sub">Saves to your shared reports folder</span></span>' +
          '</button>' +
        '</div>' +
      '</div>';

    var menu = host.querySelector('[data-export-menu]');
    var toggle = host.querySelector('[data-export-toggle]');

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('is-open');
    });
    document.addEventListener('click', function () { menu.classList.remove('is-open'); });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });

    host.querySelectorAll('[data-export]').forEach(function (b) {
      b.addEventListener('click', function () {
        menu.classList.remove('is-open');
        var spec = getExport();
        if (b.dataset.export === 'csv') {
          exportCsv(spec.rows, spec.columns, spec.filename);
          toast(spec.toastHost, 'Downloaded <strong>' + esc(spec.filename) + '</strong> — ' +
            fmtInt(spec.rows.length) + ' rows.');
        } else {
          toast(spec.toastHost,
            'Saved <strong>' + esc(spec.filename) + '</strong> to Google Drive → ' +
            '<strong>Financialize Reports</strong>. ' +
            '<span style="color:var(--ink-muted)">Mock-up — nothing was actually sent.</span>');
        }
      });
    });
  }

  function toast(host, html) {
    if (!host) return;
    host.innerHTML = '<div class="export-toast"><span>✓</span><span>' + html + '</span></div>';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { host.innerHTML = ''; }, 8000);
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

  /* ONE account-manager block, used by every page that shows one (the
     Partnership summary hero and Setup & docs today). Two pages rendering
     the same person in two designs read as two different contacts. */
  function accountManagerBlock() {
    var am = D.ACCOUNT_MANAGER;
    return '<div class="contact-block">' +
      '<div class="hero-label" style="margin-bottom:6px">Account manager</div>' +
      '<div class="who">' + esc(am.name) + '</div>' +
      '<div class="role">' + esc(am.title) + '</div>' +
      '<div class="mail"><a href="mailto:' + esc(am.email) + '">' + esc(am.email) + '</a></div>' +
      '<div class="actions">' +
        '<a class="btn btn-sm" href="mailto:' + esc(am.email) + '" target="_blank" rel="noopener">✉ Email</a>' +
        '<a class="btn btn-sm" href="' + esc(am.chatUrl) + '" target="_blank" rel="noopener">💬 Google Chat</a>' +
      '</div>' +
    '</div>';
  }

  global.FZApp = {
    params: params,
    shell: shell,
    accountManagerBlock: accountManagerBlock,
    teamContacts: teamContacts,
    filterBar: filterBar,
    linkTo: linkTo,
    isoDate: isoDate,
    rangeSummary: rangeSummary,
    healthScoreLabel: healthScoreLabel,
    esc: esc,
    fmtInt: fmtInt,
    fmtPct: fmtPct,
    fmtMoney: fmtMoney,
    fmtMoney0: fmtMoney0,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    soldBadge: soldBadge,
    leadCell: leadCell,
    leadCsvValue: leadCsvValue,
    deltaHtml: deltaHtml,
    exportCsv: exportCsv,
    exportControl: exportControl,
    unsupported: unsupported,
    notConnected: notConnected,
    NOT_CONNECTED_TEXT: NOT_CONNECTED_TEXT,
    openModal: openModal,
    tip: tip,
    tipHtml: tipHtml,
    infoButton: infoButton,
    revealAndScroll: revealAndScroll,
    creativesPanel: creativesPanel,
    viewToggle: viewToggle
  };

})(window);
