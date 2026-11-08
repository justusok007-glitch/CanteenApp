// Users and roles. Creating logins and resetting passwords go through the "manage-users" Edge Function
// (they need the service role). Everything else (roles, permissions, activate, force logout) uses the database
// directly, protected by row-level security.
(function () {
  'use strict';
  var C = window.Canteen;
  if (!C) return;
  var h = C.h, sb = C.sb, icon = C.icon;
  var ACTIONS = [['can_view', 'View'], ['can_add', 'Add'], ['can_edit', 'Edit'], ['can_delete', 'Delete']];

  function show(node) { C.show(node, 'users'); }
  function niceDate(s) { return s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'never'; }

  // Calls the Edge Function and turns every failure into a message that says what really went wrong.
  async function service(body) {
    var r = await sb.functions.invoke('manage-users', { body: body });
    if (!r.error) return { ok: true };
    var res = r.error.context, status = res && res.status, text = '';
    if (!status) return { ok: false, message: 'Could not reach the manage-users function (' + (r.error.message || 'network problem') + '). Check your internet and that the function is deployed.' };
    try { text = await res.text(); } catch (e) { /* no body */ }
    var info = null; try { info = JSON.parse(text); } catch (e) { /* not JSON */ }
    var said = info && (info.error || info.message) ? String(info.error || info.message) : text;
    if (info && info.error) return { ok: false, message: said };               // our own, already readable
    if (status === 404) return { ok: false, message: 'Supabase says the function was not found (404). In Edge Functions it must be named exactly manage-users.' };
    if (status === 401) return { ok: false, message: 'Supabase rejected your login token (401: ' + said + '). Open the manage-users function settings and turn "Verify JWT" off, then deploy again.' };
    return { ok: false, message: 'The manage-users function failed (' + status + '): ' + (said || 'no details') + '. Open its Logs in Supabase for the reason.' };
  }

  C.screens.users = async function (me, perms, view, id) {
    if (!me.can_manage_users) { C.toast('Your role cannot manage users.'); return; }
    view = view || 'users';
    if (view === 'roles' || view === 'role') { if (!me.is_admin) { C.toast('Only an admin can change roles.'); view = 'users'; } }
    function go(v, i) { C.screens.users(me, perms, v, i); }

    show(h('div', {}, C.header('Users and roles', C.goHome), h('p', { class: 'muted' }, 'Loading…')));
    var r = await Promise.all([
      sb.from('users').select('id,username,full_name,role_id,is_active,last_login_at').order('full_name'),
      sb.from('roles').select('id,name,is_admin,show_cost,can_manage_users,edit_days_limit').order('name'),
      sb.from('features').select('feature,label'),
      sb.from('role_permissions').select('role_id,feature,can_view,can_add,can_edit,can_delete')
    ]);
    var bad = r.filter(function (x) { return x.error; })[0];
    if (bad) { show(h('div', {}, C.header('Users and roles', C.goHome), h('div', { class: 'error', role: 'alert' }, 'Could not load: ' + bad.error.message))); return; }
    var users = r[0].data || [], roles = r[1].data || [], features = r[2].data || [], rperms = r[3].data || [];
    var roleById = {}; roles.forEach(function (x) { roleById[x.id] = x; });
    var usable = roles.filter(function (x) { return me.is_admin || !x.is_admin; });

    function tabs(active) {
      var t = [['users', 'Users']].concat(me.is_admin ? [['roles', 'Roles']] : []);
      return h('div', { class: 'segs', role: 'group', 'aria-label': 'Choose list' }, t.map(function (x) {
        return h('button', { type: 'button', class: 'seg', 'aria-pressed': String(active === x[0]), onclick: function () { go(x[0]); } }, x[1]);
      }));
    }
    function errBox() { return h('div', { class: 'error', role: 'alert', hidden: true }); }
    function say(box, m) { box.textContent = m; box.removeAttribute('hidden'); }
    function field(label, node, fid) { return [h('label', { for: fid, style: 'margin-top:14px' }, label), node]; }
    function check(label, checked, disabled) {
      var cb = h('input', { type: 'checkbox', class: 'chk', checked: checked, disabled: disabled });
      return { cb: cb, node: h('label', { class: 'chk-row' }, cb, h('span', {}, label)) };
    }

    // ------------------------------------------------------------ users list
    if (view === 'users') {
      show(h('div', {}, C.header('Users and roles', C.goHome), tabs('users'),
        h('section', { class: 'sec' },
          h('button', { class: 'btn btn-block', type: 'button', onclick: function () { go('newuser'); } }, icon('plus'), 'Add user')),
        h('section', { class: 'sec' }, h('h2', {}, 'People'),
          users.map(function (u) {
            return h('button', { class: 'sup-row', type: 'button', onclick: function () { go('user', u.id); } },
              h('span', { class: 'sup-main' }, h('b', {}, u.full_name),
                h('span', { class: 'muted' }, u.username + ' · ' + (roleById[u.role_id] ? roleById[u.role_id].name : 'No role') + ' · last login ' + niceDate(u.last_login_at))),
              u.is_active ? null : h('span', { class: 'badge bad' }, 'Inactive'), icon('chevron'));
          }))));
      return;
    }

    // ------------------------------------------------------------ new user
    if (view === 'newuser') {
      var fn = h('input', { id: 'nfn', placeholder: 'Full name', autocomplete: 'off' });
      var un = h('input', { id: 'nun', placeholder: 'e.g. ali', autocapitalize: 'none', autocomplete: 'off' });
      var pw = h('input', { id: 'npw', placeholder: 'At least 8 characters', autocomplete: 'off' });
      var rl = h('select', { id: 'nrl' }, usable.map(function (x) { return h('option', { value: x.id }, x.name); }));
      var err = errBox();
      var btn = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
        err.setAttribute('hidden', '');
        if (!fn.value.trim()) return say(err, 'Enter the full name.');
        if (!/^[a-z0-9._-]+$/.test(un.value.trim().toLowerCase())) return say(err, 'Username can use letters, numbers, dot, dash and underscore only.');
        if (pw.value.length < 8) return say(err, 'Password must be at least 8 characters.');
        btn.disabled = true; btn.textContent = 'Creating…';
        var res = await service({ action: 'create', full_name: fn.value.trim(), username: un.value.trim(), password: pw.value, role_id: rl.value });
        if (!res.ok) { btn.disabled = false; btn.textContent = 'Create user'; return say(err, res.message); }
        C.toast('User created. Share the username and password with them.'); go('users');
      } }, 'Create user');
      show(h('div', {}, C.header('Add user', function () { go('users'); }),
        h('section', { class: 'sec' },
          field('Full name', fn, 'nfn'), field('Username', un, 'nun'), field('Password', pw, 'npw'), field('Role', rl, 'nrl'),
          h('p', { class: 'hint' }, 'They log in with the username and this password. They can change it later in Settings.'), err,
          h('div', { class: 'actions', style: 'margin-top:18px' }, btn))));
      return;
    }

    // ------------------------------------------------------------ user detail
    if (view === 'user') {
      var u = users.filter(function (x) { return x.id === id; })[0];
      if (!u) return go('users');
      var locked = roleById[u.role_id] && roleById[u.role_id].is_admin && !me.is_admin;
      var self = u.id === me.id;
      var roleSel = h('select', { id: 'urole', disabled: locked }, usable.concat(locked ? [roleById[u.role_id]] : []).map(function (x) { return h('option', { value: x.id }, x.name); }));
      roleSel.value = u.role_id;
      var act = check('Can log in', u.is_active, locked || self);
      var perr = errBox(), serr = errBox();
      var saveBtn = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: locked, onclick: async function () {
        serr.setAttribute('hidden', '');
        var res = await sb.from('users').update({ role_id: roleSel.value, is_active: act.cb.checked }).eq('id', u.id);
        if (res.error) return say(serr, 'Could not save: ' + res.error.message);
        C.toast('Saved.'); go('users');
      } }, 'Save changes');
      var np = h('input', { id: 'unp', placeholder: 'New password (8+ characters)', autocomplete: 'off', disabled: locked });
      var pwBtn = h('button', { class: 'btn btn-block', type: 'button', disabled: locked, onclick: async function () {
        perr.setAttribute('hidden', '');
        if (np.value.length < 8) return say(perr, 'Password must be at least 8 characters.');
        pwBtn.disabled = true;
        var res = await service({ action: 'reset_password', user_id: u.id, password: np.value });
        pwBtn.disabled = false;
        if (!res.ok) return say(perr, res.message);
        np.value = ''; C.toast('Password changed. They must log in again.');
      } }, 'Reset password');
      var outBtn = h('button', { class: 'btn btn-block', type: 'button', disabled: locked, onclick: async function () {
        var res = await sb.from('users').update({ force_logout_at: new Date().toISOString() }).eq('id', u.id);
        C.toast(res.error ? 'Could not log out: ' + res.error.message : 'They will be logged out on their next action.');
      } }, 'Log out everywhere');
      show(h('div', {}, C.header(u.full_name, function () { go('users'); }),
        h('p', { class: 'muted' }, u.username + (self ? ' (you)' : '')),
        locked ? h('p', { class: 'hint' }, 'Only an admin can change an admin.') : null,
        h('section', { class: 'sec' }, field('Role', roleSel, 'urole'), h('div', { style: 'margin-top:14px' }, act.node), serr,
          h('div', { class: 'actions', style: 'margin-top:18px' }, saveBtn)),
        h('section', { class: 'sec' }, h('h2', {}, 'Password'), np, perr, h('div', { class: 'actions', style: 'margin-top:12px' }, pwBtn)),
        h('section', { class: 'sec' }, h('h2', {}, 'Sessions'), h('p', { class: 'muted' }, 'Use this if a phone is lost or shared.'),
          h('div', { class: 'actions', style: 'margin-top:12px' }, outBtn))));
      return;
    }

    // ------------------------------------------------------------ roles list (admin)
    if (view === 'roles') {
      var rn = h('input', { id: 'rname', placeholder: 'Role name, e.g. Cashier', autocomplete: 'off' });
      var rerr = errBox();
      var addBox = h('div', { class: 'stack', hidden: true, style: 'margin-top:14px' }, rn, rerr,
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: async function () {
          rerr.setAttribute('hidden', '');
          if (!rn.value.trim()) return say(rerr, 'Enter the role name.');
          var res = await sb.from('roles').insert({ canteen_id: me.canteen_id, name: rn.value.trim() }).select('id').single();
          if (res.error) return say(rerr, res.error.code === '23505' ? 'A role with this name already exists.' : 'Could not save: ' + res.error.message);
          go('role', res.data.id);
        } }, 'Create role'));
      show(h('div', {}, C.header('Users and roles', C.goHome), tabs('roles'),
        h('section', { class: 'sec' },
          h('button', { class: 'btn btn-block', type: 'button', onclick: function () { addBox.removeAttribute('hidden'); rn.focus(); } }, icon('plus'), 'Add role'), addBox),
        h('section', { class: 'sec' }, h('h2', {}, 'Roles'),
          roles.map(function (x) {
            var n = users.filter(function (u2) { return u2.role_id === x.id; }).length;
            return h('button', { class: 'sup-row', type: 'button', onclick: function () { go('role', x.id); } },
              h('span', { class: 'sup-main' }, h('b', {}, x.name),
                h('span', { class: 'muted' }, (x.is_admin ? 'Admin, can do everything' : x.show_cost ? 'Can see costs and profit' : 'Cannot see costs') + ' · ' + n + (n === 1 ? ' person' : ' people'))),
              icon('chevron'));
          }))));
      return;
    }

    // ------------------------------------------------------------ role editor (admin)
    if (view === 'role') {
      var role = roleById[id];
      if (!role) return go('roles');
      var name = h('input', { id: 'rname2', value: role.name, autocomplete: 'off', disabled: role.is_admin });
      var cost = check('Can see cost prices and profit', role.show_cost, role.is_admin);
      var mgr = check('Can manage users (never admins)', role.can_manage_users, role.is_admin);
      var days = h('input', { id: 'rdays', inputmode: 'numeric', placeholder: 'Any age', value: role.edit_days_limit == null ? '' : String(role.edit_days_limit), disabled: role.is_admin });
      var have = {}; rperms.filter(function (p) { return p.role_id === role.id; }).forEach(function (p) { have[p.feature] = p; });
      var boxes = {};
      var grid = h('div', { class: 'pgrid', role: 'group', 'aria-label': 'Permissions' },
        h('span', {}), ACTIONS.map(function (a) { return h('span', { class: 'pgrid-h' }, a[1]); }),
        features.map(function (f) {
          boxes[f.feature] = {};
          var cells = ACTIONS.map(function (a) {
            var cb = h('input', { type: 'checkbox', class: 'chk', checked: role.is_admin || !!(have[f.feature] && have[f.feature][a[0]]), disabled: role.is_admin,
              'aria-label': f.label + ': ' + a[1] });
            boxes[f.feature][a[0]] = cb;
            cb.addEventListener('change', function () {
              var b = boxes[f.feature];
              if (a[0] !== 'can_view' && cb.checked) b.can_view.checked = true;      // any write right needs view
              if (a[0] === 'can_view' && !cb.checked) { b.can_add.checked = b.can_edit.checked = b.can_delete.checked = false; }
            });
            return cb;
          });
          return [h('span', { class: 'pgrid-f' }, f.label)].concat(cells);
        }));
      var err3 = errBox();
      var save = h('button', { class: 'btn btn-primary btn-block', type: 'button', disabled: role.is_admin, onclick: async function () {
        err3.setAttribute('hidden', '');
        var lim = days.value.trim() === '' ? null : parseInt(days.value, 10);
        if (!name.value.trim()) return say(err3, 'Enter the role name.');
        if (lim !== null && (!isFinite(lim) || lim < 0)) return say(err3, 'Edit window must be a number of days, or empty for any age.');
        save.disabled = true;
        var u1 = await sb.from('roles').update({ name: name.value.trim(), show_cost: cost.cb.checked, can_manage_users: mgr.cb.checked, edit_days_limit: lim }).eq('id', role.id);
        if (u1.error) { save.disabled = false; return say(err3, u1.error.code === '23505' ? 'A role with this name already exists.' : 'Could not save: ' + u1.error.message); }
        var rows = features.map(function (f) {
          var b = boxes[f.feature];
          return { canteen_id: me.canteen_id, role_id: role.id, feature: f.feature, can_view: b.can_view.checked, can_add: b.can_add.checked, can_edit: b.can_edit.checked, can_delete: b.can_delete.checked };
        });
        var u2 = await sb.from('role_permissions').upsert(rows, { onConflict: 'role_id,feature' });
        save.disabled = false;
        if (u2.error) return say(err3, 'Could not save permissions: ' + u2.error.message);
        C.toast('Role saved.'); go('roles');
      } }, 'Save role');
      var del = role.is_admin ? null : h('button', { class: 'btn btn-block', type: 'button', onclick: async function () {
        if (!window.confirm('Delete the role "' + role.name + '"?')) return;
        var res = await sb.from('roles').delete().eq('id', role.id);
        if (res.error) return say(err3, /foreign key|violates/.test(res.error.message) ? 'People still have this role. Move them to another role first.' : 'Could not delete: ' + res.error.message);
        C.toast('Role deleted.'); go('roles');
      } }, 'Delete role');
      show(h('div', {}, C.header(role.name, function () { go('roles'); }),
        role.is_admin ? h('p', { class: 'hint' }, 'The admin role can do everything and cannot be changed.') : null,
        h('section', { class: 'sec' }, field('Role name', name, 'rname2'),
          h('div', { style: 'margin-top:14px' }, cost.node), h('div', { style: 'margin-top:6px' }, mgr.node),
          field('Can edit records up to this many days old', days, 'rdays'),
          h('p', { class: 'hint' }, 'Leave empty to allow editing records of any age.')),
        h('section', { class: 'sec' }, h('h2', {}, 'What this role can do'), grid, err3,
          h('div', { class: 'actions', style: 'margin-top:18px' }, save)),
        del ? h('section', { class: 'sec' }, del) : null));
    }
  };
})();
