// Purchase entry: build one bill (supplier + date + item lines), review it, submit it in one go.
// Submit calls the database function create_purchase_bill, which saves the whole bill or nothing.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb;

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }
  function money(n) {
    return (isFinite(n) ? n : 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function trim4(n) { return isFinite(n) ? String(Math.round(n * 10000) / 10000) : ''; }
  function key(s) { return s.trim().toLowerCase(); }

  C.screens.purchases = async function (me, perms) {
    var perm = perms.filter(function (p) { return p.feature === 'purchases'; })[0];
    if (!perm || !perm.can_add) { C.toast('Your role cannot add purchases.'); return; }

    C.show(h('div', { class: 'card' }, 'Loading…'));
    var r = await Promise.all([
      sb.from('items').select('id,name,pieces_per_pack,last_supplier_id').eq('is_active', true).order('name'),
      sb.from('v_item_status').select('item_id,sell_price,last_cost'),
      sb.from('suppliers').select('id,name').eq('is_active', true).order('name')
    ]);
    var failed = r.filter(function (x) { return x.error; })[0];
    if (failed) { fail('Could not load data: ' + failed.error.message); return; }

    var items = r[0].data || [], suppliers = r[2].data || [];
    var status = {};
    (r[1].data || []).forEach(function (s) { status[s.item_id] = s; });
    var byName = {};
    items.forEach(function (i) { byName[key(i.name)] = i; });

    var st = { supplierId: '', date: today(), lines: [] };
    var basisCache = {};

    function fail(msg) {
      C.show(h('div', { class: 'card stack' }, h('div', { class: 'error', role: 'alert' }, msg),
        h('button', { type: 'button', onclick: C.goHome }, 'Back')));
    }

    // Stock and average cost as the database last computed them (for the review preview).
    async function basis(itemId) {
      if (!itemId) return { qty: 0, avg: 0 };
      if (basisCache[itemId]) return basisCache[itemId];
      var res = await sb.from('item_cost_history').select('qty_after,avg_cost_after')
        .eq('item_id', itemId).order('event_date', { ascending: false }).order('id', { ascending: false }).limit(1);
      var row = res.data && res.data[0];
      basisCache[itemId] = row ? { qty: Number(row.qty_after), avg: Number(row.avg_cost_after) } : { qty: 0, avg: 0 };
      return basisCache[itemId];
    }

    // ---------------------------------------------------------------- entry screen
    function renderEntry(message) {
      var supplierSel = h('select', { id: 'sup' }, h('option', { value: '' }, 'Choose supplier…'),
        suppliers.map(function (s) { return h('option', { value: s.id }, s.name); }),
        h('option', { value: '__new' }, '+ Add new supplier'));
      supplierSel.value = st.supplierId;
      var newBox = h('div', { class: 'stack', hidden: '' });
      var date = h('input', { id: 'date', type: 'date', value: st.date });

      supplierSel.addEventListener('change', function () {
        if (supplierSel.value === '__new') { newBox.removeAttribute('hidden'); st.supplierId = ''; }
        else { newBox.setAttribute('hidden', ''); st.supplierId = supplierSel.value; }
      });
      date.addEventListener('change', function () { st.date = date.value; });

      var nName = h('input', { placeholder: 'Supplier name', autocomplete: 'off' });
      var nPhone = h('input', { placeholder: 'Phone (optional)', inputmode: 'tel' });
      var nErr = h('div', { class: 'error', hidden: '' });
      newBox.append(nName, nPhone, nErr, h('button', { type: 'button', onclick: async function () {
        nErr.setAttribute('hidden', '');
        if (!nName.value.trim()) { nErr.textContent = 'Enter the supplier name.'; nErr.removeAttribute('hidden'); return; }
        var res = await sb.from('suppliers').insert({ name: nName.value.trim(), phone: nPhone.value.trim() || null })
          .select('id,name').single();
        if (res.error) { nErr.textContent = 'Could not add supplier: ' + res.error.message; nErr.removeAttribute('hidden'); return; }
        suppliers.push(res.data);
        st.supplierId = res.data.id;
        renderEntry();
      } }, 'Save supplier'));

      // ----- item line form
      var itemIn = h('input', { id: 'item', list: 'itemlist', autocomplete: 'off', placeholder: 'Type to search…' });
      var dl = h('datalist', { id: 'itemlist' }, items.map(function (i) { return h('option', { value: i.name }); }));
      var badge = h('span', { class: 'badge' }, '');
      var packs = h('input', { id: 'packs', inputmode: 'decimal', placeholder: '0' });
      var ppp = h('input', { id: 'ppp', inputmode: 'numeric', value: '1' });
      var packCost = h('input', { id: 'pc', inputmode: 'decimal', placeholder: '0' });
      var pieceCost = h('input', { id: 'pcs', inputmode: 'decimal', placeholder: '0' });
      var sell = h('input', { id: 'sell', inputmode: 'decimal', placeholder: 'Keep current' });
      var live = h('div', { class: 'live' });
      var err = h('div', { class: 'error', role: 'alert', hidden: '' });
      var mode = 'pack';   // which cost the user typed; the other one is calculated

      if (message) { err.textContent = message; err.removeAttribute('hidden'); }

      function recalcCosts() {
        var n = num(ppp.value) || 1;
        if (mode === 'pack') pieceCost.value = packCost.value === '' ? '' : trim4(num(packCost.value) / n);
        else packCost.value = pieceCost.value === '' ? '' : trim4(num(pieceCost.value) * n);
      }
      function updateLive() {
        var n = num(ppp.value) || 1, pk = num(packs.value), pcost = num(packCost.value), piece = num(pieceCost.value);
        var s = num(sell.value);
        var matched = byName[key(itemIn.value)];
        if (!matched && sell.value === '') { /* new item: price is needed */ }
        var cur = matched && status[matched.id] ? Number(status[matched.id].sell_price) : NaN;
        var price = isFinite(s) ? s : cur;
        var parts = [];
        parts.push(h('div', {}, 'Total pieces: ', h('b', {}, isFinite(pk) ? String(Math.round(pk * n * 100) / 100) : '–'),
          '   Line total: ', h('b', {}, 'Rs ' + money(pk * pcost))));
        if (isFinite(price) && price > 0 && isFinite(piece)) {
          var m = (price - piece) / price * 100;
          parts.push(h('div', { class: m < 0 ? 'bad' : 'good' }, 'Margin on this cost: ', h('b', {}, m.toFixed(1) + '%'),
            '  (profit Rs ' + money(price - piece) + ' per piece)'));
        }
        live.replaceChildren.apply(live, parts);
      }
      function onItem() {
        var m = byName[key(itemIn.value)];
        if (itemIn.value.trim() === '') { badge.textContent = ''; }
        else if (m) {
          badge.textContent = 'Existing item'; badge.className = 'badge';
          ppp.value = String(m.pieces_per_pack);
          var s = status[m.id];
          if (s && s.sell_price != null) sell.placeholder = 'Current: ' + s.sell_price;
          if (s && s.last_cost != null && packCost.value === '' && pieceCost.value === '') {
            mode = 'piece'; pieceCost.value = trim4(Number(s.last_cost)); recalcCosts();
          }
          if (!st.supplierId && m.last_supplier_id) { st.supplierId = m.last_supplier_id; supplierSel.value = st.supplierId; }
        } else { badge.textContent = 'New item will be created'; badge.className = 'badge new'; sell.placeholder = 'Sell price'; }
        updateLive();
      }
      itemIn.addEventListener('input', onItem);
      itemIn.addEventListener('change', onItem);
      packs.addEventListener('input', updateLive);
      ppp.addEventListener('input', function () { recalcCosts(); updateLive(); });
      packCost.addEventListener('input', function () { mode = 'pack'; recalcCosts(); updateLive(); });
      pieceCost.addEventListener('input', function () { mode = 'piece'; recalcCosts(); updateLive(); });
      sell.addEventListener('input', updateLive);

      function formEmpty() { return itemIn.value.trim() === '' && packs.value === '' && packCost.value === '' && pieceCost.value === ''; }
      function readLine() {
        var name = itemIn.value.trim();
        if (!st.supplierId) return { error: 'Choose a supplier first.' };
        if (!name) return { error: 'Enter the item name.' };
        var pk = num(packs.value), n = num(ppp.value), typed = num(mode === 'pack' ? packCost.value : pieceCost.value);
        if (!(pk > 0)) return { error: 'Enter the number of packs.' };
        if (!(n >= 1) || Math.floor(n) !== n) return { error: 'Pieces per pack must be a whole number (1 for loose items).' };
        if (!(typed >= 0)) return { error: 'Enter the cost price.' };
        var s = sell.value === '' ? null : num(sell.value);
        if (s !== null && !(s >= 0)) return { error: 'Sell price is not a number.' };
        var m = byName[key(name)];
        if (!m && s === null) return { error: 'This is a new item: enter its sell price.' };
        var packC = mode === 'pack' ? typed : typed * n;
        return { line: { item_id: m ? m.id : null, item_name: m ? m.name : name, packs: pk, ppp: n, mode: mode, cost: typed,
          packCost: packC, pieceCost: packC / n, sell: s } };
      }
      function addCurrent() {
        var res = readLine();
        if (res.error) { err.textContent = res.error; err.removeAttribute('hidden'); return false; }
        st.lines.push(res.line);
        return true;
      }

      var list = h('div', {}, st.lines.map(function (l, idx) {
        return h('div', { class: 'line' },
          h('div', { class: 'top' }, h('span', {}, l.item_name), h('span', {}, 'Rs ' + money(l.packs * l.packCost))),
          h('div', { class: 'kv' }, h('span', {}, 'Packs × pieces'), h('span', {}, l.packs + ' × ' + l.ppp),
            h('span', {}, 'Cost per piece'), h('span', {}, 'Rs ' + money(l.pieceCost))),
          h('div', { class: 'actions' }, h('button', { type: 'button', onclick: function () { st.lines.splice(idx, 1); renderEntry(); } }, 'Remove')));
      }));

      C.show(h('div', { class: 'stack' },
        h('div', { class: 'bar' }, h('h1', {}, 'New purchase'), h('button', { type: 'button', onclick: C.goHome }, 'Home')),
        h('div', { class: 'card' },
          h('label', { for: 'sup' }, 'Supplier'), supplierSel, newBox,
          h('label', { for: 'date' }, 'Bill date'), date),
        st.lines.length ? h('div', {}, h('p', { class: 'sub' }, st.lines.length + ' item(s) on this bill'), list) : null,
        h('div', { class: 'card' },
          h('label', { for: 'item' }, 'Item'), itemIn, dl, h('div', {}, badge),
          h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'packs' }, 'Packs'), packs),
            h('div', {}, h('label', { for: 'ppp' }, 'Pieces per pack'), ppp)),
          h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'pc' }, 'Pack cost (Rs)'), packCost),
            h('div', {}, h('label', { for: 'pcs' }, 'Piece cost (Rs)'), pieceCost)),
          h('p', { class: 'sub' }, 'Type either cost; the other is calculated.'),
          h('label', { for: 'sell' }, 'Sell price per piece (Rs)'), sell,
          live, err,
          h('div', { class: 'actions' },
            h('button', { type: 'button', onclick: function () { if (addCurrent()) renderEntry(); } }, 'Save and add next item'),
            h('button', { class: 'primary', type: 'button', style: 'margin-top:0', onclick: function () {
              if (!formEmpty() && !addCurrent()) return;
              if (!st.lines.length) { err.textContent = 'Add at least one item.'; err.removeAttribute('hidden'); return; }
              if (!st.supplierId) { err.textContent = 'Choose a supplier first.'; err.removeAttribute('hidden'); return; }
              renderReview();
            } }, 'Review bill')))));
      updateLive();
    }

    // ---------------------------------------------------------------- review screen
    async function renderReview(message) {
      C.show(h('div', { class: 'card' }, 'Preparing review…'));
      var previews = await Promise.all(st.lines.map(async function (l) {
        var b = await basis(l.item_id);
        var pieces = l.packs * l.ppp, value = l.packs * l.packCost, newQty = b.qty + pieces;
        var newAvg = newQty > 0 ? (b.qty * b.avg + value) / newQty : l.pieceCost;
        var cur = l.item_id && status[l.item_id] ? Number(status[l.item_id].sell_price) : NaN;
        var price = l.sell != null ? l.sell : cur;
        return { l: l, pieces: pieces, value: value, newQty: newQty, newAvg: newAvg,
          margin: isFinite(price) && price > 0 ? (price - newAvg) / price * 100 : NaN, price: price };
      }));
      var total = previews.reduce(function (a, p) { return a + p.value; }, 0);
      total = Math.round(total * 100) / 100;

      var paid = h('input', { id: 'paid', inputmode: 'decimal', value: '0' });
      var pending = h('b', {}, 'Rs ' + money(total));
      var err = h('div', { class: 'error', role: 'alert', hidden: '' });
      if (message) { err.textContent = message; err.removeAttribute('hidden'); }
      paid.addEventListener('input', function () { pending.textContent = 'Rs ' + money(total - (num(paid.value) || 0)); });
      var submit = h('button', { class: 'primary', type: 'button' }, 'Submit bill');

      submit.addEventListener('click', async function () {
        err.setAttribute('hidden', '');
        var p = num(paid.value);
        if (!(p >= 0)) { err.textContent = 'Enter the amount paid (0 if nothing paid).'; err.removeAttribute('hidden'); return; }
        if (p > total) { err.textContent = 'Amount paid is more than the bill total.'; err.removeAttribute('hidden'); return; }
        submit.disabled = true; submit.textContent = 'Saving…';
        var res = await sb.rpc('create_purchase_bill', {
          p_supplier_id: st.supplierId, p_bill_date: st.date, p_amount_paid: p,
          p_lines: st.lines.map(function (l) {
            var o = { packs: l.packs, pieces_per_pack: l.ppp, cost_mode: l.mode, cost: l.cost };
            if (l.item_id) o.item_id = l.item_id; else o.item_name = l.item_name;
            if (l.sell != null) o.sell_price = l.sell;
            return o;
          })
        });
        if (res.error) {
          submit.disabled = false; submit.textContent = 'Submit bill';
          err.textContent = 'Could not save: ' + res.error.message; err.removeAttribute('hidden'); return;
        }
        C.show(h('div', { class: 'card stack' },
          h('h1', {}, 'Bill saved'),
          h('p', {}, 'Total Rs ' + money(total) + ', paid Rs ' + money(p) + ', pending Rs ' + money(total - p) + '.'),
          h('button', { class: 'primary', type: 'button', onclick: C.goHome }, 'Back to home'),
          h('button', { type: 'button', onclick: function () { st = { supplierId: '', date: today(), lines: [] }; basisCache = {}; renderEntry(); } }, 'Enter another bill')));
      });

      C.show(h('div', { class: 'stack' },
        h('div', { class: 'bar' }, h('h1', {}, 'Review bill'), h('button', { type: 'button', onclick: function () { renderEntry(); } }, 'Back')),
        h('p', { class: 'sub' }, 'Supplier: ' + (suppliers.filter(function (s) { return s.id === st.supplierId; })[0] || {}).name + ' · ' + st.date),
        h('div', {}, previews.map(function (p, idx) {
          return h('div', { class: 'line' },
            h('div', { class: 'top' }, h('span', {}, p.l.item_name + (p.l.item_id ? '' : ' (new)')), h('span', {}, 'Rs ' + money(p.value))),
            h('div', { class: 'kv' },
              h('span', {}, 'Pieces added'), h('span', {}, String(Math.round(p.pieces * 100) / 100)),
              h('span', {}, 'New total stock (estimate)'), h('span', {}, String(Math.round(p.newQty * 100) / 100)),
              h('span', {}, 'New average cost'), h('span', {}, 'Rs ' + money(p.newAvg)),
              h('span', {}, 'Sell price'), h('span', {}, isFinite(p.price) ? 'Rs ' + money(p.price) : '–'),
              h('span', {}, 'New margin'), h('span', { class: p.margin < 0 ? 'bad' : '' }, isFinite(p.margin) ? p.margin.toFixed(1) + '%' : '–')),
            h('div', { class: 'actions' }, h('button', { type: 'button', onclick: function () { st.lines.splice(idx, 1); st.lines.length ? renderReview() : renderEntry(); } }, 'Remove')));
        })),
        h('div', { class: 'card' },
          h('div', { class: 'total' }, h('span', {}, 'Bill total'), h('span', {}, 'Rs ' + money(total))),
          h('label', { for: 'paid' }, 'Amount paid now (Rs)'), paid,
          h('div', { class: 'total' }, h('span', {}, 'Pending'), pending),
          err, submit)));
    }

    renderEntry();
  };
})();
