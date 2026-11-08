// Suppliers: what you owe each one, recording payments, and each supplier's history.
// Balance owed = total of purchase bills - paid at purchase time - later payments.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; }
  function rs(n) { return 'Rs ' + Math.round(Number(n)).toLocaleString('en-PK'); }
  function niceDate(iso) {
    var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function show(node) { C.show(node, 'suppliers'); }

  C.screens.suppliers = async function (me, perms, openId) {
    var perm = perms.filter(function (p) { return p.feature === 'suppliers'; })[0];
    if (!perm || (!perm.can_view && !perm.can_add)) { C.toast('Your role cannot open suppliers.'); return; }
    var canAdd = !!perm.can_add, canEdit = !!perm.can_edit, canDelete = !!perm.can_delete;

    show(h('div', {}, C.header('Suppliers', C.goHome), h('p', { class: 'muted' }, 'Loading…')));
    var r = await sb.from('v_supplier_balances').select('*').eq('is_active', true).order('balance_owed', { ascending: false });
    if (r.error) {
      show(h('div', {}, C.header('Suppliers', C.goHome), h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + r.error.message)));
      return;
    }
    var list = r.data || [];
    function reload(id) { C.screens.suppliers(me, perms, id); }
    if (openId) {
      var s = list.filter(function (x) { return x.supplier_id === openId; })[0];
      if (s) return detail(s);
    }

    // ------------------------------------------------------------ list
    var owed = list.reduce(function (a, x) { return a + Math.max(0, Number(x.balance_owed)); }, 0);
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    var nName = h('input', { id: 'sname', placeholder: 'Supplier name', autocomplete: 'off' });
    var nPhone = h('input', { id: 'sphone', placeholder: 'Phone (optional)', inputmode: 'tel', autocomplete: 'off' });
    var addBox = canAdd ? h('div', { class: 'stack', hidden: true, style: 'margin-top:14px' }, nName, nPhone, err,
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
        err.setAttribute('hidden', '');
        if (!nName.value.trim()) { err.textContent = 'Enter the supplier name.'; err.removeAttribute('hidden'); return; }
        var res = await sb.from('suppliers').insert({ name: nName.value.trim(), phone: nPhone.value.trim() || null });
        if (res.error) {
          err.textContent = res.error.code === '23505' ? 'A supplier with this name already exists.' : 'Could not save: ' + res.error.message;
          err.removeAttribute('hidden'); return;
        }
        C.toast('Supplier added.'); reload();
      } }, 'Save supplier')) : null;

    show(h('div', {}, C.header('Suppliers', C.goHome),
      h('div', { class: 'stat' }, h('span', { class: 'stat-body' },
        h('span', { class: 'stat-label' }, 'You owe suppliers'), h('span', { class: 'stat-num' }, rs(owed)))),
      canAdd ? h('section', { class: 'sec' },
        h('button', { class: 'btn btn-block', type: 'button', onclick: function () { addBox.removeAttribute('hidden'); nName.focus(); } }, icon('plus'), 'Add supplier'),
        addBox) : null,
      h('section', { class: 'sec' }, h('h2', {}, 'All suppliers'),
        list.length ? list.map(function (x) {
          var b = Number(x.balance_owed);
          return h('button', { class: 'sup-row', type: 'button', onclick: function () { detail(x); } },
            h('span', { class: 'sup-main' }, h('b', {}, x.name),
              h('span', { class: 'muted' }, 'Bought ' + rs(x.total_bought) + ' · Paid ' + rs(x.total_paid))),
            h('span', { class: 'sup-bal ' + (b > 0 ? 'owe' : 'ok') }, b > 0 ? rs(b) : b < 0 ? rs(-b) + ' credit' : 'Settled'),
            icon('chevron'));
        }) : h('p', { class: 'muted' }, 'No suppliers yet. They are added when you enter a purchase, or add one here.'))));

    // ------------------------------------------------------------ detail
    async function detail(s) {
      show(h('div', {}, C.header(s.name, function () { reload(); }), h('p', { class: 'muted' }, 'Loading…')));
      var d = await Promise.all([
        sb.from('purchase_bills').select('id,bill_date,total_amount,amount_paid').eq('supplier_id', s.supplier_id).order('bill_date', { ascending: false }).limit(15),
        sb.from('supplier_payments').select('id,paid_on,amount,notes').eq('supplier_id', s.supplier_id).order('paid_on', { ascending: false }).order('created_at', { ascending: false }).limit(15)
      ]);
      var bills = d[0].error ? null : d[0].data || [], pays = d[1].error ? [] : d[1].data || [];
      var b = Number(s.balance_owed);
      var perr = h('div', { class: 'error', role: 'alert', hidden: true });
      function fail(m) { perr.textContent = m; perr.removeAttribute('hidden'); }
      var pdate = h('input', { id: 'pdate', type: 'date', value: today() });
      var pamt = h('input', { id: 'pamt', inputmode: 'decimal', placeholder: b > 0 ? String(Math.round(b)) : '0', autocomplete: 'off' });
      var pnote = h('input', { id: 'pnote', placeholder: 'Optional', autocomplete: 'off' });
      var pbtn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
        perr.setAttribute('hidden', '');
        var a = num(pamt.value);
        if (!pdate.value) return fail('Choose the date.');
        if (!isFinite(a) || a <= 0) return fail('Enter the amount paid (more than 0).');
        pbtn.disabled = true; pbtn.textContent = 'Saving…';
        var res = await sb.from('supplier_payments').insert({ supplier_id: s.supplier_id, paid_on: pdate.value, amount: a, notes: pnote.value.trim() || null });
        if (res.error) { pbtn.disabled = false; pbtn.textContent = 'Save payment'; return fail('Could not save: ' + res.error.message); }
        C.toast('Payment saved.'); reload(s.supplier_id);
      } }, 'Save payment');

      var eName = h('input', { id: 'ename', value: s.name, autocomplete: 'off' });
      var ePhone = h('input', { id: 'ephone', value: s.phone || '', inputmode: 'tel', autocomplete: 'off' });
      var eerr = h('div', { class: 'error', role: 'alert', hidden: true });
      var editBox = canEdit ? h('div', { class: 'stack', hidden: true, style: 'margin-top:14px' },
        h('label', { for: 'ename' }, 'Name'), eName, h('label', { for: 'ephone' }, 'Phone'), ePhone, eerr,
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
          eerr.setAttribute('hidden', '');
          if (!eName.value.trim()) { eerr.textContent = 'Enter the supplier name.'; eerr.removeAttribute('hidden'); return; }
          var res = await sb.from('suppliers').update({ name: eName.value.trim(), phone: ePhone.value.trim() || null }).eq('id', s.supplier_id);
          if (res.error) { eerr.textContent = res.error.code === '23505' ? 'A supplier with this name already exists.' : 'Could not save: ' + res.error.message; eerr.removeAttribute('hidden'); return; }
          C.toast('Saved.'); reload(s.supplier_id);
        } }, 'Save details')) : null;

      show(h('div', {}, C.header(s.name, function () { reload(); }),
        s.phone ? h('p', { class: 'muted' }, s.phone) : null,
        h('div', { class: 'dash' },
          h('div', { class: 'stat hero' }, h('span', { class: 'stat-body' },
            h('span', { class: 'stat-label' }, b < 0 ? 'Paid in advance' : 'You owe'),
            h('span', { class: 'stat-num' }, rs(Math.abs(b))))),
          h('div', { class: 'stat sales' }, h('span', { class: 'stat-body' }, h('span', { class: 'stat-label' }, 'Bought'), h('span', { class: 'stat-num' }, rs(s.total_bought)))),
          h('div', { class: 'stat profit' }, h('span', { class: 'stat-body' }, h('span', { class: 'stat-label' }, 'Paid'), h('span', { class: 'stat-num' }, rs(s.total_paid))))),
        canAdd ? h('section', { class: 'sec' }, h('h2', {}, 'Record payment'),
          h('label', { for: 'pdate' }, 'Date'), pdate,
          h('label', { for: 'pamt', style: 'margin-top:14px' }, 'Amount paid (Rs)'), pamt,
          h('label', { for: 'pnote', style: 'margin-top:14px' }, 'Note'), pnote, perr,
          h('div', { class: 'actions', style: 'margin-top:18px' }, pbtn)) : null,
        h('section', { class: 'sec' }, h('h2', {}, 'Payments'),
          pays.length ? pays.map(function (x) {
            return h('div', { class: 'r-line' },
              h('span', {}, niceDate(x.paid_on), x.notes ? h('span', { class: 'muted' }, ' · ' + x.notes) : null),
              h('span', { class: 'row-end' }, h('b', { class: 'num' }, rs(x.amount)),
                canDelete ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Delete payment', onclick: async function () {
                  if (!window.confirm('Delete this payment?')) return;
                  var res = await sb.from('supplier_payments').delete().eq('id', x.id);
                  if (res.error) { C.toast('Could not delete: ' + res.error.message); return; }
                  C.toast('Deleted.'); reload(s.supplier_id);
                } }, icon('trash')) : null));
          }) : h('p', { class: 'muted' }, 'No payments yet.')),
        bills ? h('section', { class: 'sec' }, h('h2', {}, 'Purchase bills'),
          bills.length ? bills.map(function (x) {
            return h('div', { class: 'r-line' }, h('span', {}, niceDate(x.bill_date), h('span', { class: 'muted' }, ' · paid ' + rs(x.amount_paid) + ' at purchase')),
              h('b', { class: 'num' }, rs(x.total_amount)));
          }) : h('p', { class: 'muted' }, 'No bills yet.')) : null,
        canEdit ? h('section', { class: 'sec' },
          h('button', { class: 'btn btn-block', type: 'button', onclick: function () { editBox.removeAttribute('hidden'); eName.focus(); } }, 'Edit supplier details'),
          editBox) : null));
    }
  };
})();
