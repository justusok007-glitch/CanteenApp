// Fill in the two values from Supabase: Project Settings -> API.
// Only the PUBLIC "anon" key goes here. NEVER put the service_role key in this file.
window.CANTEEN_CONFIG = {
  supabaseUrl: 'YOUR_PROJECT_URL',        // e.g. https://abcdxyz.supabase.co
  supabaseAnonKey: 'YOUR_ANON_PUBLIC_KEY',
  loginDomain: 'canteen.local'            // typing "ali" logs in as ali@canteen.local
};
