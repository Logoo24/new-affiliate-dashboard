#!/usr/bin/env python
"""
ingest.py — turn a Financialize lead-table export into the dashboard dataset.

    python tools/ingest.py "C:/path/Lead-Report-08-06-26.csv"

Writes assets/data/dataset.js, which the pages load with a plain <script> tag
(so it works over file:// as well as the dev server).

THE PII RULE
------------
First Name, Last Name, Address, City, Zip Code, Phone, Email and IP Address are
NEVER read into the output. They are listed in PII_COLUMNS below and the writer
asserts none of them appear in the emitted field list. Consumer identity has no
business in a mock-up that gets screen-shared.

INTERNAL COLUMNS
----------------
Profit, Total Cost, Lead Cost, Buyer Name, CSR Name and Call Result are also
never emitted. The dashboard's query layer strips them anyway, but not writing
them is a stronger guarantee than stripping them later.

Everything this script cannot support from the export is recorded in
dataset.notes and rendered on the Data source page, rather than silently
defaulted — a fabricated zero is worse than an honest gap.
"""

import csv, io, json, os, re, sys, collections, datetime

PII_COLUMNS = {'First Name', 'Last Name', 'Address', 'City', 'Zip Code',
               'Phone', 'Email', 'IP Address'}
INTERNAL_COLUMNS = {'Profit', 'Total Cost', 'Lead Cost', 'Buyer Name',
                    'CSR Name', 'Call Result', 'Drain Reason'}

# House / test traffic — real rows, but not affiliate partners, so they do not
# become partner views. Counted and reported rather than dropped silently.
HOUSE_AFFILIATES = {
    'internal', 'dev_test', 'google adwords', 'bing/yahoo search',
    'annuities.net', 'annuity.com',
}

# The tracker spells it OptiLabX; the raw data says ObtilabX. Mapping before
# grouping is the difference between one partner and two half-partners.
NAME_FIXES = {
    'obtilabx': 'OptiLabX Media',
    'annuity heritage group': 'Annuity Heritage Group',
    'instar  inc.': 'InStar Inc.',
    'endless value (max)': 'Endless Value',
    'lift coefficient': 'LiftCoefficient',
    'general growth ltd': 'General Growth',
    'ignite - dani & chris': 'Ignite Media Group',
    'annuity.org': 'Annuity.org',
}

SOLD_TYPE_MAP = {'hot_lead': 'hot', 'priority': 'priority',
                 'auction': 'auction', 'marketplace': 'marketplace'}

ASSET_BANDS = [
    ('end',   'Under $25K',      0,      25000),
    ('low',   '$25K – $50K',     25000,  50000),
    ('mid1',  '$50K – $100K',    50000,  100000),
    ('sweet', '$100K – $250K',   100000, 250000),
    ('mid2',  '$250K – $500K',   250000, 500000),
    ('high',  '$500K+',          500000, 10**12),
]


def norm_ws(s):
    return re.sub(r'\s+', ' ', (s or '').strip())


def money(s):
    s = (s or '').replace('$', '').replace(',', '').strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_date(s):
    """MM-DD-YYYY -> date. The export carries no time component at all."""
    s = (s or '').strip()
    m = re.match(r'^(\d{2})-(\d{2})-(\d{4})$', s)
    if not m:
        return None
    try:
        return datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None


def asset_band(raw):
    """Assets1 arrives as free-ish text with 29 variants, mojibake dashes and
    duplicate spellings. Parse the first number and bucket it."""
    s = norm_ws(raw).lower()
    if not s:
        return None
    if 'advisor' in s or 'disclose' in s:
        return None
    # "$1 Million - $3 Million" / "More than $3 million"
    millions = re.findall(r'([\d.]+)\s*million', s)
    if millions:
        return 'high'
    nums = re.findall(r'\d[\d ,]*', s.replace('$', ''))
    if not nums:
        return None
    try:
        low = int(nums[0].replace(' ', '').replace(',', ''))
    except ValueError:
        return None
    for key, _label, lo, hi in ASSET_BANDS:
        if lo <= low < hi:
            return key
    return 'high'


REJECT_BUCKETS = [
    ('duplicate', ('duplicate',)),
    ('ipqs',      ('ipqs',)),
    ('age',       ('age',)),
    ('assets',    ('asset',)),
    ('state',     ('state',)),
    ('income',    ('household income', 'income')),
    ('contact',   ('disconnected', 'answering machine', 'machine', 'vm full',
                   'hung up', 'connection issue', 'bad lead data',
                   'lead data is not valid', 'not valid')),
    ('interest',  ('not interested',)),
]


def reject_bucket(raw):
    s = norm_ws(raw)
    if not s:
        return None
    low = s.lower()
    # 2,917 distinct values, most of them raw XML error payloads written into
    # the reason field. They are a system fault, not an affiliate fault.
    if low.startswith('<?xml') or '<response>' in low or low.startswith('<'):
        return 'filter_error'
    for key, needles in REJECT_BUCKETS:
        for nd in needles:
            if nd in low:
                return key
    return 'other'


def comp_for_campaign(name, rev_share_pct):
    """Comp model is encoded in the campaign name, and corroborated by the
    Revenue Share column."""
    low = (name or '').lower()
    if 'rev share' in low or 'revshare' in low:
        return 'revshare'
    if rev_share_pct and rev_share_pct >= 0.10:
        return 'revshare'
    return 'cpl'


def product_for_campaign(name):
    low = (name or '').lower()
    if 'life' in low:
        return 'Life'
    return 'Annuity'


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src or not os.path.exists(src):
        sys.exit('usage: python tools/ingest.py <lead-export.csv>')

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = os.path.join(root, 'assets', 'data', 'dataset.js')

    f = io.open(src, encoding='utf-8-sig', newline='')
    reader = csv.DictReader(f)

    rows = []
    aff_rows = collections.Counter()
    aff_id = {}
    camp_meta = {}
    camp_revshare = collections.defaultdict(collections.Counter)
    house_rows = 0
    skipped_nodate = 0
    unparsed_assets = collections.Counter()
    returned_rows = 0
    sold_no_type = 0
    total_in = 0

    for row in reader:
        total_in += 1
        g = lambda k: norm_ws(row.get(k))

        raw_aff = g('Affiliate Name')
        key = raw_aff.lower()
        if key in HOUSE_AFFILIATES:
            house_rows += 1
            continue
        aff = NAME_FIXES.get(key, raw_aff)
        if not aff:
            house_rows += 1
            continue

        recv = parse_date(g('Created On'))
        if recv is None:
            skipped_nodate += 1
            continue
        sold_on = parse_date(g('Booked On'))

        cid = g('CID')
        cname = g('Campaign Name') or ('CID ' + cid)
        rs_pct_raw = g('Revenue Share').replace('%', '')
        try:
            rs_pct = float(rs_pct_raw) / 100.0
        except ValueError:
            rs_pct = 0.0

        aff_rows[aff] += 1
        if cid:
            aff_id.setdefault(aff, g('Affiliate ID'))
            camp_meta.setdefault(cid, {'cid': cid, 'name': cname, 'partner': aff})
            camp_revshare[cid][round(rs_pct, 4)] += 1

        # Response to Affiliate is the pixel outcome: Accept == we owe money.
        # "Accept (Reject)" carries zero cost, so it is not a paid lead.
        paid = g('Response to Affiliate') == 'Accept'

        st = SOLD_TYPE_MAP.get(g('Sold Type').lower())
        if g('Revenue Status') == 'Sold' and not st:
            sold_no_type += 1

        ab = asset_band(g('Assets1'))
        if ab is None and g('Assets1'):
            unparsed_assets[norm_ws(g('Assets1'))] += 1

        ret = bool(g('Return Reason'))
        if ret:
            returned_rows += 1

        try:
            attempts = int(float(g('Call Attempts') or 0))
        except ValueError:
            attempts = 0

        rows.append({
            'id': g('Lead ID'),
            'aff': aff,
            'cid': cid,
            'recv': recv,
            'sold_on': sold_on,
            'paid': paid,
            'rej': reject_bucket(g('Reject Reason')) if not paid else None,
            'st': st,
            'rev': money(g('Revenue')) if st else 0.0,
            'share': money(g('Revenue Share Amount')) if st else 0.0,
            'state': g('State')[:2].upper() if g('State') else '',
            'ab': ab,
            'sub': g('X Sub id'),
            'ret': ret,
            'att': attempts,
        })

    f.close()

    # ---- build registries ------------------------------------------------
    partners = []
    for name, n in aff_rows.most_common():
        pid = re.sub(r'[^a-z0-9]+', '', name.lower())[:12] or 'p'
        partners.append({
            'id': pid, 'name': name, 'affiliateId': aff_id.get(name, ''),
            'rows': n,
        })
    pid_by_aff = {p['name']: p['id'] for p in partners}

    campaigns = []
    for cid, meta in camp_meta.items():
        modal_rs = camp_revshare[cid].most_common(1)[0][0] if camp_revshare[cid] else 0.0
        comp = comp_for_campaign(meta['name'], modal_rs)
        campaigns.append({
            'cid': cid,
            'name': meta['name'],
            'partnerId': pid_by_aff.get(meta['partner'], ''),
            'comp': comp,
            'revSharePct': modal_rs if comp == 'revshare' else 0.0,
            'product': product_for_campaign(meta['name']),
        })
    campaigns.sort(key=lambda c: (c['partnerId'], c['name']))

    # A campaign is ACTIVE if it received any lead in the trailing 6 months of
    # the export window — the rule Logan wants automated. This export only
    # spans ~2 months, so in practice every campaign with a row here is active
    # and the count is reported rather than inferred beyond the data.
    last_by_cid = {}
    for r in rows:
        d = r['recv']
        if r['cid'] and (r['cid'] not in last_by_cid or d > last_by_cid[r['cid']]):
            last_by_cid[r['cid']] = d
    max_date = max(r['recv'] for r in rows)
    for c in campaigns:
        last = last_by_cid.get(c['cid'])
        c['lastLead'] = last.isoformat() if last else None
        c['active'] = bool(last and (max_date - last).days <= 183)

    # ---- encode ----------------------------------------------------------
    epoch = min(r['recv'] for r in rows)
    states = sorted({r['state'] for r in rows if r['state']})
    subids = sorted({r['sub'] for r in rows if r['sub']})
    rejects = sorted({r['rej'] for r in rows if r['rej']})
    sold_types = ['priority', 'hot', 'auction', 'marketplace']
    bands = [b[0] for b in ASSET_BANDS]

    ix = lambda lst: {v: i for i, v in enumerate(lst)}
    p_ix, c_ix = ix([p['id'] for p in partners]), ix([c['cid'] for c in campaigns])
    s_ix, sub_ix, r_ix, st_ix, b_ix = ix(states), ix(subids), ix(rejects), ix(sold_types), ix(bands)

    def cents(x):
        return int(round(x * 100))

    leads = []
    for r in rows:
        leads.append([
            (r['recv'] - epoch).days,
            p_ix[pid_by_aff[r['aff']]],
            c_ix.get(r['cid'], -1),
            1 if r['paid'] else 0,
            r_ix.get(r['rej'], -1),
            st_ix.get(r['st'], -1),
            (r['sold_on'] - epoch).days if r['sold_on'] else -1,
            cents(r['rev']),
            cents(r['share']),
            s_ix.get(r['state'], -1),
            b_ix.get(r['ab'], -1),
            sub_ix.get(r['sub'], -1),
            1 if r['ret'] else 0,
            r['att'],
            r['id'],
        ])

    fields = ['recv', 'partner', 'campaign', 'paid', 'reject', 'soldType',
              'soldOn', 'revenueCents', 'shareCents', 'state', 'assetBand',
              'subid', 'returned', 'attempts', 'leadId']
    for bad in PII_COLUMNS | INTERNAL_COLUMNS:
        assert bad.lower().replace(' ', '') not in [f.lower() for f in fields], bad

    notes = {
        'sourceFile': os.path.basename(src),
        'rowsInExport': total_in,
        'rowsUsed': len(rows),
        'houseRowsExcluded': house_rows,
        'rowsSkippedNoDate': skipped_nodate,
        'dateFrom': epoch.isoformat(),
        'dateTo': max_date.isoformat(),
        'soldMarkedSoldButNoType': sold_no_type,
        'returnedRows': returned_rows,
        'unparsedAssetValues': unparsed_assets.most_common(8),
        # Capability gaps — rendered on the Data source page.
        'noTimeOfDay': True,
        'subidFillPct': round(100.0 * sum(1 for r in rows if r['sub']) / max(1, len(rows)), 1),
        'speedToLeadUsable': False,
        'marginUsable': False,
    }

    payload = {
        'notes': notes,
        'epoch': epoch.isoformat(),
        'partners': partners,
        'campaigns': campaigns,
        'states': states,
        'subids': subids,
        'rejects': rejects,
        'soldTypes': sold_types,
        'assetBands': [{'key': b[0], 'label': b[1]} for b in ASSET_BANDS],
        'fields': fields,
        'leads': leads,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with io.open(out_path, 'w', encoding='utf-8', newline='\n') as out:
        out.write('/* GENERATED by tools/ingest.py — do not edit by hand.\n')
        out.write('   Source: %s\n' % os.path.basename(src))
        out.write('   %d of %d export rows, %s to %s.\n'
                  % (len(rows), total_in, epoch.isoformat(), max_date.isoformat()))
        out.write('   Consumer PII and internal cost/margin columns are never emitted. */\n')
        out.write('window.FZ_DATASET = ')
        json.dump(payload, out, separators=(',', ':'))
        out.write(';\n')

    print('wrote %s  (%.1f MB)' % (out_path, os.path.getsize(out_path) / 1e6))
    print('partners: %d   campaigns: %d   leads: %d' % (len(partners), len(campaigns), len(rows)))
    print('house rows excluded: %d' % house_rows)
    print('sub-id fill: %s%%' % notes['subidFillPct'])
    for p in partners[:24]:
        print('   %-26s %-6s %7d rows' % (p['name'][:26], p['id'], p['rows']))


if __name__ == '__main__':
    main()
