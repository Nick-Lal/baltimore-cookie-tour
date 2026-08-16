# Tickets

How the work was actually broken up, and what the council said at each gate.

The process the brief asked for: write a plan, have the council review it, break
the plan into tickets, review the output of each ticket, and update the plan as
things land. That is what happened. This file is the record.

## The gates

**Gate 1, the plan.** Four models reviewed `PLAN.md` v1 independently, then
peer-reviewed each other anonymously, then a chairman synthesised. Scores were
70, 56, 52 and 42. Final: **64 out of 100**, with 20 must-fix items. Nobody
passed it. The full ruling is summarised at the bottom of `PLAN.md`.

**Gate 2, the shipped site.** Same protocol against the deployed artifact and
the source, with members instructed to verify each other's claimed defects so
hallucinated bugs get caught rather than actioned. Scores: 84, 79, 78, 62.
Nobody called the core features excellent.

The verification instruction paid for itself. Three members independently
claimed two element ids did not exist and that the code using them was dead;
the peer stage checked, found both ids present and the code running, and threw
the claim out. It also surfaced two mobile bugs nobody caught first time round:
the tab bar was rendering at the top of the screen, and most of the stop list
sat below the fold in a container taller than the viewport. Both were live.
Both are fixed and verified on the deployed site.

## Tickets

| ID | Title | State | Notes |
|---|---|---|---|
| T-01 | Research and data model | Done | 14 stops geocoded via Nominatim. A verification pass caught two bakeries that had closed since research began. |
| T-02 | Apple HIG skill and design tokens | Done | Written up as a reusable skill in `.claude/skills/apple-hig/`. |
| T-03 | Site shell, theme library, navigation | Done | 10 themes. Automated contrast checking found 33 AA failures and now passes 110 checks. |
| T-04 | Map and stop cards | Done | Leaflet vendored, CARTO tiles following the theme's light or dark scheme. |
| T-05 | Routing engine and itinerary | Done | Valhalla, walk and scooter only, committed travel matrix, arrival times against opening hours. |
| T-06 | Storage adapters and Supabase schema | Done | Append-only events, RLS forced, hashed party codes, server-computed totals. |
| T-06b | Supabase runbook | Done | `docs/supabase-setup.md`. Added because the council refused to accept "the database might never get set up" as a risk. |
| T-07 | Scoring interface | Done | Two rubrics, anchored sliders, live running total. |
| T-08 | Results, rankings and history | Done | Shrunk-mean ranking, factor breakdowns, disagreements, movement over time. |
| T-09 | Copy pass | Done | Broke the site briefly. See below. |
| T-10 | Deploy and final review | Done | Live at nick-lal.github.io/baltimore-cookie-tour. |
| T-11 | Device QA and tap targets | Done | Added after the plan review. Every control measured at 375px; Leaflet's 30px zoom buttons and the 36px segmented control raised to 44. |
| T-12 | Live database | Done | Schema, seed and anonymous sign-in on a real Supabase project. 23 attacks run against it with the public key; all rejected. |
| T-13 | Security council | Done | Third council gate, against the live database. Caught a setup instruction that would have broken the site, and a verify script that could not run. |
| T-14 | Offline and Add to Home Screen | Done | Manifest, generated icons, service worker. Verified by stopping the server and cold-reloading. |
| T-15 | iOS hardening | Done | svh sizing, tap highlight, overscroll, 16px input floor. Checked at 320, 375 and 430 wide; the filter control overflowed at 320. |
| T-16 | Near-live sync and agreement analysis | Done | Results refresh while visible; per-factor inter-rater gaps from paired scores. |
| T-17 | Email identity upgrade | Done | Links an email to the same auth.uid() so scores survive storage eviction. |

## What went wrong, and what it changed

Worth recording, because both of these produced permanent changes to the setup
rather than one-off fixes.

**The copy pass took the site down.** T-09 replaced curly apostrophes with
straight ones across every shipped file. Two of those apostrophes were inside
single-quoted JavaScript strings, so `'two people's numbers'` became a syntax
error and every module importing it failed. The site was broken in production
for a few minutes.

Nothing in the test suite could have caught it: the unit tests import the
library modules, but the view modules need a DOM and so were never parsed by
anything before a browser tried to run them. The fix was `tests/syntax.mjs`,
which parses every module and JSON file and checks that every
`getElementById` target actually exists in the markup. It runs in under a
second and would have caught this instantly.

**The opening-hours check had a real bug.** Insomnia Cookies closes at 3am. The
original code only looked at the current day's window, so at 2am on a Tuesday
it reported the shop as shut while you were standing in it. A test written
before the fix caught it. `openAt` now also checks the previous day's window
when that window runs past midnight.

## Running the checks

```bash
node tests/all.mjs
```

Runs three suites: parse every module and data file, 37 unit assertions over
hours, routing, the optimiser and the scoring maths, and 110 contrast checks
across the ten themes.

Before pushing:

```bash
node tools/stamp-version.mjs
```

Stamps a content hash onto the asset URLs so a returning visitor cannot end up
with a cached copy of one module and a fresh copy of another.

If `data/stops.json` changes, regenerate the database reference data:

```bash
node tools/build-seed.mjs
```
