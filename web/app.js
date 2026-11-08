(function () {
  'use strict';

  var cfg = window.CANTEEN_CONFIG || {};
  var app = document.getElementById('app');
  var ICONS = {
    items: '🏷️', purchases: '🧾', stock_counts: '📦', cash_handovers: '💵',
    expenses: '🧮', suppliers: '🚚', reports: '📊'
  };

  // Small DOM helper: builds elements without innerHTML, so nothing from the server can inject markup.
  function h(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    function add(c) {
      if (c == null) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return node;
  }
  function show(node) { app.replaceChildren(node); }

  function notConfigured() {
    return !cfg.supabaseUrl || !cfg.supabaseAnonKey ||
      /YOUR_/.test(cfg.supabaseUrl) || /YOUR_/.test(cfg.supabaseAnonKey);
  }

  if (notConfigured()) {
    show(h('div', { class: 'card' },
      h('h1', {}, 'Almost ready'),
      h('p', { class: 'sub' }, 'Open web/config.js and paste your Supabase project URL and the public anon key (Project Settings → API).')));
    return;
  }

  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Shared toolbox for the screen files (purchase.js, ...). Screens register in Canteen.screens[feature].
  window.Canteen = { sb: sb, h: h, show: show, toast: toast, screens: {}, goHome: function () { return loadHome(); } };

  // "ali" -> ali@canteen.local ; a full email is used as typed.
  function toEmail(id) {
    id = id.trim().toLowerCase();
    return id.indexOf('@') > -1 ? id : id + '@' + (cfg.loginDomain || 'canteen.local');
  }

  function toast(msg) {
    var t = h('div', { class: 'toast', role: 'status' }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }

  function renderLogin(message) {
    var err = h('div', { class: 'error', role: 'alert', hidden: '' });
    if (message) { err.textContent = message; err.removeAttribute('hidden'); }
    var user = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', required: '' });
    var pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: '' });
    var btn = h('button', { class: 'primary', type: 'submit' }, 'Log in');

    var form = h('form', { class: 'card', novalidate: '' },
      h('h1', {}, 'Canteen Manager'),
      h('p', { class: 'sub' }, 'Log in with your username and password.'),
      h('label', { for: 'u' }, 'Username'), user,
      h('label', { for: 'p' }, 'Password'), pass,
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
          ? 'Wrong username or password.' : 'Could not log in: ' + res.error.message;
        err.removeAttribute('hidden');
        return;
      }
      await sb.rpc('touch_login');   // records "last login" for the admin
      loadHome();
    });
    show(form);
    user.focus();
  }

  async function loadHome() {
    var r = await Promise.all([
      sb.from('v_me').select('*').maybeSingle(),
      sb.from('v_my_permissions').select('*')
    ]);
    var me = r[0].data, perms = r[1].data || [];
    if (r[0].error || !me) {
      // Logged in at Supabase, but no active app account (disabled, forced out, or not set up).
      await sb.auth.signOut();
      renderLogin('This account is disabled or not set up yet. Ask the admin.');
      return;
    }
    renderHome(me, perms);
  }

  function renderHome(me, perms) {
    var tiles = perms.filter(function (p) { return p.can_view; }).map(function (p) {
      var ready = !!window.Canteen.screens[p.feature];
      return h('button', { class: 'tile', type: 'button', onclick: function () {
          var open = window.Canteen.screens[p.feature];
          if (open) open(me, perms); else toast(p.label + ' screen is coming next.');
        } },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, ICONS[p.feature] || '•'),
        h('span', {}, p.label),
        ready ? null : h('span', { class: 'soon' }, 'Coming next'));
    });
    if (me.can_manage_users) {
      tiles.push(h('button', { class: 'tile', type: 'button', onclick: function () { toast('Users and roles screen is coming next.'); } },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '👥'),
        h('span', {}, 'Users and roles'),
        h('span', { class: 'soon' }, 'Coming next')));
    }
    var logout = h('button', { type: 'button', onclick: async function () { await sb.auth.signOut(); renderLogin(); } }, 'Log out');
    show(h('div', {},
      h('div', { class: 'bar' },
        h('div', {}, h('h1', {}, 'Hello, ' + me.full_name), h('p', { class: 'sub' }, me.role_name)),
        logout),
      tiles.length ? h('div', { class: 'grid' }, tiles)
                   : h('div', { class: 'card' }, 'Your role has no screens yet. Ask the admin to give you access.')));
  }

  // Signed out elsewhere (e.g. token expired): go back to the login screen.
  sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_OUT') renderLogin(); });

  sb.auth.getSession().then(function (r) { if (r.data && r.data.session) loadHome(); else renderLogin(); });
})();
