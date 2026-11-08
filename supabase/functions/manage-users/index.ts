// Edge Function: manage-users
// Creates staff logins and resets passwords. These need the service role, so they cannot run in the browser.
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function -> name it "manage-users" -> paste this file.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided to the function automatically.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const LOGIN_DOMAIN = 'canteen.local';

function reply(status: any, body: any) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export async function handle(req: any, env: any) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const auth = req.headers.get('Authorization') || '';
  if (!auth) return reply(401, { error: 'Not signed in.' });

  // The caller, acting with their own login: used only to check who they are.
  const asCaller = env.createClient(env.url, env.anon, { global: { headers: { Authorization: auth } } });
  const canManage = await asCaller.rpc('can_manage_users');
  if (canManage.error || canManage.data !== true) return reply(403, { error: 'Only an admin or user manager can do this.' });
  const isAdmin = (await asCaller.rpc('is_admin')).data === true;
  const canteen = (await asCaller.rpc('current_canteen_id')).data;
  if (!canteen) return reply(403, { error: 'No canteen found for your login.' });

  let body: any;
  try { body = await req.json(); } catch (_e) { return reply(400, { error: 'Send JSON.' }); }

  // Privileged client: the only place the service role is used.
  const admin = env.createClient(env.url, env.service, { auth: { persistSession: false } });

  async function roleOk(roleId: any) {
    const r = await admin.from('roles').select('id,is_admin').eq('id', roleId).eq('canteen_id', canteen).maybeSingle();
    if (!r.data) return 'That role does not exist.';
    if (r.data.is_admin && !isAdmin) return 'Only an admin can give the admin role.';
    return '';
  }

  if (body.action === 'create') {
    const username = String(body.username || '').trim().toLowerCase();
    const fullName = String(body.full_name || '').trim();
    const password = String(body.password || '');
    if (!/^[a-z0-9._-]+$/.test(username)) return reply(400, { error: 'Username can use letters, numbers, dot, dash and underscore only.' });
    if (!fullName) return reply(400, { error: 'Enter the full name.' });
    if (password.length < 8) return reply(400, { error: 'Password must be at least 8 characters.' });
    const bad = await roleOk(body.role_id);
    if (bad) return reply(400, { error: bad });
    const dup = await admin.from('users').select('id').eq('canteen_id', canteen).eq('username', username).maybeSingle();
    if (dup.data) return reply(400, { error: 'That username is already taken.' });

    const created = await admin.auth.admin.createUser({ email: username + '@' + LOGIN_DOMAIN, password, email_confirm: true });
    if (created.error) return reply(400, { error: 'Could not create the login: ' + created.error.message });
    const ins = await admin.from('users').insert({
      id: created.data.user.id, canteen_id: canteen, role_id: body.role_id, username, full_name: fullName,
    });
    if (ins.error) {
      await admin.auth.admin.deleteUser(created.data.user.id);   // never leave a login without a profile
      return reply(400, { error: 'Could not save the user: ' + ins.error.message });
    }
    return reply(200, { ok: true, id: created.data.user.id });
  }

  if (body.action === 'reset_password') {
    const password = String(body.password || '');
    if (password.length < 8) return reply(400, { error: 'Password must be at least 8 characters.' });
    const t = await admin.from('users').select('id,role_id').eq('id', body.user_id).eq('canteen_id', canteen).maybeSingle();
    if (!t.data) return reply(404, { error: 'User not found.' });
    const isTargetAdmin = (await admin.from('roles').select('is_admin').eq('id', t.data.role_id).maybeSingle()).data?.is_admin === true;
    if (isTargetAdmin && !isAdmin) return reply(403, { error: 'Only an admin can change an admin’s password.' });
    const up = await admin.auth.admin.updateUserById(body.user_id, { password });
    if (up.error) return reply(400, { error: 'Could not change the password: ' + up.error.message });
    await admin.from('users').update({ force_logout_at: new Date().toISOString() }).eq('id', body.user_id);   // end old sessions
    return reply(200, { ok: true });
  }

  return reply(400, { error: 'Unknown action.' });
}

Deno.serve((req: any) => handle(req, {
  createClient,
  url: Deno.env.get('SUPABASE_URL'),
  anon: Deno.env.get('SUPABASE_ANON_KEY'),
  service: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
}));
