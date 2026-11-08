// Expenses and wastage: two simple logs under one screen.
// Expenses reduce monthly profit. Wasted pieces (damage, expiry) are taken off before sales are worked out,
// so they never show up as a cash shortage; they are valued at cost in profit.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;

  var CATS = ['Electricity', 'Rent', 'Gas', 'Packaging', 'Repairs', 'Transport', 'Cleaning', 'Other'];
  var REASONS = [['damage', 'Damaged'], ['expiry', 'Expired'], ['spoilage', 'Spoiled'], ['other', 'Other']];

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; }
  function rs(n) { return 'Rs ' + Math.round(Number(n)).toLocaleString('en-PK'); }
  function niceDate(iso) {
    var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function show(node) { C.show(node, 'expenses'); }

  C.screens.expenses = async function (me, perms, tab) {
    var perm = perms.filter(function (p) { return p.feature === 'expenses'; })[0];
    if (!perm || (!perm.can_view && !perm.can_add)) { C.toast('Your role cannot open expenses.'); return; }
    var canAdd = !!perm.can_add, canDelete = !!perm.can_delete;
    tab = tab === 'wastage' ? 'wastage' : 'expense';

    show(h('div', {}, C.header('Expenses and wastage', C.goHome), h('p', { class: 'muted' }, 'Loading…')));
    var monthStart = today().slice(0, 8) + '01';
    var r = await Promise.all([
      sb.from('expenses').select('id,spent_on,category,amount,description').order('spent_on', { ascending: false }).order('created_at', { ascending: false }).limit(15),
      sb.from('expenses').select('amount').gte('spent_on', monthStart),
      sb.from('wastage').select('id,wasted_on,qty,reason,notes,item_id').order('wasted_on', { ascending: false }).order('created_at', { ascending: false }).limit(15),
      sb.from('items').select('id,name').eq('is_active', true).order('name')
    ]);
    var bad = r.filter(function (x) { return x.error; })[0];
    if (bad) {
      show(h('div', {}, C.header('Expenses and wastage', C.goHome), h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + bad.error.message)));
      return;
    }
    var expenses = r[0].data || [], monthTotal = (r[1].data || []).reduce(function (a, x) { return a + Number(x.amount); }, 0);
    var wastage = r[2].data || [], items = r[3].data || [];
    var itemName = {}; items.forEach(function (i) { itemName[i.id] = i.name; });
    function reload(t) { C.screens.expenses(me, perms, t); }

    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    function fail(msg) { err.textContent = msg; err.removeAttribute('hidden'); }
    async function remove(table, id) {
      if (!window.confirm('Delete this entry?')) return;
      var res = await sb.from(table).delete().eq('id', id);
      if (res.error) { C.toast('Could not delete: ' + res.error.message); return; }
      C.toast('Deleted.'); reload(tab);
    }
    function row(left, sub, right, table, id) {
      return h('div', { class: 'r-line' },
        h('span', {}, left, sub ? h('span', { class: 'muted' }, ' · ' + sub) : null),
        h('span', { class: 'row-end' }, h('b', { class: 'num' }, right),
          canDelete ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Delete entry', onclick: function () { remove(table, id); } }, icon('trash')) : null));
    }

    var toggle = h('div', { class: 'segs', role: 'group', 'aria-label': 'Choose log' },
      h('button', { type: 'button', class: 'seg', 'aria-pressed': String(tab === 'expense'), onclick: function () { reload('expense'); } }, 'Expenses'),
      h('button', { type: 'button', class: 'seg', 'aria-pressed': String(tab === 'wastage'), onclick: function () { reload('wastage'); } }, 'Wastage'));

    var body;
    if (tab === 'expense') {
      var date = h('input', { id: 'edate', type: 'date', value: today() });
      var cat = h('select', { id: 'ecat' }, CATS.map(function (c) { return h('option', { value: c.toLowerCase() }, c); }));
      var amt = h('input', { id: 'eamt', inputmode: 'decimal', placeholder: '0', autocomplete: 'off' });
      var desc = h('input', { id: 'edesc', placeholder: 'Optional', autocomplete: 'off' });
      var btn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
        err.setAttribute('hidden', '');
        var a = num(amt.value);
        if (!date.value) return fail('Choose the date.');
        if (!isFinite(a) || a <= 0) return fail('Enter the amount (more than 0).');
        btn.disabled = true; btn.textContent = 'Saving…';
        var res = await sb.from('expenses').insert({ spent_on: date.value, category: cat.value, amount: a, description: desc.value.trim() || null });
        if (res.error) { btn.disabled = false; btn.textContent = 'Save expense'; return fail('Could not save: ' + res.error.message); }
        C.toast('Expense saved.'); reload('expense');
      } }, 'Save expense');
      body = [
        h('div', { class: 'stat' }, h('span', { class: 'stat-body' },
          h('span', { class: 'stat-label' }, 'Expenses this month'), h('span', { class: 'stat-num' }, rs(monthTotal)))),
        canAdd ? h('section', { class: 'sec' }, h('h2', {}, 'Add expense'),
          h('label', { for: 'edate' }, 'Date'), date,
          h('label', { for: 'ecat', style: 'margin-top:14px' }, 'Type'), cat,
          h('label', { for: 'eamt', style: 'margin-top:14px' }, 'Amount (Rs)'), amt,
          h('label', { for: 'edesc', style: 'margin-top:14px' }, 'Note'), desc, err,
          h('div', { class: 'actions', style: 'margin-top:18px' }, btn)) : null,
        h('section', { class: 'sec' }, h('h2', {}, 'Recent expenses'),
          expenses.length ? expenses.map(function (x) {
            var c = x.category.charAt(0).toUpperCase() + x.category.slice(1);
            return row(niceDate(x.spent_on) + ' · ' + c, x.description, rs(x.amount), 'expenses', x.id);
          }) : h('p', { class: 'muted' }, 'No expenses yet.'))
      ];
    } else {
      var wdate = h('input', { id: 'wdate', type: 'date', value: today() });
      var wsel = h('select', { id: 'witem' }, h('option', { value: '' }, 'Choose item…'),
        items.map(function (i) { return h('option', { value: i.id }, i.name); }));
      var wq = h('input', { id: 'wqty', inputmode: 'decimal', placeholder: '0', autocomplete: 'off' });
      var wr = h('select', { id: 'wreason' }, REASONS.map(function (x) { return h('option', { value: x[0] }, x[1]); }));
      var wn = h('input', { id: 'wnote', placeholder: 'Optional', autocomplete: 'off' });
      var wbtn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
        err.setAttribute('hidden', '');
        var q = num(wq.value);
        if (!wsel.value) return fail('Choose the item.');
        if (!isFinite(q) || q <= 0) return fail('Enter how many pieces (more than 0).');
        if (!wdate.value) return fail('Choose the date.');
        wbtn.disabled = true; wbtn.textContent = 'Saving…';
        var res = await sb.from('wastage').insert({ item_id: wsel.value, qty: q, wasted_on: wdate.value, reason: wr.value, notes: wn.value.trim() || null });
        if (res.error) { wbtn.disabled = false; wbtn.textContent = 'Save wastage'; return fail('Could not save: ' + res.error.message); }
        C.toast('Wastage saved.'); reload('wastage');
      } }, 'Save wastage');
      var rl = {}; REASONS.forEach(function (x) { rl[x[0]] = x[1]; });
      body = [
        h('p', { class: 'muted' }, 'Record pieces thrown away or lost. They are taken off before sales are worked out, so they never show as missing cash.'),
        canAdd ? h('section', { class: 'sec' }, h('h2', {}, 'Add wastage'),
          h('label', { for: 'wdate' }, 'Date'), wdate,
          h('label', { for: 'witem', style: 'margin-top:14px' }, 'Item'), wsel,
          h('label', { for: 'wqty', style: 'margin-top:14px' }, 'Pieces'), wq,
          h('label', { for: 'wreason', style: 'margin-top:14px' }, 'Reason'), wr,
          h('label', { for: 'wnote', style: 'margin-top:14px' }, 'Note'), wn, err,
          h('div', { class: 'actions', style: 'margin-top:18px' }, wbtn)) : null,
        h('section', { class: 'sec' }, h('h2', {}, 'Recent wastage'),
          wastage.length ? wastage.map(function (x) {
            return row(niceDate(x.wasted_on) + ' · ' + (itemName[x.item_id] || 'Item'), rl[x.reason] + (x.notes ? ', ' + x.notes : ''),
              String(Number(x.qty)) + ' pcs', 'wastage', x.id);
          }) : h('p', { class: 'muted' }, 'No wastage yet.'))
      ];
    }
    show(h('div', {}, C.header('Expenses and wastage', C.goHome), toggle, body));
  };
})();
