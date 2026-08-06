/* ==========================================================================
   tables.js — sortable, resizable, column-configurable data tables
   --------------------------------------------------------------------------
   One enhancer applied to every <table class="data"> in the portal.

   TWO SORT MODES, and picking the right one matters:

     DOM mode (default) — the table already holds every row, so sorting the
       <tbody> sorts the whole dataset. Used by every fully-rendered table.

     MANAGED mode — the page passes `data` and `onSort`. Used by the lead
       table, which paginates: sorting the 50 rendered rows would sort one
       page and silently mislead. In managed mode the module sorts the FULL
       filtered array and hands it back for a re-render from page 1.

   Sort state and hidden columns persist per page per table in sessionStorage,
   so paging through the lead table does not reset the sort the user chose.
   In production column visibility should be a stored user preference — see
   ADMIN-MAPPING.md.
   ========================================================================== */

(function (global) {
  'use strict';

  var MIN_COL_PX = 60;

  function storeKey(table) {
    var page = (global.location.pathname.split('/').pop() || 'index') .replace('.html', '');
    return 'fz_tbl_' + page + '_' + (table.id || 't');
  }

  function loadState(table) {
    try {
      var raw = sessionStorage.getItem(storeKey(table));
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { sort: null, dir: 'asc', hidden: [], widths: {} };
  }

  function saveState(table, st) {
    try { sessionStorage.setItem(storeKey(table), JSON.stringify(st)); } catch (e) {}
  }

  /* ---------------------------------------------------------------------- */
  /* Value coercion                                                         */
  /* ---------------------------------------------------------------------- */

  /* A cell may carry data-sort to sort by something other than what it shows
     (a badge, a formatted date, a bar). Otherwise the visible text is parsed:
     currency and percentages become numbers, dates become timestamps, and
     everything else compares as lowercase text. */
  function coerce(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '' || s === '—' || s === '-' || s === 'n/a') return { empty: true };

    var numish = s.replace(/[$,%\s]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(numish)) return { num: parseFloat(numish) };

    /* "12d" / "3 days" */
    var dm = /^(-?\d+(?:\.\d+)?)\s*(d|days?|h|hrs?)$/i.exec(s);
    if (dm) return { num: parseFloat(dm[1]) };

    /* Only try dates on strings that look like one, so "Priority" is not
       accidentally parsed as a date by a lenient engine. */
    if (/\d{4}|^\w{3}\s+\d{1,2}/.test(s)) {
      var t = Date.parse(s);
      if (!isNaN(t)) return { num: t };
    }
    return { str: s.toLowerCase() };
  }

  function cellValue(td) {
    if (!td) return { empty: true };
    if (td.dataset && td.dataset.sort !== undefined) return coerce(td.dataset.sort);
    return coerce(td.textContent);
  }

  /* Empty cells always sort last, in BOTH directions. Flipping the direction
     should not float a column of dashes to the top. */
  function compare(a, b, dir) {
    if (a.empty && b.empty) return 0;
    if (a.empty) return 1;
    if (b.empty) return -1;
    var r;
    if ('num' in a && 'num' in b) r = a.num - b.num;
    else r = String('str' in a ? a.str : a.num).localeCompare(String('str' in b ? b.str : b.num));
    return dir === 'desc' ? -r : r;
  }

  /* ---------------------------------------------------------------------- */
  /* Enhance                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * @param {HTMLTableElement} table
   * @param {object} opts
   *   controlsHost {Element}  where the Columns button goes (optional)
   *   data         {Array}    full row set — enables MANAGED mode
   *   sortValue    {function(row, colIndex) -> any}  managed-mode accessor
   *   onSort       {function(sortedData, colIndex, dir)}  managed-mode callback
   *   labels       {Array<string>}  header labels override
   */
  function enhance(table, opts) {
    if (!table) return null;
    opts = opts || {};

    /* Header cells are looked up LIVE, never captured. A managed table
       re-renders its innerHTML on every sort and page change, which detaches
       the previous <th> nodes — a captured array would then style ghosts
       while the visible header sat untouched. */
    function headCells() {
      var th = table.tHead;
      if (!th || !th.rows.length) return [];
      return Array.prototype.slice.call(th.rows[th.rows.length - 1].cells);
    }

    var ths = headCells();
    if (!ths.length) return null;

    var st = loadState(table);
    var managed = !!(opts.data && opts.onSort);

    table.classList.add('is-enhanced');

    /* ---- apply persisted visibility + widths --------------------------- */
    function applyVisibility() {
      var hidden = st.hidden || [];
      var live = headCells();
      var n = live.length;
      live.forEach(function (th, i) {
        th.classList.toggle('col-hidden', hidden.indexOf(i) !== -1);
        if (st.widths && st.widths[i]) {
          th.style.width = st.widths[i] + 'px';
          th.style.minWidth = st.widths[i] + 'px';
        }
      });
      function paintRow(tr) {
        /* Skip rows that span columns (empty states, group headers). */
        if (tr.cells.length !== n) return;
        Array.prototype.forEach.call(tr.cells, function (td, i) {
          td.classList.toggle('col-hidden', hidden.indexOf(i) !== -1);
        });
      }
      Array.prototype.forEach.call(table.tBodies, function (tb) {
        Array.prototype.forEach.call(tb.rows, paintRow);
      });
      if (table.tFoot) Array.prototype.forEach.call(table.tFoot.rows, paintRow);
    }

    /* ---- sort ----------------------------------------------------------- */
    function doSort(idx, dir) {
      st.sort = idx; st.dir = dir;
      saveState(table, st);

      if (managed) {
        var accessor = opts.sortValue || function (row, i) { return row[i]; };
        var copy = opts.data.slice();
        copy.sort(function (a, b) {
          return compare(coerce(accessor(a, idx)), coerce(accessor(b, idx)), dir);
        });
        opts.onSort(copy, idx, dir);
        return;
      }

      var tb = table.tBodies[0];
      if (!tb) return;
      var n = headCells().length;
      var rows = Array.prototype.slice.call(tb.rows)
        .filter(function (tr) { return tr.cells.length === n; });
      if (rows.length < 2) { paintIndicators(); return; }
      rows.sort(function (ra, rb) {
        return compare(cellValue(ra.cells[idx]), cellValue(rb.cells[idx]), dir);
      });
      rows.forEach(function (tr) { tb.appendChild(tr); });
      paintIndicators();
    }

    function paintIndicators() {
      headCells().forEach(function (th, i) {
        th.classList.toggle('sorted', st.sort === i);
        var ind = th.querySelector('.sort-ind');
        if (ind) ind.textContent = st.sort === i ? (st.dir === 'asc' ? '▲' : '▼') : '';
        th.setAttribute('aria-sort', st.sort === i
          ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      });
    }

    /* ---- header wiring -------------------------------------------------- */
    headCells().forEach(function (th, i) {
      if (th.dataset.enhanced) return;
      th.dataset.enhanced = '1';
      th.classList.add('sortable');

      /* Wrap the label so the sort indicator and the resize grip do not fight
         over the same box. */
      var label = document.createElement('span');
      label.className = 'th-label';
      while (th.firstChild) label.appendChild(th.firstChild);
      var ind = document.createElement('span');
      ind.className = 'sort-ind';
      var grip = document.createElement('span');
      grip.className = 'col-grip';
      grip.title = 'Drag to resize';
      th.appendChild(label);
      th.appendChild(ind);
      th.appendChild(grip);

      label.addEventListener('click', function () {
        var dir = (st.sort === i && st.dir === 'asc') ? 'desc' : 'asc';
        doSort(i, dir);
      });
      ind.addEventListener('click', function () {
        var dir = (st.sort === i && st.dir === 'asc') ? 'desc' : 'asc';
        doSort(i, dir);
      });

      /* ---- resize ---- */
      grip.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var startX = e.clientX;
        var startW = th.getBoundingClientRect().width;
        document.body.classList.add('is-col-resizing');

        function move(ev) {
          var w = Math.max(MIN_COL_PX, Math.round(startW + (ev.clientX - startX)));
          th.style.width = w + 'px';
          th.style.minWidth = w + 'px';
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('is-col-resizing');
          st.widths = st.widths || {};
          st.widths[i] = Math.round(th.getBoundingClientRect().width);
          saveState(table, st);
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        th.style.width = ''; th.style.minWidth = '';
        if (st.widths) delete st.widths[i];
        saveState(table, st);
      });
    });

    /* ---- column chooser -------------------------------------------------- */
    if (opts.controlsHost && !opts.controlsHost.dataset.colsWired) {
      opts.controlsHost.dataset.colsWired = '1';
      var wrap = document.createElement('div');
      wrap.className = 'export';
      wrap.innerHTML =
        '<button type="button" class="btn btn-sm" data-cols-toggle>Columns ▾</button>' +
        '<div class="export-menu col-menu" data-cols-menu></div>';
      opts.controlsHost.appendChild(wrap);

      var menu = wrap.querySelector('[data-cols-menu]');
      var btn = wrap.querySelector('[data-cols-toggle]');

      function buildMenu() {
        var labels = opts.labels || headCells().map(function (th) {
          var l = th.querySelector('.th-label');
          return (l ? l.textContent : th.textContent).trim() || 'Column';
        });
        /* Deliberately a div row rather than a <label> wrapping the input.
           A click landing on a checkbox inside its own label fires twice —
           once for the control, once for the label forwarding — which
           toggles the column off and straight back on. */
        menu.innerHTML =
          '<div class="col-menu-head">Show columns</div>' +
          labels.map(function (lab, i) {
            var on = (st.hidden || []).indexOf(i) === -1;
            return '<div class="col-opt" data-col="' + i + '" role="checkbox" tabindex="0" ' +
              'aria-checked="' + on + '">' +
              '<input type="checkbox" tabindex="-1"' + (on ? ' checked' : '') + '>' +
              '<span>' + lab + '</span></div>';
          }).join('') +
          '<div class="col-menu-foot"><button type="button" class="btn btn-sm" data-cols-all>Show all</button></div>';

        menu.querySelectorAll('[data-col]').forEach(function (row) {
          function toggle() {
            var i = parseInt(row.dataset.col, 10);
            var box = row.querySelector('input');
            st.hidden = st.hidden || [];
            var at = st.hidden.indexOf(i);
            var willHide = at === -1;

            /* Never let the last visible column be switched off. */
            if (willHide && st.hidden.length + 1 >= headCells().length) return;

            if (willHide) st.hidden.push(i); else st.hidden.splice(at, 1);
            box.checked = !willHide;
            row.setAttribute('aria-checked', String(!willHide));
            saveState(table, st);
            applyVisibility();
          }
          row.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
          row.addEventListener('keydown', function (e) {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
          });
        });
        menu.querySelector('[data-cols-all]').addEventListener('click', function () {
          st.hidden = [];
          saveState(table, st);
          applyVisibility();
          buildMenu();
        });
      }
      buildMenu();

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        buildMenu();
        menu.classList.toggle('is-open');
      });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });
      document.addEventListener('click', function () { menu.classList.remove('is-open'); });
    }

    applyVisibility();
    paintIndicators();

    /* Re-apply a persisted sort on first enhance. In managed mode the page
       owns rendering, so it asks for this explicitly via `applyStoredSort`. */
    if (!managed && st.sort != null) doSort(st.sort, st.dir);

    return {
      state: st,
      sort: doSort,
      refresh: function () { applyVisibility(); paintIndicators(); },
      /* Managed pages call this once, after their first render. */
      applyStoredSort: function () {
        if (managed && st.sort != null) doSort(st.sort, st.dir);
      }
    };
  }

  /** Enhance every data table on the page that has not been wired already. */
  function enhanceAll(opts) {
    var out = [];
    document.querySelectorAll('table.data').forEach(function (t) {
      /* Key/value tables (no thead) are not sortable and are skipped. */
      if (!t.tHead || !t.tHead.rows.length) return;
      out.push(enhance(t, opts || {}));
    });
    return out;
  }

  global.FZTable = { enhance: enhance, enhanceAll: enhanceAll, coerce: coerce };

})(window);
