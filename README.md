# daily-camp-schedular
Helps camp automatically make their daily schedules

## Supabase configuration (optional)

To keep your Supabase URL and anon key out of the repo (e.g. for production or different environments):

1. Copy `config.example.js` to `config.js`.
2. Set `url` and `anonKey` in `config.js` to your Supabase project values.
3. `config.js` is gitignored and will not be committed.

If `config.js` is not present, the app uses built-in fallback values. **Security:** All real access control must be enforced with Supabase Row Level Security (RLS); the anon key is public in the browser.
