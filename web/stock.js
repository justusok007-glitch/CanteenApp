// Stock count: list every active item in shelf order, type what is on the shelf, save one count for today.
// Sales are never typed in; the database works them out from consecutive counts.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb;
  var DRAFT = 'canteen.stockdraft';

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; }
  function fmt(n) { return String(Math.round(n * 100) / 100); }
  function show(node) { C.show(node, 'stock_counts'); }
  function ago(days) {
    if (days == null) return 'never counted';
    if (days <= 0) return 'today';
    return days === 1 ? 'yesterday' : days + ' days ago';
  }
  function readDraft(date) {
    try { var d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); return d && d.date === date ? d.vals : {}; } catch (e) { return {}; }
  }
  function writeDraft(date, vals) { try { localStorage.setItem(DRAFT, JSON.stringify({ date: date, vals: vals })); } catch (e) { /* optional */ } }
  function clearDraft() { try { localStorage.removeItem(DRAFT); } catch (e) { /* optional */ } }

  C.screens.stock_counts = async function (me, perms) {
    var perm = perms.filter(function (p) { return p.feature === 'stock_counts'; })[0];
    if (!perm || !perm.can_add) { C.toast('Your role cannot add stock counts.'); return; }

    function fail(msg) {
      show(h('div', {}, C.header('Stock count', C.goHome), h('div', { class: 'error', role: 'alert' }, msg),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: C.goHome }, 'Back to home'))));
    }
    show(h('div', {}, C.header('Stock count', C.goHome), h('p', { class: 'muted' }, 'Loading items…')));

    var date = today();
    // One request gives every item with its stock now (worked out by the database:
    // last count + purchases since - wastage since; an item never counted starts from 0).
    var BASE = 'item_id,name,shelf_order,last_counted_on,days_since_count,count_overdue';
    var r = await sb.from('v_item_status').select(BASE + ',last_count_qty,purchased_since,wasted_since,stock_qty');
    if (r.error && /column/i.test(r.error.message || '')) r = await sb.from('v_item_status').select(BASE);   // database update 006 not run yet
    if (r.error) { fail('Could not load items: ' + r.error.message); return; }

    var items = (r.data || []).slice().sort(function (a, b) {
      var sa = a.shelf_order == null ? 1e9 : a.shelf_order, sbb = b.shelf_order == null ? 1e9 : b.shelf_order;
      return sa - sbb || a.name.localeCompare(b.name);
    });
    if (!items.length) { fail('No items yet. Add a purchase first so items exist to count.'); return; }

    var lastQty = {}, added = {}, lost = {}, expected = {};
    items.forEach(function (it) {
      var id = it.item_id;
      if (it.last_count_qty != null) lastQty[id] = Number(it.last_count_qty);
      if (Number(it.purchased_since)) added[id] = Number(it.purchased_since);
      if (Number(it.wasted_since)) lost[id] = Number(it.wasted_since);
      if (it.stock_qty != null && (it.last_count_qty != null || added[id])) expected[id] = Math.max(0, Number(it.stock_qty));
    });
    var vals = readDraft(date);
    var full = true;
    var inputs = {};

    function counted() { return items.filter(function (i) { return vals[i.item_id] !== undefined && vals[i.item_id] !== '' && isFinite(num(vals[i.item_id])); }).length; }

    var progress = h('div', { class: 'stk-progress', role: 'status', 'aria-live': 'polite' });
    var bar = h('div', { class: 'stk-bar' }, h('i', {}));
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    function refresh() {
      err.setAttribute('hidden', '');
      var n = counted();
      progress.textContent = n + ' of ' + items.length + ' counted';
      bar.firstChild.style.width = (n / items.length * 100) + '%';
      saveBtn.disabled = false;
    }
    function setVal(id, v) {
      vals[id] = v;
      inputs[id].value = v;
      inputs[id].closest('.stk-row').classList.toggle('done', v !== '' && isFinite(num(v)));
      writeDraft(date, vals); refresh();
    }

    var rows = items.map(function (it) {
      var id = it.item_id, lq = expected[id] != null ? expected[id] : lastQty[id];
      var inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '–',
        'aria-label': 'Count for ' + it.name, value: vals[id] === undefined ? '' : vals[id] });
      inputs[id] = inp;
      inp.addEventListener('input', function () {
        vals[id] = inp.value; inp.closest('.stk-row').classList.toggle('done', isFinite(num(inp.value)));
        writeDraft(date, vals); refresh();
      });
      inp.addEventListener('focus', function () { inp.select(); });
      var dec = h('button', { class: 'stk-step', type: 'button', 'aria-label': 'One less ' + it.name,
        onclick: function () { var v = isFinite(num(inp.value)) ? num(inp.value) : (lq != null ? lq : 0); setVal(id, fmt(Math.max(0, v - 1))); } }, '−');
      var inc = h('button', { class: 'stk-step', type: 'button', 'aria-label': 'One more ' + it.name,
        onclick: function () { var v = isFinite(num(inp.value)) ? num(inp.value) : (lq != null ? lq : 0); setVal(id, fmt(v + 1)); } }, '+');
      var row = h('div', { class: 'stk-row' + (isFinite(num(inp.value)) ? ' done' : ''), 'data-name': it.name.toLowerCase() },
        h('div', { class: 'stk-info' },
          h('div', { class: 'stk-name' }, it.name),
          h('div', { class: 'stk-meta' }, lastQty[id] != null ? 'Last: ' + fmt(lastQty[id]) + ' \u00b7 ' + ago(it.days_since_count) : (added[id] ? 'New item' : 'Not counted before'),
            added[id] ? h('span', { class: 'stk-add' }, '+' + fmt(added[id]) + ' bought') : null,
            lost[id] ? h('span', { class: 'stk-add lost' }, '\u2212' + fmt(lost[id]) + ' wasted') : null,
            expected[id] != null && (added[id] || lost[id] || lastQty[id] == null) ? h('strong', { class: 'stk-exp' }, 'Should be ' + fmt(expected[id])) : null,
            it.count_overdue ? h('span', { class: 'badge' }, 'Due') : null)),
        h('div', { class: 'stk-ctl' }, dec, inp, inc));
      return row;
    });

    var search = h('input', { type: 'search', placeholder: 'Search items', 'aria-label': 'Search items', autocomplete: 'off' });
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      rows.forEach(function (row) { row.hidden = q !== '' && row.getAttribute('data-name').indexOf(q) < 0; });
    });

    var fullBtn = h('button', { type: 'button', class: 'seg', onclick: function () { setMode(true); } }, 'Full count');
    var partBtn = h('button', { type: 'button', class: 'seg', onclick: function () { setMode(false); } }, 'Partial count');
    var modeNote = h('p', { class: 'muted stk-note' });
    function setMode(f) {
      full = f;
      fullBtn.setAttribute('aria-pressed', String(f)); partBtn.setAttribute('aria-pressed', String(!f));
      modeNote.textContent = f ? 'Every item must be counted. Needed for the cash check.'
        : 'Count only some items. Cash cannot be checked from a partial count.';
    }

    var saveBtn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: save }, 'Save count');

    async function save() {
      err.setAttribute('hidden', '');
      var entries = items.filter(function (i) { return isFinite(num(vals[i.item_id] === undefined ? '' : vals[i.item_id])); });
      var bad = items.filter(function (i) { var v = vals[i.item_id]; return v !== undefined && v !== '' && (!isFinite(num(v)) || num(v) < 0); });
      var msg = '';
      if (bad.length) msg = 'Check the number for ' + bad[0].name + '.';
      else if (!entries.length) msg = 'Enter at least one count.';
      else if (full && entries.length < items.length) {
        var first = items.filter(function (i) { return entries.indexOf(i) < 0; })[0];
        msg = (items.length - entries.length) + ' items still to count, starting with ' + first.name + '. Count them, or switch to Partial count.';
      }
      if (msg) { err.textContent = msg; err.removeAttribute('hidden'); err.scrollIntoView({ block: 'center' }); return; }

      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      // every save is a new count, so sales appear for each one (even a second count on the same day)
      var ins = await sb.from('stock_counts').insert({ is_full: full }).select('id').single();
      if (ins.error) return saveFail(ins.error);
      var id = ins.data.id;
      var up = await sb.from('stock_count_lines').insert(
        entries.map(function (i) { return { count_id: id, item_id: i.item_id, qty: num(vals[i.item_id]) }; }));
      if (up.error) {
        await sb.from('stock_counts').delete().eq('id', id);   // never leave an empty count behind
        return saveFail(up.error);
      }
      clearDraft();
      var canSee = perms.some(function (p) { return p.feature === 'reports' && p.can_view; });
      var sales = null;
      if (canSee) {
        var pr = await sb.from('v_item_periods').select('sales_value,gross_profit').eq('count_id', id);
        if (!pr.error && pr.data && pr.data.length) {
          sales = { total: 0, gross: null };
          pr.data.forEach(function (x) {
            sales.total += Number(x.sales_value || 0);
            if (x.gross_profit != null) sales.gross = (sales.gross || 0) + Number(x.gross_profit);
          });
        }
      }
      function rs(n) { return 'Rs ' + Math.round(n).toLocaleString('en-PK'); }
      show(h('div', {}, C.header('Stock count', C.goHome),
        h('section', { class: 'sec done-box' },
          h('h2', {}, 'Count saved'),
          h('p', {}, entries.length + ' of ' + items.length + ' items counted' + (full ? ' (full count).' : ' (partial count).')),
          sales ? h('div', { class: 'verdict good', role: 'status' },
            h('span', { class: 'verdict-sub' }, 'Sales since the last count' + (full ? '' : ' (items counted)')),
            h('span', { class: 'verdict-big' }, rs(sales.total)),
            sales.gross != null ? h('span', { class: 'verdict-sub' }, 'Gross profit ' + rs(sales.gross)) : null)
          : h('p', { class: 'muted' }, canSee ? 'First count saved. Sales show from your next count.' : 'Count saved.')),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: C.goHome }, 'Back to home'))));
    }
    function saveFail(e) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save count';
      err.textContent = 'Could not save: ' + e.message + ' Your numbers are kept on this phone; try again.';
      err.removeAttribute('hidden'); err.scrollIntoView({ block: 'center' });
    }

    setMode(full); refresh();
    show(h('div', { class: 'stk' },
      C.header('Stock count', C.goHome),
      h('p', { class: 'muted' }, 'Counting for ' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) + '. Type what is on the shelf now.'),
      h('div', { class: 'segs', role: 'group', 'aria-label': 'Count type' }, fullBtn, partBtn), modeNote,
      h('div', { class: 'stk-sticky' }, search, progress, bar),
      h('div', { class: 'stk-list' }, rows),
      err, saveBtn));
  };
})();
