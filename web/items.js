// Items and prices: the list of things you sell, their selling price (with history), pack size and shelf order.
// New items usually appear when you enter a purchase; this screen is for prices, names, order and hiding items.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;

  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; }
  function rs(n) { return 'Rs ' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
  function niceDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function show(node) { C.show(node, 'items'); }
  function stockText(s) {
    if (s.stock_qty == null || (s.last_count_qty == null && !(Number(s.purchased_since) > 0))) return null;
    return (Math.round(Math.max(0, Number(s.stock_qty)) * 100) / 100) + ' in stock';
  }
  var FLAG = { no_cost: ['No cost yet', 'warn'], no_price: ['No price', 'warn'], below_cost: ['Below cost', 'bad'], low: ['Low margin', 'warn'], good: ['Good margin', 'good'] };

  C.screens.items = async function (me, perms, openId, showHidden) {
    var perm = perms.filter(function (p) { return p.feature === 'items'; })[0];
    if (!perm || (!perm.can_view && !perm.can_add)) { C.toast('Your role cannot open items.'); return; }
    var canAdd = !!perm.can_add, canEdit = !!perm.can_edit;
    function reload(id, hidden) { C.screens.items(me, perms, id, hidden); }

    show(h('div', {}, C.header('Items and prices', C.goHome), h('p', { class: 'muted' }, 'Loading…')));
    var r = await Promise.all([
      sb.from('v_item_status').select('*'),
      sb.from('items').select('id,name,pieces_per_pack,shelf_order,count_every_days,is_active,notes').order('shelf_order').order('name')
    ]);
    var bad = r.filter(function (x) { return x.error; })[0];
    if (bad) { show(h('div', {}, C.header('Items and prices', C.goHome), h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + bad.error.message))); return; }
    var status = {}; (r[0].data || []).forEach(function (s) { status[s.item_id] = s; });
    var all = r[1].data || [];
    var items = all.filter(function (i) { return showHidden ? !i.is_active : i.is_active; });
    var hiddenCount = all.filter(function (i) { return !i.is_active; }).length;
    if (openId) { var it = all.filter(function (i) { return i.id === openId; })[0]; if (it) return detail(it); }

    // ------------------------------------------------------------ list
    var search = h('input', { type: 'search', placeholder: 'Search items', 'aria-label': 'Search items', autocomplete: 'off' });
    var rows = items.map(function (i) {
      var s = status[i.id] || {}, f = FLAG[s.margin_flag];
      var bits = [s.sell_price != null ? 'Price ' + rs(s.sell_price) : 'No price'];
      if (stockText(s)) bits.unshift(stockText(s));
      if (s.avg_cost != null) bits.push('cost ' + rs(s.avg_cost));
      if (s.margin_pct != null) bits.push(Number(s.margin_pct) + '% margin');
      var row = h('button', { class: 'sup-row', type: 'button', 'data-name': i.name.toLowerCase(), onclick: function () { detail(i); } },
        h('span', { class: 'sup-main' }, h('b', {}, i.name), h('span', { class: 'muted' }, bits.join(' · '))),
        f ? h('span', { class: 'badge ' + f[1] }, f[0]) : null, icon('chevron'));
      return row;
    });
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      rows.forEach(function (row) { row.hidden = q !== '' && row.getAttribute('data-name').indexOf(q) < 0; });
    });

    var nName = h('input', { id: 'inew', placeholder: 'Item name', autocomplete: 'off' });
    var nPpp = h('input', { id: 'ippp', inputmode: 'numeric', value: '1' });
    var nPrice = h('input', { id: 'iprice', inputmode: 'decimal', placeholder: 'Selling price (optional)' });
    var nErr = h('div', { class: 'error', role: 'alert', hidden: true });
    function nSay(m) { nErr.textContent = m; nErr.removeAttribute('hidden'); }
    var addBox = canAdd ? h('div', { class: 'stack', hidden: true, style: 'margin-top:14px' },
      nName, h('label', { for: 'ippp' }, 'Pieces in one pack'), nPpp, nPrice, nErr,
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
        nErr.setAttribute('hidden', '');
        var ppp = parseInt(nPpp.value, 10), pr = nPrice.value.trim() === '' ? null : num(nPrice.value);
        if (!nName.value.trim()) return nSay('Enter the item name.');
        if (!isFinite(ppp) || ppp < 1) return nSay('Pieces in one pack must be 1 or more.');
        if (pr !== null && (!isFinite(pr) || pr < 0)) return nSay('Enter a valid selling price, or leave it empty.');
        var ins = await sb.from('items').insert({ name: nName.value.trim(), pieces_per_pack: ppp }).select('id').single();
        if (ins.error) return nSay(ins.error.code === '23505' ? 'An item with this name already exists.' : 'Could not save: ' + ins.error.message);
        if (pr !== null) {
          var pe = await sb.rpc('set_item_price', { p_item: ins.data.id, p_price: pr });
          if (pe.error) { C.toast('Item added, but the price was not saved: ' + pe.error.message); return reload(ins.data.id); }
        }
        C.toast('Item added.'); reload(ins.data.id);
      } }, 'Save item')) : null;

    show(h('div', {}, C.header('Items and prices', C.goHome),
      canAdd && !showHidden ? h('section', { class: 'sec' },
        h('button', { class: 'btn btn-block', type: 'button', onclick: function () { addBox.removeAttribute('hidden'); nName.focus(); } }, icon('plus'), 'Add item'), addBox) : null,
      h('section', { class: 'sec' }, h('h2', {}, showHidden ? 'Hidden items' : 'All items'), search,
        h('div', { style: 'margin-top:8px' }, rows.length ? rows : h('p', { class: 'muted' }, showHidden ? 'No hidden items.' : 'No items yet. They appear when you enter a purchase, or add one above.'))),
      hiddenCount || showHidden ? h('section', { class: 'sec' },
        h('button', { class: 'btn btn-block', type: 'button', onclick: function () { reload(null, !showHidden); } },
          showHidden ? 'Back to active items' : 'Show hidden items (' + hiddenCount + ')')) : null));

    // ------------------------------------------------------------ detail
    async function detail(i) {
      show(h('div', {}, C.header(i.name, function () { reload(); }), h('p', { class: 'muted' }, 'Loading…')));
      var hist = await sb.from('item_price_history').select('sell_price,starts_on,ends_on').eq('item_id', i.id).order('starts_on', { ascending: false }).limit(12);
      var s = status[i.id] || {}, f = FLAG[s.margin_flag];
      var name = h('input', { id: 'dname', value: i.name, autocomplete: 'off', disabled: !canEdit });
      var ppp = h('input', { id: 'dppp', inputmode: 'numeric', value: String(i.pieces_per_pack), disabled: !canEdit });
      var order = h('input', { id: 'dorder', inputmode: 'numeric', value: String(i.shelf_order), disabled: !canEdit });
      var every = h('input', { id: 'devery', inputmode: 'numeric', placeholder: 'Usual rhythm', value: i.count_every_days == null ? '' : String(i.count_every_days), disabled: !canEdit });
      var active = h('input', { type: 'checkbox', class: 'chk', checked: i.is_active, disabled: !canEdit });
      var err = h('div', { class: 'error', role: 'alert', hidden: true });
      function say(m) { err.textContent = m; err.removeAttribute('hidden'); }
      var save = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: !canEdit, onclick: async function () {
        err.setAttribute('hidden', '');
        var p = parseInt(ppp.value, 10), o = parseInt(order.value, 10), e = every.value.trim() === '' ? null : parseInt(every.value, 10);
        if (!name.value.trim()) return say('Enter the item name.');
        if (!isFinite(p) || p < 1) return say('Pieces in one pack must be 1 or more.');
        if (!isFinite(o)) return say('Shelf position must be a number.');
        if (e !== null && (!isFinite(e) || e < 1)) return say('Count rhythm must be 1 or more days, or empty.');
        var res = await sb.from('items').update({ name: name.value.trim(), pieces_per_pack: p, shelf_order: o, count_every_days: e, is_active: active.checked }).eq('id', i.id);
        if (res.error) return say(res.error.code === '23505' ? 'An item with this name already exists.' : 'Could not save: ' + res.error.message);
        C.toast('Saved.'); reload();
      } }, 'Save changes');

      var price = h('input', { id: 'dprice', inputmode: 'decimal', placeholder: s.sell_price != null ? String(Number(s.sell_price)) : '0', disabled: !canEdit });
      var perr = h('div', { class: 'error', role: 'alert', hidden: true });
      var pbtn = h('button', { class: 'btn btn-block', type: 'button', disabled: !canEdit, onclick: async function () {
        perr.setAttribute('hidden', '');
        var v = num(price.value);
        if (!isFinite(v) || v < 0) { perr.textContent = 'Enter the new selling price.'; perr.removeAttribute('hidden'); return; }
        var res = await sb.rpc('set_item_price', { p_item: i.id, p_price: v });
        if (res.error) { perr.textContent = 'Could not change the price: ' + res.error.message; perr.removeAttribute('hidden'); return; }
        C.toast('Price changed from today.'); reload(i.id);
      } }, 'Change price from today');

      var facts = [];
      if (s.avg_cost != null) facts.push(['Average cost', rs(s.avg_cost)]);
      if (s.last_cost != null) facts.push(['Last cost', rs(s.last_cost)]);
      if (s.margin_pct != null) facts.push(['Margin', Number(s.margin_pct) + '%']);
      if (stockText(s)) facts.unshift(['Stock now', stockText(s).replace(' in stock', ' pieces')]);
      facts.push(['Last counted', s.last_counted_on ? niceDate(s.last_counted_on) : 'Never']);

      show(h('div', {}, C.header(i.name, function () { reload(); }),
        h('div', { class: 'dash' },
          h('div', { class: 'stat hero' }, h('span', { class: 'stat-ic' }, icon('tag')), h('span', { class: 'stat-body' },
            h('span', { class: 'stat-label' }, 'Selling price'), h('span', { class: 'stat-num' }, s.sell_price != null ? rs(s.sell_price) : 'Not set'),
            f ? h('span', { class: 'stat-sub' }, f[0]) : null))),
        h('section', { class: 'sec' }, facts.map(function (x) { return h('div', { class: 'r-line' }, h('span', {}, x[0]), h('b', { class: 'num' }, x[1])); })),
        canEdit ? h('section', { class: 'sec' }, h('h2', {}, 'Change selling price'),
          h('p', { class: 'hint' }, 'Count your stock first, then change the price. Old sales keep the old price.'),
          price, perr, h('div', { class: 'actions', style: 'margin-top:12px' }, pbtn)) : null,
        h('section', { class: 'sec' }, h('h2', {}, 'Details'),
          h('label', { for: 'dname' }, 'Name'), name,
          h('label', { for: 'dppp', style: 'margin-top:14px' }, 'Pieces in one pack'), ppp,
          h('label', { for: 'dorder', style: 'margin-top:14px' }, 'Shelf position (the count screen goes in this order)'), order,
          h('label', { for: 'devery', style: 'margin-top:14px' }, 'Count every (days)'), every,
          h('label', { class: 'chk-row', style: 'margin-top:10px' }, active, h('span', {}, 'Active (untick to hide this item)')), err,
          h('div', { class: 'actions', style: 'margin-top:18px' }, save)),
        h('section', { class: 'sec' }, h('h2', {}, 'Price history'),
          hist.data && hist.data.length ? hist.data.map(function (x) {
            return h('div', { class: 'r-line' }, h('span', {}, niceDate(x.starts_on) + ' to ' + (x.ends_on ? niceDate(x.ends_on) : 'now')), h('b', { class: 'num' }, rs(x.sell_price)));
          }) : h('p', { class: 'muted' }, 'No price set yet.'))));
    }
  };
})();
