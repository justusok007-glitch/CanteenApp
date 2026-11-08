// Backups for the free Supabase plan: download everything to one file, restore it later (admin only).
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;
  var KEY = 'canteen.lastbackup';
  var TABLES = ['suppliers', 'items', 'item_price_history', 'purchase_bills', 'purchase_lines', 'supplier_payments',
    'stock_counts', 'stock_count_lines', 'wastage', 'cash_handovers', 'credit_entries', 'expenses', 'school_days'];
  var LABEL = { suppliers: 'suppliers', items: 'items', item_price_history: 'price changes', purchase_bills: 'purchase bills',
    purchase_lines: 'purchase lines', supplier_payments: 'supplier payments', stock_counts: 'stock counts',
    stock_count_lines: 'count lines', wastage: 'wastage entries', cash_handovers: 'cash handovers',
    credit_entries: 'credit entries', expenses: 'expenses', school_days: 'school days' };

  function lastBackup() { try { var v = localStorage.getItem(KEY); return v ? new Date(v) : null; } catch (e) { return null; } }
  function setLast(d) { try { localStorage.setItem(KEY, d.toISOString()); } catch (e) { /* optional */ } }
  function daysSince(d) { return Math.floor((Date.now() - d.getTime()) / 86400000); }
  function when(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }

  // Starts the 7-day clock the first time an admin opens the app on this device.
  function due() {
    var d = lastBackup();
    if (!d) { setLast(new Date()); return null; }
    var n = daysSince(d);
    return n >= 7 ? n : null;
  }

  async function fetchAll(table) {
    var rows = [], from = 0, size = 1000, order = table === 'school_days' ? 'day' : 'id';
    for (;;) {
      var r = await sb.from(table).select('*').order(order).range(from, from + size - 1);
      if (r.error) throw new Error(table + ': ' + r.error.message);
      rows = rows.concat(r.data || []);
      if (!r.data || r.data.length < size) break;
      from += size;
    }
    return rows;
  }

  async function makeBackup(me) {
    var tables = {};
    for (var i = 0; i < TABLES.length; i++) tables[TABLES[i]] = await fetchAll(TABLES[i]);
    return { format: 'canteenapp-backup', version: 1, created_at: new Date().toISOString(), made_by: me.full_name, tables: tables };
  }

  function save(text, name) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function section(me) {
    var last = lastBackup();
    var status = h('p', { class: 'muted', style: 'margin-top:8px' });
    function paintStatus() {
      var d = lastBackup();
      status.textContent = d ? 'Last backup from this device: ' + when(d) + ' (' + (daysSince(d) === 0 ? 'today' : daysSince(d) + ' days ago') + ').'
                             : 'No backup made from this device yet.';
    }
    paintStatus();
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    var dl = h('button', { class: 'btn btn-primary btn-block', type: 'button', style: 'margin-top:14px', onclick: async function () {
      err.setAttribute('hidden', '');
      dl.disabled = true; dl.textContent = 'Preparing…';
      try {
        var b = await makeBackup(me);
        var day = new Date().toISOString().slice(0, 10);
        save(JSON.stringify(b), 'canteen-backup-' + day + '.json');
        setLast(new Date()); paintStatus();
        var n = TABLES.reduce(function (s, t) { return s + b.tables[t].length; }, 0);
        C.toast('Backup saved (' + n + ' records). Keep the file safe.');
      } catch (e) { err.textContent = 'Could not make the backup: ' + e.message; err.removeAttribute('hidden'); }
      dl.disabled = false; dl.textContent = 'Download backup';
    } }, 'Download backup');

    // ---- restore
    var rErr = h('div', { class: 'error', role: 'alert', hidden: true });
    var summary = h('div', { class: 'stack' });
    var word = h('input', { id: 'restoreword', type: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'Type RESTORE', 'aria-label': 'Type RESTORE to confirm' });
    var parsed = null;
    var go = h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: async function () {
      rErr.setAttribute('hidden', '');
      if (!parsed) return;
      if (word.value.trim() !== 'RESTORE') { rErr.textContent = 'Type RESTORE exactly as shown to confirm.'; rErr.removeAttribute('hidden'); return; }
      go.disabled = true; go.textContent = 'Restoring…';
      var r = await sb.rpc('restore_canteen_data', { p_confirm: 'RESTORE', p_data: parsed });
      go.disabled = false; go.textContent = 'Replace everything with this backup';
      if (r.error) {
        rErr.textContent = /does not exist|schema cache/.test(r.error.message)
          ? 'Restore needs the latest database update (005_backup.sql).' : 'Could not restore: ' + r.error.message + ' Nothing was changed.';
        rErr.removeAttribute('hidden'); return;
      }
      try { localStorage.removeItem('canteen.stockdraft'); } catch (e) { /* optional */ }
      C.toast('Backup restored.');
      C.goHome();
    } }, 'Replace everything with this backup');
    var confirm = h('div', { class: 'stack', hidden: true, style: 'margin-top:14px' },
      summary, h('label', { for: 'restoreword' }, 'To confirm, type RESTORE'), word, rErr, go);
    var file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Backup file', onchange: function () {
      var f = file.files && file.files[0];
      parsed = null; confirm.setAttribute('hidden', ''); rErr.setAttribute('hidden', '');
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var d;
        try { d = JSON.parse(String(fr.result)); } catch (e) { d = null; }
        if (!d || d.format !== 'canteenapp-backup' || !d.tables || typeof d.tables !== 'object') {
          rErr.textContent = 'This file is not a CanteenApp backup.'; confirm.removeAttribute('hidden'); summary.replaceChildren(); go.hidden = true; return;
        }
        go.hidden = false; parsed = d;
        var made = d.created_at ? when(new Date(d.created_at)) : 'unknown date';
        summary.replaceChildren(
          h('p', {}, 'Backup made on ' + made + (d.made_by ? ' by ' + d.made_by : '') + ', containing:'),
          h('ul', { class: 'muted', style: 'margin:6px 0 0 18px' }, TABLES.filter(function (t) { return (d.tables[t] || []).length; }).map(function (t) {
            return h('li', {}, d.tables[t].length + ' ' + LABEL[t]);
          })),
          h('p', {}, 'Restoring erases what is in the app now and puts this in its place. Users and roles are not changed.'));
        confirm.removeAttribute('hidden');
      };
      fr.readAsText(f);
    } });

    return h('section', { class: 'sec' },
      h('h2', {}, 'Backup'),
      h('p', {}, 'The free plan has no automatic backups. Download a backup file every week and keep it on your phone or in Google Drive.'),
      status, dl, err,
      h('h2', { style: 'margin-top:22px' }, 'Restore from a backup'),
      h('p', { class: 'muted' }, 'Choose a backup file you downloaded earlier.'),
      h('div', { style: 'margin-top:10px' }, file),
      confirm);
  }

  // A banner for the home screen when the last backup is a week old or more.
  function banner() {
    var n = due();
    if (n == null) return null;
    return h('button', { class: 'dash-note warnbar', type: 'button', onclick: function () { C.openSettings && C.openSettings(); } },
      icon('info'), h('span', {}, 'It has been ' + n + ' days since your last backup. Open Settings and download one.'));
  }

  C.backup = { section: section, banner: banner };
})();
