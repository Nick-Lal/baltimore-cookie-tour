# Baltimore Chocolate Chip Cookie Tour: build plan

Version 2, 16 August 2026.

Version 1 went to an LLM council of four models before any code was written.
They scored it 42, 52, 56 and 70 out of 100, and the chairman's synthesis
landed at 64 with a queue of twenty required changes. That review is the reason
this document exists in a second version, and the changes it forced are listed
at the end. The council's sharpest finding was that the section titled "why the
database design is actually secure" was the weakest thing in the plan, which
was fair.

## What this is

A public website that plans a chocolate chip cookie crawl across Baltimore for
two people on a date, routes them between the stops on foot and by scooter, and
lets both of them score every cookie against the same rubric so they can argue
about the results afterwards with numbers.

Three things have to be genuinely good or it is not worth building: the routing
has to reflect how people actually cross Baltimore, the scoring has to be
rigorous enough that two people's numbers are comparable, and it has to work
one handed on a phone while holding a cookie.

## Constraints

- Hosted on GitHub Pages, so the site itself is static. No server we control.
- No paid API keys, and no service that requires an account we cannot create.
- Usable on a phone, outdoors, on cellular, with one hand free.
- The database has to be real: several people writing from several devices,
  with scores nobody else can alter.

## Architecture

**Static site, no build step.** Plain HTML, CSS and ES modules served straight
from the repo. A bundler would add a GitHub Action, a lockfile and a class of
failure that buys nothing at this size. Every file in the repo is the file the
browser receives.

**Maps: Leaflet 1.9.4, vendored into the repo** rather than pulled from a CDN,
so the site does not break when someone else's CDN does.

**Tiles: CARTO Voyager and Dark Matter.** Raster tiles cannot be vendored, so
there is a third party in the path here and the plan should not claim
otherwise. CARTO is used rather than OpenStreetMap's own tile server because
CARTO publishes light and dark basemaps, which lets the map follow the chosen
theme, and because OSM's tile usage policy asks that heavy or automated use go
elsewhere. Both were checked for permissive CORS from a browser origin. If
tiles fail to load the map still works: markers, routes and the whole stop list
render over an empty background.

**Routing: Valhalla, via the public OpenStreetMap instance.**

This was the decision that took the most checking. The obvious choice, OSRM's
demo server, turns out to alias every routing profile to driving: pedestrian,
bicycle and car requests to it return byte-identical results, which would have
produced a four minute walking time for a walk that takes twenty five. Valhalla
runs real separate profiles. Measured on a Mount Vernon to downtown leg it
returns 2.17 km and 25 minutes walking, 2.44 km and 9 minutes cycling, 2.56 km
and 5 minutes driving.

CORS was verified rather than assumed, because the plan's original measurements
could have been taken server-side and would have proved nothing about the
browser. A request carrying `Origin: https://nick-lal.github.io` returns
`access-control-allow-origin: *` from both Valhalla and CARTO, so the browser
path works.

A 14×14 travel matrix for both profiles is generated once at build time and
committed as `data/matrix.json`, about 5 KB. It gives the route optimiser an
exact input and every leg an instant estimate, so opening the site cold costs
the public routing service nothing at all. Live calls happen only for the final
ordered legs, where the drawn line on the map matters. Results are cached in
local storage and requests are spaced at least 260 ms apart, because the public
instance is a free community service and hammering it would be both rude and
fragile.

The bicycle profile stands in for a Lime scooter: same lanes, same one-way
streets, so the geometry is right. The time is not, so scooter legs take the
cycling time × 1.05, because scooters are capped around 24 km/h and lose a
little on open stretches, plus two minutes of overhead for finding and
unlocking one.

If routing fails there are two fallbacks, in order of honesty. The committed
matrix is real street-network data and only lacks a drawn line, so its numbers
are trustworthy and the map shows a straight connector. Great-circle distance
times a 1.22 to 1.30 urban detour factor is a genuine guess, and gets labelled
as an estimate rather than presented as measurement.

**Database: Supabase Postgres with row level security.**

The site also ships with a local adapter so it works with zero setup, but the
council was right that this cannot be the finish line: requirement seven asks
for a genuine shared database and "it might never get set up" is not an
acceptable risk to sign off. So the hosted database is a delivered artifact,
not an aspiration. `db/schema.sql` and `db/seed.sql` are committed and runnable,
`docs/supabase-setup.md` is a step-by-step runbook, and the site shows a
standing notice while it is running device-only rather than quietly implying
scores are syncing. The one step nobody else can do is creating the account.

### What the security actually guarantees

The anon key that ships in the page is public by design. It is not a secret and
nothing is protected by hiding it. Every visitor gets a real JWT through
anonymous sign-in, and row level security decides what that JWT may do. The
browser cannot bypass RLS, so the policies are the entire boundary.

- RLS is enabled on every table, and forced on `tasters` and `rating_events`.
  It is deliberately not forced on `parties` and `party_members`, because those
  are written only by `join_party()`, which is `SECURITY DEFINER` and therefore
  runs as the table owner; forcing RLS would subject the owner to policies that
  do not grant insert, and joining a party would fail outright. An earlier
  version of this document claimed RLS was forced on every table, which was
  simply false.
- Every insert policy carries `WITH CHECK (taster_id = auth.uid())`, so a score
  cannot be attributed to somebody else even by posting straight to the API.
- Scores are append-only. There is no UPDATE or DELETE grant on the ratings
  table for any role a browser can reach, so nobody can alter or erase a score,
  including their own.
- Totals are computed by a database trigger from a server-side weights table,
  so a client cannot submit a total that disagrees with its own factors.
- Every view is declared `security_invoker = true`. Without that a view runs as
  its owner and silently bypasses the policies underneath it.
- Ratings carry a foreign key to a generated reference table of stops and menu
  items, so a score cannot point at something that does not exist. Item keys are
  namespaced `stopId:itemId`, because ids like `cc-cookie` repeat across stops.
- Per-taster rate limits: sixty scores an hour, five hundred total, ten party
  join attempts an hour.

Party membership gets its own tables rather than a column on a public profile
row. The council caught that a party code stored on `tasters` would be readable
by anybody, because that table has to be world-readable to render names on a
leaderboard, and RLS is row-level rather than column-level. So only a SHA-256
hash is stored, joining goes through one audited `SECURITY DEFINER` function
that compares server-side, and codes are at least six characters.

### What it does not protect, stated plainly

**Everything is readable.** Scores, tasting notes and display names are
readable by anyone holding the key printed in the page, with no sign-in at all.
The party code filters which rows the site *shows* you. It is not access
control and was never implemented as any. Earlier drafts of this plan called
the party view "the trustworthy one" in a way that implied privacy; it does
not. Do not write anything in a note you would not put on a postcard, and the
scoring screen now says so next to the field.

**Identities are cheap.** Anonymous sign-in mints one on demand, so the
per-taster rate limits raise the cost of abuse without capping it. The only
throttle that genuinely binds is Supabase's per-IP limit on anonymous sign-ins,
set to 30 an hour.

CAPTCHA would bind much harder, and an earlier version of this plan called it a
mandatory setup step. That was wrong, and dangerously so: Supabase rejects a
sign-up carrying no `captcha_token`, and this client sends none, because doing
so requires rendering a Turnstile widget and taking a CDN dependency the rest
of the project deliberately avoids. Following that instruction would have made
every visitor fail to sign in and silently fall back to device-only storage.
The decision taken is to leave CAPTCHA off, rely on the per-IP limit, and say
what that does and does not buy. The fallback now names CAPTCHA explicitly as a
likely cause rather than failing quietly.

**Names are not verified**, so two people can pick the same one. That is a
naming collision, not a security hole.

All user-written text is rendered through `textContent`. There is no
`innerHTML` path for user data anywhere in the codebase, which is the reason
`assets/js/lib/dom.js` exists as a separate module.

## Features

### Stops and map

Fourteen geocoded stops in seven clusters, rendered from `data/stops.json`
rather than described in prose here, so this document cannot drift out of sync
with the data the way version 1 did. Each stop carries a confidence rating about
the chocolate chip cookie specifically: confirmed means it is on the shop's own
menu, likely means reviews name it but the daily list rotates, rotating means it
turns up some days.

A verification pass caught two bakeries that had closed since the research
started, Maillard Patisserie and Dulceology, both in May 2026. Both were
replaced and both are recorded in `closedSince`, with a test asserting no
closed business is also listed as a stop.

### Route planning

Pick stops, reorder them, get a leg by leg route. Walk and scooter are the only
modes ever suggested automatically: the brief asked for a mix of walking and
Lime scooters, so a car is something you ask for rather than something the site
picks for you. Legs over 5 km get an advisory suggesting the tour be split
rather than a silent switch to driving.

Every leg shows both viable modes with their own time and distance, so the
choice is presented rather than assumed. The itinerary takes a start time and a
dwell time, walks the schedule forward, and shows an arrival time for each stop
checked against that stop's actual opening hours, warning separately for "will
have shut" and "not open yet". "Sort for me" runs nearest-neighbour plus 2-opt
over the committed matrix, which at fourteen stops is instant and effectively
optimal, and makes no network calls.

Reordering uses tap targets rather than drag: HTML5 drag-and-drop does not fire
on touch in iOS Safari at all, and up/down buttons are the accessible path
anyway.

The selected route is encoded in the URL hash, so one person can send the other
the plan they just built. On a date with two phones that is the first thing
anyone tries.

### Scoring

Two rubrics, defined in `data/rubric.json`. Cookies get six weighted factors;
everything else gets four, because scoring a cortado on "salt balance" produces
a number that looks rigorous and means nothing. The two are ranked separately.
Every factor has written anchors describing what a 3, a 7 and a 9 mean, which
is what makes two people's numbers comparable rather than two people's moods.

Price stays out of the taste score and is reported separately as points per
dollar, computed from what you actually paid. The rubric states plainly that
this measure favours cheap cookies by construction, with the arithmetic, so it
is used to answer "what should I buy on a budget" and not "which is best".

Recipe score is the total with freshness dropped and the remaining weights
renormalised, for comparing bakeries visited at different hours.

Rankings use a shrunk mean, pulling each item toward the overall mean in
proportion to how little data it has, with a prior weight of 1.5 tuned for the
two-person case. A raw average would let one enthusiastic 9 outrank ten honest
8.6s.

Nothing here is an empirical finding. The weights are considered judgements and
the rubric says so.

### Results

Rankings with sample sizes, per-factor breakdowns, the biggest disagreements
between tasters, and a running average per item over time. Because scores are
append-only, re-scoring a cookie extends that line rather than erasing it.

### Themes

Ten complete themes, switchable live and persisted. Each sets the full token
surface (colour, radius scale, shadow, type family, letterspacing) so
switching reads as a different designer's work rather than a hue rotation. The
map basemap follows the theme's light or dark scheme.

Theme-variable tokens are colour, radius, shadow and type family. Fixed by the
HIG baseline and not themeable: the type scale, the 44pt touch minimum, spacing,
and motion timing.

## Interface direction

Apple's Human Interface Guidelines, applied as measurements rather than as a
coat of paint. The full working notes are in `.claude/skills/apple-hig/SKILL.md`.

Concretely: 17px body text, minimum 44×44pt touch targets, a system font stack
that resolves to SF on Apple hardware, nested rather than uniform corner radii,
translucent materials with an opaque fallback, `cubic-bezier(0.32, 0.72, 0, 1)`
motion at 200 to 400 ms, and safe-area insets so nothing hides under the home
indicator.

On phones the stop list is a bottom sheet with three detents, dragged by its
grip using Pointer Events, snapping to the nearest detent with velocity taken
into account. It is deliberately not a focus trap: the map stays live behind it,
so trapping focus would be wrong. Escape collapses it and the grip is a real
keyboard-operable slider. Sizing uses `dvh` with `svh` fallback so mobile
browser chrome does not crop it.

## Accessibility bar

Not a nice-to-have, and version 1 was right to be criticised for mentioning it
once in passing.

- WCAG 2.2 AA contrast across all ten themes, checked automatically by
  `tests/contrast.mjs`: 110 pairs, and it fails the build if any drop below
  target. It caught 33 genuine failures on first run, largely because Apple's
  own grey ramp does not meet AA at footnote sizes.
- Visible focus rings via `:focus-visible`, so they appear for keyboard users
  and not on mouse clicks.
- Every map marker carries an accessible name, and the stop list carries the
  same information as the map for anyone not using it.
- Real `<label>` elements, `aria-label` on icon-only buttons, live regions for
  changes that happen without a page load.
- `prefers-reduced-motion` removes movement while keeping feedback.
- Arrow-key navigation between tabs.

## Testing

`node tests/run.mjs` covers the logic that is easy to get quietly wrong: 37
assertions over opening hours, mode suggestion, the optimiser, scoring
arithmetic, validation, and the integrity of the stop data and travel matrix.

It has already earned its place. It caught a real bug in the opening-hours
check: Insomnia closes at 3am, and the original code only looked at the current
day's window, so at 2am on a Tuesday it reported the shop shut while you were
standing in it. The fix checks the previous day's window too when that window
runs past midnight.

`node tests/contrast.mjs` covers the themes.

## What the council forced

The twenty must-fix items, and what happened to each.

Done: mode suggestion restricted to walk and scooter; CORS verified from a
browser origin and recorded; committed travel matrix so the optimiser and cold
start make no network calls; append-only event storage with a derived current
view, so rankings over time survive re-scoring; RLS enabled and forced
everywhere with insert-attribution bound to `auth.uid()`; `security_invoker` on
every view; foreign key to a generated stop/item reference table with namespaced
keys; per-taster rate limits; party codes moved to hashed storage behind an
audited join function; CAPTCHA documented as a required step with the residual
sybil risk stated honestly; real prices and a price-band legend added, with the
value index computed from price actually paid and its cheap-cookie bias spelled
out; separate rubric for non-cookie items; shrunk-mean ranking with sample
sizes; hours filled for every stop with the day-index convention documented and
the midnight-wrap case tested; two closed businesses found and replaced; Pointer
Events reordering with tap fallback; start time, dwell time and arrival-time
warnings; URL-hash sharing; accessibility bar with automated contrast checking;
a test suite; storage keys namespaced and the route cache versioned and capped;
`.nojekyll` and relative paths; a setup runbook; persistent-storage request and
JSON export/import.

Deferred, and worth being straight about rather than quietly dropping: live
Realtime sync between phones (the app re-reads on tab change, which is enough
for two people on a date); email magic-link identity upgrade, so an anonymous
identity is still tied to one browser until the user exports; and locate-me on
the map. Each is a genuine gap rather than a disagreement with the council.

Rejected with reasons: a focus trap on the bottom sheet, because it is not a
modal and the map stays interactive behind it; and the claim that OSM tiles
require a custom User-Agent, which browser JavaScript cannot set at all.

## Gate 2: the council reviews the shipped site

The deployed site went back to the same four models, this time instructed to
verify each other's claimed defects so hallucinated bugs would be caught rather
than actioned. Scores: 84, 79, 78, 62. None of them called the core features
excellent, and they were right not to.

The peer-review stage earned its keep twice over. It rejected a cluster of
false claims (three members asserted that two element ids did not exist and the
code referencing them was dead; both ids are present and the code runs), and it
surfaced two serious mobile bugs that every first-round reviewer had missed.

**The tab bar rendered at the top of the screen.** It was `position: sticky;
bottom: 0`, which does nothing when the element is the first child of a column
flex container. An iOS-style tab bar at the top of the viewport is not a detail.
Fixed by moving it to the last child, with `order: -1` on desktop where the
shell becomes a row.

**Most of the stop list was unreachable on a phone.** The sheet was `100dvh`
tall and translated downward, so its scroll container ran to y=1250 inside an
812px viewport. Everything below the fold existed in the layout and could not
be reached. The sheet is now sized to its detent and anchored above the tab bar,
so the visible box is the box.

Both were live on the deployed site while I was measuring other things about it,
which is the lesson: I had checked that tap targets were 44px without ever
checking where the bar containing them was.

The rest of the confirmed queue: reorder buttons at 38px, filters claiming
`role="tablist"` while controlling no tabpanel, a theme picker that was ten
sequential tab stops, cloud export built from a view with no factor columns,
import that validated nothing, local taster names going stale after a rename,
and four Postgres grant and RLS mistakes where the SQL did not do what its own
comment claimed. Column-level `REVOKE` does not narrow a table-level `GRANT`;
`EXECUTE` is granted to `PUBLIC` by default; `FORCE ROW LEVEL SECURITY` on a
table written only by a `SECURITY DEFINER` function makes that function fail;
and a cascade from `tasters` would have let anyone delete their own scores.

Several distance claims in the copy were also wrong, and were corrected against
`data/matrix.json` rather than against memory. Ovenbird Little Italy to Kneads
is 300 metres, not 700.

Requirement 7 remains the one genuine hole, and every member said so: the
deployed site ships without `config/supabase.json`, so it runs on device-only
storage. The schema, the seed, the runbook and the adapter are all written and
committed. What is missing is a Supabase account, which is not mine to create.
Two people can still score properly on one shared phone, which was added in
response to this round.

