// Purchase entry: build one bill (supplier + date + item lines), review it as a receipt, save it in one go.
// Saving calls the database function create_purchase_bill, which stores the whole bill or nothing.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }
  function money(n) {
    return (isFinite(n) ? n : 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function count(n) { return String(Math.round(n * 100) / 100); }
  function trim4(n) { return isFinite(n) ? String(Math.round(n * 10000) / 10000) : ''; }
  function key(s) { return s.trim().toLowerCase(); }
  function niceDate(iso) {
    var p = iso.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function show(node) { C.show(node, 'purchases'); }

  C.screens.purchases = async function (me, perms) {
    var perm = perms.filter(function (p) { return p.feature === 'purchases'; })[0];
    if (!perm || !perm.can_add) { C.toast('Your role cannot add purchases.'); return; }

    show(h('div', {}, C.header('New purchase', C.goHome), h('p', { class: 'muted' }, 'Loading items and suppliers…')));
    var r = await Promise.all([
      sb.from('items').select('id,name,pieces_per_pack,last_supplier_id').eq('is_active', true).order('name'),
      sb.from('v_item_status').select('item_id,sell_price,last_cost,avg_cost,stock_qty'),
      sb.from('suppliers').select('id,name').eq('is_active', true).order('name')
    ]);
    var failed = r.filter(function (x) { return x.error; })[0];
    if (failed) { fail('Could not load items and suppliers: ' + failed.error.message); return; }

    var items = r[0].data || [], suppliers = r[2].data || [];
    var status = {};
    (r[1].data || []).forEach(function (s) { status[s.item_id] = s; });
    var byName = {};
    items.forEach(function (i) { byName[key(i.name)] = i; });

    var st = { supplierId: '', date: today(), lines: [] };

    // Stock now and average cost, already loaded with the items (used for the review preview).
    function basis(itemId) {
      var x = itemId && status[itemId];
      if (!x) return { qty: 0, avg: 0 };
      var avg = x.avg_cost != null ? Number(x.avg_cost) : NaN;
      return { qty: Math.max(0, Number(x.stock_qty) || 0), avg: avg };
    }

    function fail(msg) {
      show(h('div', {}, C.header('New purchase', C.goHome), h('div', { class: 'error', role: 'alert' }, msg),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: C.goHome }, 'Back to home'))));
    }

    // ---------------------------------------------------------------- entry
    function renderEntry(message) {
      var supplierSel = h('select', { id: 'sup' }, h('option', { value: '' }, 'Choose supplier…'),
        suppliers.map(function (s) { return h('option', { value: s.id }, s.name); }),
        h('option', { value: '__new' }, '+ Add new supplier'));
      supplierSel.value = st.supplierId;
      var newBox = h('div', { class: 'stack', style: 'margin-top:12px', hidden: true });
      var date = h('input', { id: 'date', type: 'date', value: st.date });

      supplierSel.addEventListener('change', function () {
        if (supplierSel.value === '__new') { newBox.removeAttribute('hidden'); st.supplierId = ''; }
        else { newBox.setAttribute('hidden', ''); st.supplierId = supplierSel.value; }
      });
      date.addEventListener('change', function () { st.date = date.value; });

      var nName = h('input', { placeholder: 'Supplier name', autocomplete: 'off', 'aria-label': 'New supplier name' });
      var nPhone = h('input', { placeholder: 'Phone (optional)', inputmode: 'tel', 'aria-label': 'New supplier phone' });
      var nErr = h('div', { class: 'error', role: 'alert', hidden: true });
      newBox.append(nName, nPhone, nErr, h('button', { class: 'btn', type: 'button', onclick: async function () {
        nErr.setAttribute('hidden', '');
        if (!nName.value.trim()) { nErr.textContent = 'Enter the supplier name.'; nErr.removeAttribute('hidden'); return; }
        var res = await sb.from('suppliers').insert({ name: nName.value.trim(), phone: nPhone.value.trim() || null })
          .select('id,name').single();
        if (res.error) { nErr.textContent = 'Could not add the supplier: ' + res.error.message; nErr.removeAttribute('hidden'); return; }
        suppliers.push(res.data);
        st.supplierId = res.data.id;
        renderEntry();
      } }, 'Save supplier'));

      // ----- item form
      var itemIn = h('input', { id: 'item', list: 'itemlist', autocomplete: 'off', placeholder: 'Type to search or add a new item' });
      var dl = h('datalist', { id: 'itemlist' }, items.map(function (i) { return h('option', { value: i.name }); }));
      var badge = h('span', { class: 'badge', hidden: true }, '');
      var packs = h('input', { id: 'packs', inputmode: 'decimal', placeholder: '0' });
      var ppp = h('input', { id: 'ppp', inputmode: 'numeric', value: '1' });
      var packCost = h('input', { id: 'pc', inputmode: 'decimal', placeholder: '0.00' });
      var pieceCost = h('input', { id: 'pcs', inputmode: 'decimal', placeholder: '0.00' });
      var sell = h('input', { id: 'sell', inputmode: 'decimal', placeholder: 'Keep current price' });
      var live = h('div', { class: 'live num' });
      var err = h('div', { class: 'error', role: 'alert', hidden: true });
      var mode = 'pack';   // the cost the user typed; the other one is calculated

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
        var cur = matched && status[matched.id] ? Number(status[matched.id].sell_price) : NaN;
        var price = isFinite(s) ? s : cur;
        var parts = [
          h('div', {}, 'Pieces added: ', h('b', {}, isFinite(pk) ? count(pk * n) : '–'),
            ' · Line total: ', h('b', {}, 'Rs ' + money(pk * pcost)))
        ];
        if (isFinite(price) && price > 0 && isFinite(piece)) {
          var m = (price - piece) / price * 100;
          parts.push(h('div', { class: m < 0 ? 'bad' : 'good' }, 'Margin at this cost: ', h('b', {}, m.toFixed(1) + '%'),
            ' (Rs ' + money(price - piece) + ' per piece)'));
        }
        live.replaceChildren.apply(live, parts);
      }
      function onItem() {
        var m = byName[key(itemIn.value)];
        if (itemIn.value.trim() === '') { badge.setAttribute('hidden', ''); }
        else if (m) {
          badge.textContent = 'Existing item'; badge.className = 'badge'; badge.removeAttribute('hidden');
          ppp.value = String(m.pieces_per_pack);
          var s = status[m.id];
          sell.placeholder = s && s.sell_price != null ? 'Current price: ' + s.sell_price : 'Sell price';
          if (s && s.last_cost != null && packCost.value === '' && pieceCost.value === '') {
            mode = 'piece'; pieceCost.value = trim4(Number(s.last_cost)); recalcCosts();
          }
          if (!st.supplierId && m.last_supplier_id) { st.supplierId = m.last_supplier_id; supplierSel.value = st.supplierId; }
        } else {
          badge.textContent = 'New item. Enter its sell price.'; badge.className = 'badge new'; badge.removeAttribute('hidden');
          sell.placeholder = 'Sell price';
        }
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
        if (!(n >= 1) || Math.floor(n) !== n) return { error: 'Pieces per pack must be a whole number. Use 1 for loose items.' };
        if (!(typed >= 0)) return { error: 'Enter the cost price.' };
        var s = sell.value === '' ? null : num(sell.value);
        if (s !== null && !(s >= 0)) return { error: 'Sell price must be a number.' };
        var m = byName[key(name)];
        if (!m && s === null) return { error: 'This is a new item. Enter its sell price.' };
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

      var subtotal = st.lines.reduce(function (a, l) { return a + l.packs * l.packCost; }, 0);
      var billSec = st.lines.length ? h('section', { class: 'sec' },
        h('h2', {}, 'On this bill'),
        st.lines.map(function (l, idx) {
          return h('div', { class: 'bill-line' },
            h('div', { class: 'grow' }, h('div', { class: 'name' }, l.item_name),
              h('div', { class: 'muted num', style: 'font-size:.9rem' }, count(l.packs) + ' × ' + l.ppp + ' pcs · Rs ' + money(l.pieceCost) + ' each')),
            h('div', { class: 'amt num' }, 'Rs ' + money(l.packs * l.packCost)),
            h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Remove ' + l.item_name,
              onclick: function () { st.lines.splice(idx, 1); renderEntry(); } }, icon('trash')));
        }),
        h('div', { class: 'subtotal num' }, h('span', {}, 'Total so far'), h('span', {}, 'Rs ' + money(subtotal)))) : null;

      show(h('div', {},
        C.header('New purchase', C.goHome),
        h('section', { class: 'sec' },
          h('label', { for: 'sup' }, 'Supplier'), supplierSel, newBox,
          h('label', { for: 'date', style: 'margin-top:14px' }, 'Bill date'), date),
        billSec,
        h('section', { class: 'sec' },
          h('h2', {}, st.lines.length ? 'Add another item' : 'Add an item'),
          h('label', { for: 'item' }, 'Item'), itemIn, dl, badge,
          h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'packs' }, 'Packs'), packs),
            h('div', {}, h('label', { for: 'ppp' }, 'Pieces per pack'), ppp)),
          h('div', { class: 'row' },
            h('div', {}, h('label', { for: 'pc' }, 'Pack cost (Rs)'), packCost),
            h('div', {}, h('label', { for: 'pcs' }, 'Piece cost (Rs)'), pieceCost)),
          h('p', { class: 'hint' }, 'Type either cost. The other is worked out for you.'),
          h('label', { for: 'sell', style: 'margin-top:14px' }, 'Sell price per piece (Rs)'), sell,
          live, err,
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: function () { if (addCurrent()) renderEntry(); } }, 'Add item'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: function () {
              if (!formEmpty() && !addCurrent()) return;
              if (!st.lines.length) { err.textContent = 'Add at least one item.'; err.removeAttribute('hidden'); return; }
              if (!st.supplierId) { err.textContent = 'Choose a supplier first.'; err.removeAttribute('hidden'); return; }
              renderReview();
            } }, 'Review bill')))));
      updateLive();
    }

    // ---------------------------------------------------------------- review (receipt)
    function renderReview(message) {
      var previews = st.lines.map(function (l) {
        var b = basis(l.item_id);
        var pieces = l.packs * l.ppp, value = l.packs * l.packCost, newQty = b.qty + pieces;
        // stock with no known cost yet takes this purchase's price (same rule as the database)
        var newAvg = newQty > 0 && isFinite(b.avg) ? (b.qty * b.avg + value) / newQty : l.pieceCost;
        var cur = l.item_id && status[l.item_id] ? Number(status[l.item_id].sell_price) : NaN;
        var price = l.sell != null ? l.sell : cur;
        return { l: l, pieces: pieces, value: value, newQty: newQty, newAvg: newAvg,
          margin: isFinite(price) && price > 0 ? (price - newAvg) / price * 100 : NaN, price: price };
      });
      var total = Math.round(previews.reduce(function (a, p) { return a + p.value; }, 0) * 100) / 100;
      var supplierName = (suppliers.filter(function (s) { return s.id === st.supplierId; })[0] || {}).name || '';

      var paid = h('input', { id: 'paid', inputmode: 'decimal', value: '0' });
      var pendingBox = h('div', { class: 'r-pending' });
      var err = h('div', { class: 'error', role: 'alert', hidden: true });
      if (message) { err.textContent = message; err.removeAttribute('hidden'); }

      function drawPending() {
        var p = num(paid.value) || 0, left = Math.round((total - p) * 100) / 100;
        pendingBox.replaceChildren(
          h('span', { class: 'muted' }, 'Pending'),
          left === 0 ? h('span', { class: 'stamp ok' }, 'Paid in full')
                     : h('span', { class: 'stamp num' }, 'Rs ' + money(left)));
      }
      paid.addEventListener('input', drawPending);
      drawPending();
      var save = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save bill');

      save.addEventListener('click', async function () {
        err.setAttribute('hidden', '');
        var p = num(paid.value);
        if (!(p >= 0)) { err.textContent = 'Enter the amount paid now. Use 0 if nothing was paid.'; err.removeAttribute('hidden'); return; }
        if (p > total) { err.textContent = 'Amount paid is more than the bill total.'; err.removeAttribute('hidden'); return; }
        save.disabled = true; save.textContent = 'Saving…';
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
          save.disabled = false; save.textContent = 'Save bill';
          err.textContent = 'Could not save the bill: ' + res.error.message; err.removeAttribute('hidden'); return;
        }
        show(h('div', {},
          C.header('Bill saved'),
          h('div', { class: 'receipt' },
            h('div', { class: 'title' }, 'Rs ' + money(total)),
            h('p', { class: 'muted' }, supplierName + ' · ' + niceDate(st.date)),
            h('div', { class: 'r-total num', style: 'padding-top:14px' }, h('span', {}, 'Paid now'), h('b', {}, 'Rs ' + money(p))),
            h('div', { class: 'r-total num', style: 'padding-top:0' }, h('span', {}, 'Pending'), h('b', {}, 'Rs ' + money(total - p)))),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', type: 'button', onclick: C.goHome }, 'Back to home'),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { C.screens.purchases(me, perms); } }, 'New purchase'))));
      });

      show(h('div', {},
        C.header('Review bill', function () { renderEntry(); }),
        h('div', { class: 'receipt' },
          h('div', { class: 'title' }, 'Purchase bill'),
          h('div', { class: 'meta' }, h('span', {}, supplierName), h('span', {}, niceDate(st.date))),
          previews.map(function (p, idx) {
            return h('div', { class: 'r-line' },
              h('div', { class: 'r-top' },
                h('div', { class: 'grow' }, h('div', { class: 'name' }, p.l.item_name + (p.l.item_id ? '' : ' (new item)')),
                  h('div', { class: 'calc num' }, count(p.l.packs) + ' × ' + p.l.ppp + ' pcs @ Rs ' + money(p.l.pieceCost))),
                h('div', { class: 'amt num' }, 'Rs ' + money(p.value)),
                h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Remove ' + p.l.item_name,
                  onclick: function () { st.lines.splice(idx, 1); st.lines.length ? renderReview() : renderEntry(); } }, icon('trash'))),
              h('div', { class: 'r-stats num' },
                h('div', {}, h('span', { class: 'lbl' }, 'New stock'), h('span', { class: 'val' }, count(p.newQty) + ' pcs')),
                h('div', {}, h('span', { class: 'lbl' }, 'New avg cost'), h('span', { class: 'val' }, 'Rs ' + money(p.newAvg))),
                h('div', {}, h('span', { class: 'lbl' }, 'New margin'),
                  h('span', { class: 'val ' + (p.margin < 0 ? 'bad' : (isFinite(p.margin) ? 'good' : '')) }, isFinite(p.margin) ? p.margin.toFixed(1) + '%' : '–'))));
          }),
          h('div', { class: 'r-total num' }, h('span', {}, 'Bill total'), h('span', { class: 'big' }, 'Rs ' + money(total))),
          h('div', { class: 'r-paid' }, h('label', { for: 'paid' }, 'Amount paid now (Rs)'), paid),
          pendingBox),
        h('p', { class: 'hint', style: 'margin:0 0 4px' }, 'New stock is an estimate from the last count and purchases.'),
        err, save));
    }

    renderEntry();
  };
})();
