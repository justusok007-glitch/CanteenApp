// Cash handover: record the cash handed over each day (and the salary kept), then see the cash check.
// The check compares the sales worked out from stock counts with cash handed over + salary kept.
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
    var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function n(k, w) { return k + ' ' + w + (Number(k) === 1 ? '' : 's'); }
  function show(node) { C.show(node, 'cash_handovers'); }

  C.screens.cash_handovers = async function (me, perms) {
    var perm = perms.filter(function (p) { return p.feature === 'cash_handovers'; })[0];
    var canAdd = !!(perm && perm.can_add), canEdit = !!(perm && perm.can_edit);
    var canReport = perms.some(function (p) { return p.feature === 'reports' && p.can_view; });
    if (!perm || (!perm.can_view && !canAdd)) { C.toast('Your role cannot open cash handovers.'); return; }

    show(h('div', {}, C.header('Cash handover', C.goHome), h('p', { class: 'muted' }, 'Loading…')));
    var r = await Promise.all([
      sb.from('cash_handovers').select('id,handed_on,cash_handed,salary_kept,notes').order('handed_on', { ascending: false }).limit(10),
      sb.from('canteens').select('daily_salary').limit(1),
      canReport ? sb.from('v_period_report').select('*').order('to_on', { ascending: false }).limit(1) : Promise.resolve({ data: [] })
    ]);
    if (r[0].error) {
      show(h('div', {}, C.header('Cash handover', C.goHome), h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + r[0].error.message)));
      return;
    }
    var recent = r[0].data || [];
    var salary = r[1].data && r[1].data[0] ? Number(r[1].data[0].daily_salary) : 0;
    var period = r[2].data && r[2].data[0];

    // ----- cash check card
    var check;
    if (!canReport) check = null;
    else if (!period) {
      check = h('section', { class: 'sec' }, h('h2', {}, 'Cash check'),
        h('p', { class: 'muted' }, 'Needs two full stock counts on different days. After that, the check shows here.'));
    } else {
      var short = Number(period.shortage), pct = period.shortage_pct == null ? null : Number(period.shortage_pct);
      var ok = period.within_tolerance;
      var verdict = ok ? 'Cash matches' : short > 0 ? 'Short by ' + rs(short) : 'Extra cash ' + rs(-short);
      var warn = [];
      if (Number(period.items_missing)) warn.push(n(period.items_missing, 'item') + ' missing from a count');
      if (Number(period.items_negative)) warn.push(n(period.items_negative, 'item') + ' sold less than zero (count or purchase mistake)');
      if (Number(period.items_no_price)) warn.push(n(period.items_no_price, 'sold item') + ' without a price');
      check = h('section', { class: 'sec' },
        h('h2', {}, 'Cash check'),
        h('p', { class: 'muted' }, niceDate(period.from_on) + ' to ' + niceDate(period.to_on)),
        h('div', { class: 'verdict ' + (ok ? 'good' : 'bad'), role: 'status' },
          h('span', { class: 'verdict-big' }, verdict),
          pct != null ? h('span', { class: 'verdict-sub' }, (pct > 0 ? '' : pct < 0 ? '−' : '') + Math.abs(pct) + '% of sales') : null),
        h('div', { class: 'r-line' }, h('span', {}, 'Sales from stock counts'), h('b', { class: 'num' }, rs(period.sales_value))),
        h('div', { class: 'r-line' }, h('span', {}, 'Cash handed over'), h('b', { class: 'num' }, rs(period.cash_handed))),
        h('div', { class: 'r-line' }, h('span', {}, 'Salary kept'), h('b', { class: 'num' }, rs(period.salary_kept))),
        warn.length ? h('div', { class: 'error', role: 'alert' }, 'Check before trusting this: ' + warn.join('; ') + '.') : null);
    }

    // ----- form
    var date = h('input', { id: 'hdate', type: 'date', value: today() });
    var cash = h('input', { id: 'hcash', inputmode: 'decimal', placeholder: '0', autocomplete: 'off' });
    var sal = h('input', { id: 'hsal', inputmode: 'decimal', value: String(salary) });
    var notes = h('input', { id: 'hnotes', placeholder: 'Optional', autocomplete: 'off' });
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    var btn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: save }, 'Save handover');

    function existingOn(d) { return recent.filter(function (x) { return x.handed_on === d; })[0]; }
    function fillFor() {
      var ex = existingOn(date.value);
      if (ex) { cash.value = String(Number(ex.cash_handed)); sal.value = String(Number(ex.salary_kept)); notes.value = ex.notes || ''; btn.textContent = 'Update handover'; }
      else { btn.textContent = 'Save handover'; }
    }
    date.addEventListener('change', fillFor);

    async function save() {
      err.setAttribute('hidden', '');
      var c = num(cash.value), s = num(sal.value);
      var msg = !date.value ? 'Choose the date.' : !isFinite(c) || c < 0 ? 'Enter the cash handed over (0 or more).'
        : !isFinite(s) || s < 0 ? 'Enter the salary kept (0 if none).' : '';
      var ex = existingOn(date.value);
      if (!msg && ex && !canEdit) msg = 'A handover for this date is already saved. Your role cannot change it.';
      if (!msg && !ex && !canAdd) msg = 'Your role cannot add handovers.';
      if (msg) { err.textContent = msg; err.removeAttribute('hidden'); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      var row = { cash_handed: c, salary_kept: s, notes: notes.value.trim() || null };
      var res = ex ? await sb.from('cash_handovers').update(row).eq('id', ex.id)
                   : await sb.from('cash_handovers').insert(Object.assign({ handed_on: date.value }, row));
      if (res.error) {
        btn.disabled = false; btn.textContent = ex ? 'Update handover' : 'Save handover';
        err.textContent = res.error.code === '23505' ? 'A handover for this date is already saved. Reopen this screen to update it.'
          : 'Could not save: ' + res.error.message;
        err.removeAttribute('hidden'); return;
      }
      C.toast('Handover saved.');
      C.screens.cash_handovers(me, perms);
    }

    var form = canAdd ? h('section', { class: 'sec' },
      h('h2', {}, 'Record handover'),
      h('label', { for: 'hdate' }, 'Date'), date,
      h('label', { for: 'hcash', style: 'margin-top:14px' }, 'Cash handed over (Rs)'), cash,
      h('label', { for: 'hsal', style: 'margin-top:14px' }, 'Salary kept (Rs)'), sal,
      h('p', { class: 'hint' }, 'Salary is always taken from the day’s cash. Set the usual amount in canteen settings.'),
      h('label', { for: 'hnotes', style: 'margin-top:14px' }, 'Note'), notes, err,
      h('div', { class: 'actions', style: 'margin-top:18px' }, btn)) : null;

    var list = h('section', { class: 'sec' }, h('h2', {}, 'Recent handovers'),
      recent.length ? recent.map(function (x) {
        return h('div', { class: 'r-line' },
          h('span', {}, niceDate(x.handed_on), x.notes ? h('span', { class: 'muted' }, ' · ' + x.notes) : null),
          h('b', { class: 'num' }, rs(x.cash_handed) + ' + ' + rs(x.salary_kept)));
      }) : h('p', { class: 'muted' }, 'No handovers yet.'));

    show(h('div', {}, C.header('Cash handover', C.goHome), check, form, list));
    fillFor();
  };
})();
