# Onboarding tour screenshots

These JPEGs are the pictures inside the in-app tour (Help > Getting started >
"Take the app tour"). They are CURATED captures of the real app — staged with
a computed route, a location fix, and turn navigation running — because the
tour must look right for a rider who has none of those yet.

They are generated, not hand-edited: `node scripts/shoot_onboarding.mjs`
serves the working tree, stages each scene in headless Chromium at phone size
(430pt, 2x), and overwrites the files here with the exact crops the tour
shows. Reshoot whenever the UI they depict changes materially, and eyeball
each image afterwards — the script cannot tell a good composition from a bad
one.

The step copy, order, and alt text live in `ONBOARDING_STEPS` in `app.js`.
The service worker precaches these files by name (`SHELL` in `sw.js`); adding
or renaming a scene means updating both.
