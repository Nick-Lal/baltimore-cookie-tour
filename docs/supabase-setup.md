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

## 3. Turn on anonymous sign-ins

Authentication, then Sign In / Providers. Switch on **Enable anonymous
sign-ins**.

This is what lets someone put in a name and start scoring without inventing a
password halfway through a date. Every visitor still gets a real, unique
identity that the security policies key off.

## 4. Turn on CAPTCHA

Authentication, then Attack Protection. Switch on CAPTCHA protection, choose
Cloudflare Turnstile, and follow the prompt to get a site key.

**Do not skip this one.** Anonymous sign-in with no CAPTCHA is an unlimited
identity factory: anyone who views the page source gets the public key, and a
short script could mint thousands of identities and fill the global
leaderboard with nonsense. CAPTCHA does not make that impossible, but it makes
it expensive enough that nobody bothers.

While you are on that screen, set a sensible rate limit for sign-ups per hour.
Thirty is plenty.

## 5. Point the site at it

Settings, then API. Copy the **Project URL** and the **anon public** key.

Copy `config/supabase.example.json` to `config/supabase.json` and fill them in:

```json
{
  "url": "https://abcdefgh.supabase.co",
  "anonKey": "eyJhbGciOi..."
}
```

Commit it if you like. The anon key is public by design, it appears in the page
source either way, and it grants nothing on its own. What protects your data is
the row level security policies, not the secrecy of that key. The one key you
must never put in this file, or anywhere in the repo, is the **service role**
key, which bypasses every policy.

Reload the site. Setup should now say "Synced database" instead of "This device
only".

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

Party codes cannot be read out or enumerated. Only a hash is stored, joining
goes through a single function that compares server-side, and there is a limit
of ten join attempts an hour per person.

What it does not guarantee: display names are not verified, so two people can
pick the same one. And a public leaderboard with anonymous sign-in can never be
completely proof against someone determined to stuff it. That is why the party
filter exists and why it is the default view. Within a party, membership is
gated by a code, and the numbers are trustworthy.

## Turning it off again

Delete `config/supabase.json`. The site falls back to device-only storage on
the next load. Scores already in Postgres stay there, and scores saved locally
after that stay local. Nothing merges automatically, so export before you
switch if you care about the ones on your phone.
