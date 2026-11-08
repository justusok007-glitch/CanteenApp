(function () {
  'use strict';

  var cfg = window.CANTEEN_CONFIG || {};
  var app = document.getElementById('app');
  var nav = document.getElementById('tabs');
  var NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- icons (24px, 1.8 stroke, one family)
  var ICONS = {
    home: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
    receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6'],
    box: ['M3 7l9-4 9 4v10l-9 4-9-4z', 'M3 7l9 4 9-4', 'M12 11v10'],
    cash: ['M2 6h20v12H2z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M6 10v4', 'M18 10v4'],
    wallet: ['M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12', 'M16 13.5h.01'],
    truck: ['M2 6h11v10H2z', 'M13 9h4l3 3v4h-7', 'M6 16.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z', 'M17 16.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z'],
    chart: ['M4 20V10', 'M10 20V4', 'M16 20v-8', 'M22 20H2'],
    tag: ['M3 12V3h9l9 9-9 9z', 'M7.5 6.5h.01'],
    users: ['M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M2 20c0-3.5 3-6 7-6s7 2.5 7 6', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14c2.5.7 4 2.6 4 6'],
    user: ['M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M4 21c0-4 3.6-7 8-7s8 3 8 7'],
    chevron: ['M9 6l6 6-6 6'],
    back: ['M15 6l-6 6 6 6'],
    plus: ['M12 5v14', 'M5 12h14'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
    eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
    eyeoff: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M4 4l16 16'],
    trend: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
    info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 7.8h.01'],
    logout: ['M9 4H5v16h4', 'M16 8l4 4-4 4', 'M20 12H9']
  };
  function icon(name) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    });
    return s;
  }

  // Short names for the bottom bar, full names (from the database) for lists.
  var FEATURE = {
    items:          { short: 'Items',     name: 'Items and prices',     icon: 'tag' },
    purchases:      { short: 'Purchases', name: 'Purchases',            icon: 'receipt' },
    stock_counts:   { short: 'Count',     name: 'Stock count',          icon: 'box' },
    cash_handovers: { short: 'Cash',      name: 'Cash handover',        icon: 'cash' },
    expenses:       { short: 'Expenses',  name: 'Expenses and wastage', icon: 'wallet' },
    suppliers:      { short: 'Suppliers', name: 'Suppliers',            icon: 'truck' },
    reports:        { short: 'Reports',   name: 'Reports',              icon: 'chart' }
  };
  var FEATURE_ORDER = ['purchases', 'stock_counts', 'cash_handovers', 'items', 'suppliers', 'expenses', 'reports'];

  // ---------------------------------------------------------------- DOM helper (no innerHTML)
  function h(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    function add(c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return node;
  }

  var state = { me: null, perms: [] };

  function show(node, active, opts) {
    app.className = opts && opts.bare ? 'bare' : '';
    app.replaceChildren(node);
    renderNav(active || 'home');
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }

  // Page header: optional back arrow, title, optional right-hand content.
  function header(title, onBack, right) {
    return h('div', { class: 'hdr' },
      onBack ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Back', onclick: onBack }, icon('back')) : null,
      h('h1', {}, title), right || null);
  }

  function toast(msg) {
    var t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }

  function notConfigured() {
    return !cfg.supabaseUrl || !cfg.supabaseAnonKey || /YOUR_/.test(cfg.supabaseUrl) || /YOUR_/.test(cfg.supabaseAnonKey);
  }
  if (notConfigured()) {
    show(h('div', { class: 'stack' }, h('h1', {}, 'Almost ready'),
      h('p', { class: 'muted' }, 'Open web/config.js and paste your Supabase project URL and the public anon key (Project Settings → API).')), 'home', { bare: true });
    return;
  }

  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  window.Canteen = {
    sb: sb, h: h, show: show, toast: toast, icon: icon, header: header, screens: {},
    goHome: function () { return loadHome(); }
  };

  function greeting() {
    var hr = new Date().getHours();
    return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  }
  function toEmail(id) {
    id = id.trim().toLowerCase();
    return id.indexOf('@') > -1 ? id : id + '@' + (cfg.loginDomain || 'canteen.local');
  }

  // ---------------------------------------------------------------- bottom navigation
  function renderNav(active) {
    if (!state.me) { nav.hidden = true; nav.replaceChildren(); return; }
    var tabs = [{ key: 'home', label: 'Home', icon: 'home', go: loadHome }];
    FEATURE_ORDER.forEach(function (f) {
      var p = state.perms.filter(function (x) { return x.feature === f; })[0];
      if (p && (p.can_view || p.can_add) && window.Canteen.screens[f] && tabs.length < 4) {
        tabs.push({ key: f, label: FEATURE[f].short, icon: FEATURE[f].icon,
          go: function () { window.Canteen.screens[f](state.me, state.perms); } });
      }
    });
    tabs.push({ key: 'account', label: 'Account', icon: 'user', go: renderAccount });
    nav.hidden = false;
    nav.replaceChildren.apply(nav, tabs.map(function (t) {
      var on = t.key === active;
      return h('button', { type: 'button', class: 'tab' + (on ? ' on' : ''), 'aria-current': on ? 'page' : null, onclick: t.go },
        h('span', { class: 'pillbg' }, icon(t.icon)), t.label);
    }));
  }

  // ---------------------------------------------------------------- login
  function renderLogin(message) {
    state.me = null;
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    if (message) { err.textContent = message; err.removeAttribute('hidden'); }
    var user = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true });
    var pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
    var eye = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Show password' }, icon('eye'));
    eye.addEventListener('click', function () {
      var shown = pass.type === 'text';
      pass.type = shown ? 'password' : 'text';
      eye.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      eye.replaceChildren(icon(shown ? 'eye' : 'eyeoff'));
    });
    var btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit', style: 'margin-top:24px' }, 'Log in');

    var form = h('form', { novalidate: true },
      h('div', { class: 'brand' },
        (function () {
          var img = h('img', { class: 'mark', src: 'icon.svg', alt: '', width: '56', height: '56' });
          return img;
        })(),
        h('div', {}, h('h1', {}, 'Canteen Manager'), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Log in to record stock, purchases and cash.'))),
      h('label', { for: 'u' }, 'Username or email'), user,
      h('label', { for: 'p' }, 'Password'), h('div', { class: 'pw' }, pass, eye),
      err, btn);

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      err.setAttribute('hidden', '');
      if (!user.value.trim() || !pass.value) {
        err.textContent = 'Enter your username and password.'; err.removeAttribute('hidden'); return;
      }
      btn.disabled = true; btn.textContent = 'Logging in…';
      var res = await sb.auth.signInWithPassword({ email: toEmail(user.value), password: pass.value });
      if (res.error) {
        btn.disabled = false; btn.textContent = 'Log in';
        err.textContent = /invalid login/i.test(res.error.message)
          ? 'Wrong username or password. Check both and try again.' : 'Could not log in: ' + res.error.message;
        err.removeAttribute('hidden');
        return;
      }
      await sb.rpc('touch_login');
      loadHome();
    });
    show(form, 'home', { bare: true });
    user.focus();
  }

  async function loadHome() {
    var r = await Promise.all([
      sb.from('v_me').select('*').maybeSingle(),
      sb.from('v_my_permissions').select('*')
    ]);
    var me = r[0].data, perms = r[1].data || [];
    if (r[0].error || !me) {
      await sb.auth.signOut();
      renderLogin('This account is disabled or not set up yet. Ask the admin.');
      return;
    }
    state.me = me; state.perms = perms;
    renderHome();
  }

  // ---------------------------------------------------------------- home
  function niceDate(iso) {
    var p = String(iso).split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function rs(n) { return 'Rs ' + Math.round(n).toLocaleString('en-PK'); }

  // Sales summary. Sales are worked out from stock counts (never typed in), so today's figure
  // appears once a count closes today, and sales between counts are spread evenly over the days.
  async function fillDashboard(box) {
    var r = await sb.from('v_dashboard').select('*').maybeSingle();
    if (r.error) {
      box.replaceChildren(h('p', { class: 'dash-note' }, 'The sales summary needs the latest database update.'));
      return;
    }
    var d = r.data;
    if (!d) { box.replaceChildren(); return; }
    var month = new Date().toLocaleDateString('en-GB', { month: 'long' });
    function stat(cls, ic, label, value, sub, emptyVal) {
      return h('div', { class: 'stat ' + cls },
        h('span', { class: 'stat-ic' }, icon(ic)),
        h('span', { class: 'stat-body' },
          h('span', { class: 'stat-label' }, label),
          h('span', { class: emptyVal ? 'stat-empty' : 'stat-num' }, value),
          sub ? h('span', { class: 'stat-sub' }, sub) : null));
    }
    var cards = [
      d.today_sales == null
        ? stat('hero', 'chart', "Today's sale", 'Not counted yet', d.as_of ? 'Last stock count: ' + niceDate(d.as_of) : 'Do your first stock count to see sales here.', true)
        : stat('hero', 'chart', "Today's sale", rs(d.today_sales), d.as_of ? 'Last stock count: ' + niceDate(d.as_of) : ''),
      stat('sales', 'tag', 'Sales in ' + month, rs(d.month_sales))
    ];
    if (d.month_profit != null) {
      var loss = Number(d.month_profit) < 0;
      cards.push(stat('profit' + (loss ? ' loss' : ''), 'trend', 'Profit in ' + month, (loss ? '\u2212' : '') + rs(Math.abs(d.month_profit))));
    }
    cards.push(h('p', { class: 'dash-note' }, icon('info'),
      h('span', {}, 'Worked out from your stock counts, spread evenly between counts.' +
      (d.month_profit != null ? ' Profit is after salary, wastage and expenses.' : ''))));
    box.replaceChildren.apply(box, cards);
  }

  function renderHome() {
    var me = state.me, perms = state.perms, S = window.Canteen.screens;
    var canAddPurchase = perms.some(function (p) { return p.feature === 'purchases' && p.can_add; }) && S.purchases;
    var showStats = perms.some(function (p) { return p.feature === 'reports' && p.can_view; });

    function tile(cls, iconName, name, ready, open) {
      return h('button', { class: 'tile ' + cls, type: 'button', 'aria-disabled': ready ? null : 'true', onclick: ready ? open : null },
        h('span', { class: 'tile-top' }, icon(iconName), ready ? null : h('span', { class: 'pill' }, 'Soon')),
        h('span', { class: 'tile-bottom' }, h('span', { class: 'tile-name' }, name), ready ? icon('chevron') : null));
    }
    var tiles = perms.filter(function (p) { return p.can_view; }).map(function (p) {
      var f = FEATURE[p.feature] || { icon: 'tag', name: p.label };
      return tile('t-' + p.feature, f.icon, f.name, !!S[p.feature], function () { S[p.feature](me, perms); });
    });
    if (me.can_manage_users) tiles.push(tile('t-users', 'users', 'Users and roles', false));

    var dash = showStats ? h('section', { class: 'dash', 'aria-label': 'Sales summary' },
      h('div', { class: 'stat hero' }, h('span', { class: 'stat-label' }, "Today's sale"), h('span', { class: 'stat-empty' }, '…'))) : null;

    show(h('div', {},
      h('div', { class: 'hdr', style: 'align-items:flex-start' },
        h('div', {}, h('p', { class: 'hello' }, greeting() + ','), h('h1', {}, me.full_name))),
      dash,
      canAddPurchase ? h('div', { class: 'cta' },
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: function () { S.purchases(me, perms); } },
          icon('plus'), 'New purchase')) : null,
      tiles.length ? h('div', { class: 'tiles' }, tiles)
                   : h('p', { class: 'muted' }, 'Your role has no screens yet. Ask the admin to give you access.')), 'home');
    if (dash) fillDashboard(dash);
  }

  // ---------------------------------------------------------------- account
  function renderAccount() {
    var me = state.me;
    show(h('div', {},
      header('Account'),
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, (me.full_name || '?').trim().charAt(0).toUpperCase()),
      h('p', { class: 'display', style: 'font-size:1.3rem;font-weight:700' }, me.full_name),
      h('p', { class: 'muted' }, me.role_name + ' · ' + me.username),
      h('div', { class: 'actions', style: 'margin-top:28px' },
        h('button', { class: 'btn', type: 'button', onclick: async function () { await sb.auth.signOut(); renderLogin(); } },
          icon('logout'), 'Log out'))), 'account');
  }

  // Start only after every script tag has run, so all screens (purchase.js, ...) are registered
  // before the home screen decides which buttons and tabs to show.
  function boot() {
    sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_OUT' && state.me) renderLogin(); });
    sb.auth.getSession().then(function (r) { if (r.data && r.data.session) loadHome(); else renderLogin(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
