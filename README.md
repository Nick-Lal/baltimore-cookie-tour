# Baltimore Chocolate Chip Cookie Tour

A cookie crawl planner for Baltimore. Pick stops, get routed between them on
foot and by scooter, and score every cookie against the same rubric so two
people can argue about the results with numbers.

Static site. No build step. Open `index.html` through any web server.

    python -m http.server 8080

Then visit http://localhost:8080.

## What is here

    data/stops.json      14 researched stops, geocoded, with hours and menus
    data/rubric.json     the scoring rubrics and how ranking works
    data/matrix.json     precomputed 14x14 travel matrix, both modes
    db/schema.sql        Postgres schema and row level security policies
    db/seed.sql          generated reference data (node tools/build-seed.mjs)
    docs/research/       where the stop list came from
    docs/supabase-setup.md  connecting the shared database

## Storage

The site works immediately with scores saved on the device. To sync scores
between phones, follow `docs/supabase-setup.md` and drop a
`config/supabase.json` in place. Nothing else changes.
