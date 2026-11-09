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

    var tabs = [['month', 'Month'], ['items', 'Items'], ['stock', 'Stock'], ['buying', 'Buying'], ['cash', 'Cash'], ['alerts', 'Alerts']];
    var segs = h('div', { class: 'segs seg6', role: 'group', 'aria-label': 'Report' }, tabs.map(function (t) {
      return h('button', { type: 'button', class: 'seg', 'aria-pressed': String(tab === t[0]), onclick: function () { go(t[0]); } }, t[1]);
    }));
    var nav = (tab === 'month' || tab === 'items' || tab === 'buying') ? h('div', { class: 'monthnav' },
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous month', onclick: function () { go(tab, new Date(month.getFullYear(), month.getMonth() - 1, 1)); } }, icon('back')),
      h('b', {}, label),
      h('button', { class: 'iconbtn flip', type: 'button', 'aria-label': 'Next month', onclick: function () { go(tab, new Date(month.getFullYear(), month.getMonth() + 1, 1)); } }, icon('back'))) : null;
    var body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
    show(h('div', {}, C.header('Reports', C.goHome), segs, nav, body));

    function put(node) { body.replaceChildren(node); }
    function failure(e) { put(h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + e.message)); }
    function note(t) { return h('p', { class: 'dash-note', style: 'margin-top:14px' }, icon('info'), h('span', {}, t)); }

    // Sales of each count-to-count period spread evenly over the business days it covers (same rule as the database).
    function byDay(periods, o) {
      var acc = {}, DAY = 86400000;
      function d(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
      function back(t) { return new Date(t).toISOString().slice(0, 10); }
      periods.forEach(function (p) {
        var lo = p.to_on === p.from_on ? d(p.to_on) : d(p.from_on) + (1 - o) * DAY;
        var hi = d(p.to_on) - (p.to_on === p.from_on ? 0 : o * DAY);
        var n = Math.round((hi - lo) / DAY) + 1;
        if (!(n > 0)) return;
        for (var t = lo; t <= hi; t += DAY) {
          var k = back(t);
          if (k < m0 || k > m1) continue;
          var a = acc[k] = acc[k] || { day: k, sales_value: 0, gross_profit: null };
          a.sales_value += Number(p.sales_value || 0) / n;
          if (p.gross_profit != null) a.gross_profit = (a.gross_profit || 0) + Number(p.gross_profit) / n;
        }
      });
      return Object.keys(acc).sort().map(function (k) { return acc[k]; });
    }

    // ---------------------------------------------------------------- month
    if (tab === 'month') {
      Promise.all([
        // only periods that end in this month or later; the old daily view worked through all history every time
        sb.from('v_item_periods').select('from_on,to_on,sales_value,gross_profit').gte('to_on', m0),
        sb.from('cash_handovers').select('salary_kept').gte('handed_on', m0).lte('handed_on', m1),
        sb.from('expenses').select('amount').gte('spent_on', m0).lte('spent_on', m1),
        sb.from('wastage').select('qty,item_id').gte('wasted_on', m0).lte('wasted_on', m1),
        sb.from('item_costs').select('item_id,avg_cost'),
        sb.from('canteens').select('count_timing').limit(1)
      ]).then(function (r) {
        var bad = r.filter(function (x) { return x.error; })[0];
        if (bad) return failure(bad.error);
        var days = byDay(r[0].data || [], r[5].data && r[5].data[0] && r[5].data[0].count_timing === 'start_of_day' ? 1 : 0);
        var sales = sum(days, function (d) { return d.sales_value; });
        var seeCost = r[4].data && r[4].data.length > 0;
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


    // ---------------------------------------------------------------- stock value
    // Stock on the shelf now = last count + purchases since - wastage since, worked out by the database.
    // Items bought but never counted are included (they start from 0 before their first purchase).
    if (tab === 'stock') {
      (async function () {
        var r = await sb.from('v_item_status').select('item_id,name,sell_price,avg_cost,last_counted_on,last_count_qty,purchased_since,stock_qty');
        if (r.error) return failure(/column/i.test(r.error.message || '') ? { message: 'Run the database update 006_new_items_stock_speed.sql first.' } : r.error);
        var st = r.data || [], qty = {};
        st.forEach(function (x) { if (x.last_count_qty != null || Number(x.purchased_since) > 0) qty[x.item_id] = Number(x.stock_qty); });
        var rows = [], uncounted = [], noPrice = 0, noCost = 0, seeCost = false;
        st.forEach(function (x) {
          if (qty[x.item_id] == null) { uncounted.push(x.name); return; }
          var q = Math.max(0, qty[x.item_id]);
          var sell = x.sell_price != null ? q * Number(x.sell_price) : null;
          var cost = x.avg_cost != null ? q * Number(x.avg_cost) : null;
          if (x.avg_cost != null) seeCost = true;
          if (sell == null) noPrice++; if (cost == null) noCost++;
          rows.push({ name: x.name, q: q, sell: sell, cost: cost });
        });
        rows.sort(function (a, b) { return (b.sell || 0) - (a.sell || 0); });
        var tSell = sum(rows, function (x) { return x.sell; }), tCost = sum(rows, function (x) { return x.cost; });
        var line = function (k, v, cls) { return h('div', { class: 'r-line' }, h('span', {}, k), h('b', { class: 'num ' + (cls || '') }, v)); };
        put(h('div', {},
          h('section', { class: 'sec' }, h('h2', {}, 'Stock on the shelf now'),
            line('Worth at selling price', rs(tSell)),
            seeCost ? line('Worth at cost price', rs(tCost)) : null,
            seeCost ? line('Profit if all sold', rs(tSell - tCost), 'pos') : null,
            h('p', { class: 'hint' }, 'Last count plus purchases and minus wastage since (new items: what was bought). It is only as fresh as your last count.')),
          h('section', { class: 'sec' }, h('h2', {}, 'By item'),
            rows.length ? rows.map(function (x) {
              return h('div', { class: 'item-row' },
                h('span', { class: 'item-main' }, h('b', {}, x.name), h('span', { class: 'muted' }, (Math.round(x.q * 100) / 100) + ' in stock')),
                h('span', { class: 'item-main', style: 'text-align:right' },
                  h('b', { class: 'num' }, x.sell != null ? rs(x.sell) : 'no price'),
                  seeCost ? h('span', { class: 'muted' }, 'cost ' + (x.cost != null ? rs(x.cost) : 'unknown')) : null));
            }) : h('p', { class: 'muted' }, 'No stock yet. Enter a purchase or do a stock count.'),
            (noPrice || noCost) ? h('p', { class: 'hint' }, [noPrice ? noPrice + ' without a selling price' : '', noCost ? noCost + ' without a cost' : ''].filter(Boolean).join(', ') + ' are left out of those totals.') : null,
            uncounted.length ? h('p', { class: 'hint' }, 'No stock recorded yet: ' + uncounted.join(', ') + '.') : null)));
      })().catch(failure);
    }

    // ---------------------------------------------------------------- buying (purchases paid and left)
    if (tab === 'buying') {
      Promise.all([
        sb.from('purchase_bills').select('id,supplier_id,bill_date,total_amount,amount_paid,pending_amount').gte('bill_date', m0).lte('bill_date', m1),
        sb.from('v_supplier_balances').select('supplier_id,name,total_bought,total_paid,balance_owed')
      ]).then(function (r) {
        if (r[0].error) return failure(r[0].error);
        var bills = r[0].data || [], sup = r[1].error ? null : (r[1].data || []);
        var bought = sum(bills, function (b) { return b.total_amount; });
        var paid = sum(bills, function (b) { return b.amount_paid; });
        var line = function (k, v, cls) { return h('div', { class: 'r-line' }, h('span', {}, k), h('b', { class: 'num ' + (cls || '') }, v)); };
        var owing = sup ? sup.filter(function (x) { return Number(x.balance_owed) > 0.5; }).sort(function (a, b) { return b.balance_owed - a.balance_owed; }) : [];
        put(h('div', {},
          h('section', { class: 'sec' }, h('h2', {}, 'Bought in ' + label),
            line('Purchases (' + bills.length + ' bills)', rs(bought)),
            line('Paid on these bills', rs(paid)),
            line('Left to pay on these bills', rs(bought - paid), bought - paid > 0.5 ? 'neg' : '')),
          sup ? h('section', { class: 'sec' }, h('h2', {}, 'Owed to suppliers now'),
            line('All purchases ever', rs(sum(sup, function (x) { return x.total_bought; }))),
            line('Paid so far', rs(sum(sup, function (x) { return x.total_paid; }))),
            line('Left to pay', rs(sum(sup, function (x) { return x.balance_owed; })), sum(sup, function (x) { return x.balance_owed; }) > 0.5 ? 'neg' : ''),
            owing.length ? h('div', { style: 'margin-top:8px' }, owing.map(function (x) {
              return h('div', { class: 'item-row' }, h('b', {}, x.name), h('b', { class: 'num neg' }, rs(x.balance_owed)));
            })) : h('p', { class: 'muted', style: 'margin-top:8px' }, 'Nothing owed to any supplier.'),
            h('p', { class: 'hint' }, 'Includes payments recorded on the Suppliers screen.')) : null));
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
