// Reports: month summary, daily sales, best items, cash checks and things that need attention.
// Everything is read from database views; sales come from stock counts, never from typed-in sales.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;

  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function rs(n) { return (Number(n) < 0 ? '−' : '') + 'Rs ' + Math.round(Math.abs(Number(n))).toLocaleString('en-PK'); }
  function niceDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  function sum(a, f) { return a.reduce(function (t, x) { return t + Number(f(x) || 0); }, 0); }
  function show(node) { C.show(node, 'reports'); }

  C.screens.reports = function (me, perms, tab, month) {
    var perm = perms.filter(function (p) { return p.feature === 'reports'; })[0];
    if (!perm || !perm.can_view) { C.toast('Your role cannot open reports.'); return; }
    var now = new Date();
    month = month || new Date(now.getFullYear(), now.getMonth(), 1);
    tab = tab || 'month';
    var m0 = iso(month), m1 = iso(new Date(month.getFullYear(), month.getMonth() + 1, 0));
    var label = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    function go(t, m) { C.screens.reports(me, perms, t, m || month); }

    var tabs = [['month', 'Month'], ['items', 'Items'], ['cash', 'Cash'], ['alerts', 'Alerts']];
    var segs = h('div', { class: 'segs seg4', role: 'group', 'aria-label': 'Report' }, tabs.map(function (t) {
      return h('button', { type: 'button', class: 'seg', 'aria-pressed': String(tab === t[0]), onclick: function () { go(t[0]); } }, t[1]);
    }));
    var nav = (tab === 'month' || tab === 'items') ? h('div', { class: 'monthnav' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous month', onclick: function () { go(tab, new Date(month.getFullYear(), month.getMonth() - 1, 1)); } }, icon('back')),
      h('b', {}, label),
      h('button', { class: 'iconbtn flip', type: 'button', 'aria-label': 'Next month', onclick: function () { go(tab, new Date(month.getFullYear(), month.getMonth() + 1, 1)); } }, icon('back'))) : null;
    var body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
    show(h('div', {}, C.header('Reports', C.goHome), segs, nav, body));

    function put(node) { body.replaceChildren(node); }
    function failure(e) { put(h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + e.message)); }
    function note(t) { return h('p', { class: 'dash-note', style: 'margin-top:14px' }, icon('info'), h('span', {}, t)); }

    // ---------------------------------------------------------------- month
    if (tab === 'month') {
      Promise.all([
        sb.from('v_sales_by_day').select('day,sales_value,gross_profit').gte('day', m0).lte('day', m1).order('day'),
        sb.from('cash_handovers').select('salary_kept').gte('handed_on', m0).lte('handed_on', m1),
        sb.from('expenses').select('amount').gte('spent_on', m0).lte('spent_on', m1),
        sb.from('wastage').select('qty,item_id').gte('wasted_on', m0).lte('wasted_on', m1),
        sb.from('item_costs').select('item_id,avg_cost')
      ]).then(function (r) {
        var bad = r.filter(function (x) { return x.error; })[0];
        if (bad) return failure(bad.error);
        var days = r[0].data || [];
        var sales = sum(days, function (d) { return d.sales_value; });
        var seeCost = days.length ? days[0].gross_profit != null : r[4].data && r[4].data.length > 0;
        var gross = sum(days, function (d) { return d.gross_profit; });
        var salary = sum(r[1].data || [], function (x) { return x.salary_kept; });
        var exp = sum(r[2].data || [], function (x) { return x.amount; });
        var cost = {}; (r[4].data || []).forEach(function (c) { cost[c.item_id] = Number(c.avg_cost); });
        var waste = sum(r[3].data || [], function (w) { return Number(w.qty) * (cost[w.item_id] || 0); });
        var net = gross - salary - waste - exp;
        var max = Math.max.apply(null, days.map(function (d) { return Number(d.sales_value); }).concat([1]));
        var line = function (k, v, cls) { return h('div', { class: 'r-line' }, h('span', {}, k), h('b', { class: 'num ' + (cls || '') }, v)); };
        put(h('div', {},
          h('div', { class: 'dash' },
            h('div', { class: 'stat hero' }, h('span', { class: 'stat-ic' }, icon('chart')), h('span', { class: 'stat-body' },
              h('span', { class: 'stat-label' }, 'Sales in ' + month.toLocaleDateString('en-GB', { month: 'long' })), h('span', { class: 'stat-num' }, rs(sales)))),
            seeCost ? h('div', { class: 'stat wide profit' + (net < 0 ? ' loss' : '') }, h('span', { class: 'stat-ic' }, icon('trend')), h('span', { class: 'stat-body' },
              h('span', { class: 'stat-label' }, 'Net profit'), h('span', { class: 'stat-num' }, rs(net)))) : null),
          seeCost ? h('section', { class: 'sec' }, h('h2', {}, 'Where the money went'),
            line('Sales', rs(sales)), line('Gross profit (sales − cost of goods)', rs(gross)),
            line('Salary kept', rs(-salary)), line('Wastage at cost', rs(-waste)), line('Other expenses', rs(-exp)),
            line('Net profit', rs(net), net < 0 ? 'neg' : 'pos')) : null,
          h('section', { class: 'sec' }, h('h2', {}, 'Sales by day'),
            days.length ? days.map(function (d) {
              return h('div', { class: 'bar-row' }, h('span', { class: 'bar-day' }, niceDate(d.day)),
                h('span', { class: 'bar-track' }, h('i', { style: 'width:' + Math.max(2, Number(d.sales_value) / max * 100) + '%' })),
                h('b', { class: 'num bar-val' }, rs(d.sales_value)));
            }) : h('p', { class: 'muted' }, 'No sales yet this month. They appear once you have two stock counts.')),
          note('Sales between two counts are spread evenly over the days between them.')));
      }, failure);
    }

    // ---------------------------------------------------------------- items
    if (tab === 'items') {
      sb.from('v_item_periods').select('item_name,sold_qty,sales_value,gross_profit').gte('to_on', m0).lte('to_on', m1).then(function (r) {
        if (r.error) return failure(r.error);
        var by = {};
        (r.data || []).forEach(function (x) {
          var a = by[x.item_name] = by[x.item_name] || { name: x.item_name, qty: 0, sales: 0, gross: null };
          a.qty += Number(x.sold_qty || 0); a.sales += Number(x.sales_value || 0);
          if (x.gross_profit != null) a.gross = (a.gross || 0) + Number(x.gross_profit);
        });
        var rows = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.sales - a.sales; });
        put(h('div', {}, h('section', { class: 'sec' }, h('h2', {}, 'Items by sales'),
          rows.length ? rows.map(function (x, i) {
            return h('div', { class: 'item-row' },
              h('span', { class: 'item-main' }, h('b', {}, x.name), h('span', { class: 'muted' }, x.qty + ' sold' + (x.gross != null ? ' · profit ' + rs(x.gross) : ''))),
              h('b', { class: 'num' }, rs(x.sales)));
          }) : h('p', { class: 'muted' }, 'No item sales in this month yet.')),
          note('Items are grouped by the date of the count that closed each period.')));
      }, failure);
    }

    // ---------------------------------------------------------------- cash
    if (tab === 'cash') {
      sb.from('v_period_report').select('*').order('to_on', { ascending: false }).limit(8).then(function (r) {
        if (r.error) return failure(r.error);
        var rows = r.data || [];
        put(h('div', {}, rows.length ? rows.map(function (p) {
          var ok = p.within_tolerance, s = Number(p.shortage);
          var verdict = ok ? 'Cash matches' : s > 0 ? 'Short ' + rs(s) : 'Extra ' + rs(-s);
          return h('section', { class: 'sec' },
            h('div', { class: 'cash-head' }, h('b', {}, niceDate(p.from_on) + ' to ' + niceDate(p.to_on)),
              h('span', { class: 'badge ' + (ok ? 'good' : 'bad') }, verdict)),
            h('div', { class: 'r-line' }, h('span', {}, 'Sales from counts'), h('b', { class: 'num' }, rs(p.sales_value))),
            h('div', { class: 'r-line' }, h('span', {}, 'Cash + salary kept'), h('b', { class: 'num' }, rs(Number(p.cash_handed) + Number(p.salary_kept)))),
            p.actual_net_profit != null ? h('div', { class: 'r-line' }, h('span', {}, 'Net profit after shortage'), h('b', { class: 'num' }, rs(p.actual_net_profit))) : null,
            (Number(p.items_missing) || Number(p.items_negative) || Number(p.items_no_price))
              ? h('p', { class: 'hint' }, 'Check counts and prices for this period: ' + [
                  Number(p.items_missing) ? p.items_missing + ' missing' : '', Number(p.items_negative) ? p.items_negative + ' negative' : '',
                  Number(p.items_no_price) ? p.items_no_price + ' without price' : ''].filter(Boolean).join(', ') + '.') : null);
        }) : h('section', { class: 'sec' }, h('h2', {}, 'Cash checks'),
          h('p', { class: 'muted' }, 'Needs two full stock counts on different days, plus cash handovers.'))));
      }, failure);
    }

    // ---------------------------------------------------------------- alerts
    if (tab === 'alerts') {
      Promise.all([
        sb.from('v_item_status').select('name,margin_flag,margin_pct,sell_price,avg_cost,count_overdue,days_since_count').order('name'),
        sb.from('v_cost_alerts').select('item_name,latest_cost,previous_cost,change_pct')
      ]).then(function (r) {
        if (r[0].error) return failure(r[0].error);
        var st = r[0].data || [], ca = r[1].error ? [] : r[1].data || [];
        var FLAG = { no_cost: 'No cost known. Profit is unreliable.', no_price: 'No selling price set.', below_cost: 'Selling below cost.', low: 'Margin is below your minimum.' };
        var flagged = st.filter(function (x) { return FLAG[x.margin_flag]; });
        var overdue = st.filter(function (x) { return x.count_overdue; });
        var changed = ca.filter(function (x) { return Math.abs(Number(x.change_pct)) >= 3; });
        var empty = !flagged.length && !overdue.length && !changed.length;
        put(h('div', {},
          empty ? h('section', { class: 'sec' }, h('h2', {}, 'All clear'), h('p', { class: 'muted' }, 'No price, cost or count problems found.')) : null,
          flagged.length ? h('section', { class: 'sec' }, h('h2', {}, 'Prices and margins'),
            flagged.map(function (x) { return h('div', { class: 'item-row' }, h('span', { class: 'item-main' }, h('b', {}, x.name), h('span', { class: 'muted' }, FLAG[x.margin_flag])),
              x.margin_pct != null ? h('b', { class: 'num' }, Number(x.margin_pct) + '%') : null); })) : null,
          changed.length ? h('section', { class: 'sec' }, h('h2', {}, 'Cost changed on last purchase'),
            changed.map(function (x) { var up = Number(x.change_pct) > 0;
              return h('div', { class: 'item-row' }, h('span', { class: 'item-main' }, h('b', {}, x.item_name),
                h('span', { class: 'muted' }, rs(x.previous_cost) + ' to ' + rs(x.latest_cost) + ' each. Review the selling price.')),
                h('b', { class: 'num ' + (up ? 'neg' : 'pos') }, (up ? '+' : '') + Number(x.change_pct) + '%')); })) : null,
          overdue.length ? h('section', { class: 'sec' }, h('h2', {}, 'Due for counting'),
            overdue.map(function (x) { return h('div', { class: 'item-row' }, h('span', { class: 'item-main' }, h('b', {}, x.name),
              h('span', { class: 'muted' }, x.days_since_count == null ? 'Never counted' : 'Last counted ' + x.days_since_count + ' days ago'))); })) : null));
      }, failure);
    }
  };
})();
