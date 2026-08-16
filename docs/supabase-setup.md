# Connecting the shared database

The site works out of the box with scores saved on your phone. That is enough
for one person. For two people comparing scores on two phones, you need the
shared database, and this is how you set it up. It takes about ten minutes and
costs nothing on the free tier.

You have to do the account creation yourself. Nobody should be making accounts
on your behalf, and the free tier needs a card-free signup you complete in your
own browser.

## 1. Make a project

Go to [supabase.com](https://supabase.com), create an account, and create a new
project. Pick a region near you; `East US` is the obvious one for Baltimore.
Wait for it to finish provisioning, which takes a minute or two.

## 2. Run the schema

Open the SQL editor in the dashboard sidebar. Paste in the whole of
`db/schema.sql` and run it. Then paste in the whole of `db/seed.sql` and run
that.

`schema.sql` creates the tables, the row level security policies, the scoring
trigger and the party functions. `seed.sql` fills in the reference table of
stops and menu items. If you ever edit `data/stops.json`, regenerate the seed
and run it again:

```bash
node tools/build-seed.mjs
```

You should see no errors. If you get one about `pgcrypto`, run
`create extension if not exists pgcrypto with schema extensions;` on its own
first, then rerun the file.

Then run `db/verify.sql`. It checks that row level security is actually on,
that no view is quietly bypassing it, that nobody can update or delete a score,
and that the constraints reject an out-of-range score, a score pointing at a
menu item that does not exist, and a cortado scored on "salt balance". Every
line it prints should say PASS. It writes nothing.

## 3. Turn on anonymous sign-ins

Authentication, then Sign In / Providers. Switch on **Enable anonymous
sign-ins**.

This is what lets someone put in a name and start scoring without inventing a
password halfway through a date. Every visitor still gets a real, unique
identity that the security policies key off.

## 4. Do not turn on CAPTCHA

An earlier version of this guide called CAPTCHA mandatory. That was wrong, and
following it would have broken the site: Supabase rejects a sign-up that
carries no `captcha_token`, and this client does not send one, because that
needs a Cloudflare Turnstile widget rendered on the page. Switch CAPTCHA on for
anonymous sign-ins and every visitor silently drops back to device-only
storage.

What to do instead: Authentication, then Rate Limits, and check **Rate limit
for anonymous users**. The default of 30 an hour per IP is the right order of
magnitude and is the throttle that actually binds here.

The residual risk, stated honestly: minting an anonymous identity is cheap, so
the per-taster limits in the schema raise the cost of abuse rather than
capping it. For a cookie tour shared between two people that is proportionate.
If this ever needed to be abuse-resistant, the fix is a Turnstile widget in the
client, not a checkbox in the dashboard.

## 5. Point the site at it

Settings, then API Keys. Copy the **Project URL** and the **publishable** key,
the one starting `sb_publishable_`. On older projects this is the key labelled
**anon public** instead; either works, and the config field is called `anonKey`
for both.

Send me those two values and I will do the rest. Or do it yourself: copy
`config/supabase.example.json` to `config/supabase.json` and fill them in:

```json
{
  "url": "https://abcdefgh.supabase.co",
  "anonKey": "eyJhbGciOi..."
}
```

**Commit that file.** GitHub Pages serves what is in the repository, so if it
is ignored the deployed site never sees it and silently stays on device-only
storage. The anon key is public by design, it appears in the page source either
way, and it grants nothing on its own. What protects your data is
the row level security policies, not the secrecy of that key. The one key you
must never put in this file, or anywhere in the repo, is the **service role**
key, which bypasses every policy.

Reload the site. Setup should now say "Synced database" instead of "This device
only".

## 5b. Set the URLs, or magic links will not come back

Authentication, then URL Configuration.

- **Site URL**: `https://nick-lal.github.io/baltimore-cookie-tour/`
- **Redirect URLs**: add `https://nick-lal.github.io/baltimore-cookie-tour/**`

Without these, the "Keep your scores" email link lands on localhost and the
sign-in silently fails. Both are already set on the live project.

## 6. Check it actually works

Worth doing properly rather than assuming:

1. Open the site on your phone, put in a name and a party code, score a cookie.
2. Open it on a different device, put in a different name and **the same party
   code**, score the same cookie differently.
3. On either device, go to Results and switch the filter to "My party". Both
   scores should be there, and the disagreement should show up.

If the second device sees nothing, the party codes do not match. They are
case-insensitive but otherwise exact.

## What the security actually guarantees

Worth being straight about, because "secure database" gets said a lot and
means very little on its own.

Nobody can write a score attributed to someone else. The insert policy checks
that the author matches the signed-in identity, in the database, so it fails
even if somebody bypasses the site entirely and posts to the API directly.

Nobody can edit or delete anybody's scores, including their own. Scores are
append-only: there is no update or delete permission on the table for any role
reachable from a browser. Changing your mind adds a new score and leaves the
old one in the history, which is what makes the movement chart honest.

Nobody can submit a total that disagrees with its own factor scores. Totals are
computed by a database trigger from a server-side weights table, so the number
the client sends is ignored.

Party codes cannot be read back. Only a hash is stored, the hash is not granted
to any client, and joining goes through one function that compares server-side.
Guessing is also not observable: `created_by` and `created_at` are withheld too,
so a guesser cannot tell "I joined a real party" from "I made a new one". There
is a limit of ten *new* join attempts an hour per person; re-joining a party you
are already in is free, so saving your settings twice does not lock you out.

What it does not guarantee, and this matters more than the rest: **nothing here
is private**. Every score, note and display name is readable by anyone with the
key that ships in the page, no sign-in required. The party code filters what the
site shows you; it does not restrict what the database will hand out. Treat
notes as public writing.

Display names are not verified either, so two people can pick the same one. And
a leaderboard with free anonymous identities cannot be made proof against
someone determined to stuff it. If that ever happens, you own the database:
delete the rows in the Supabase table editor.

## Turning it off again

Delete `config/supabase.json`. The site falls back to device-only storage on
the next load. Scores already in Postgres stay there, and scores saved locally
after that stay local. Nothing merges automatically, so export before you
switch if you care about the ones on your phone.
