# Working agreement

## Tests are ON HOLD

**Do not run the regression suite.** Every file matching `scripts/test_*` is on
hold as of 2026-07-28. They pass, they take ~20 minutes, and running them after
every change costs far more time than it has ever saved.

The rule:

- **Never** run all of `scripts/test_*` — not "to be safe", not "one last
  check", not before a commit or a push.
- Verify **only the specific change just made**, and only when the change has a
  behaviour that can actually be observed. A one-line copy edit needs no test.
- A new check written for the current change is fine to run while building it.
  Once that work ships, the check joins the hold list and is not run again.
- Regression coverage is deliberately deferred. Breaking an old route or an old
  assertion is an accepted cost right now; it is not a reason to run the suite.
- If a held test looks genuinely relevant to a bug under investigation, say so
  and ask before running it. Do not run it unilaterally.

Taking the hold off is the user's call, and only the user's.

### Held (33 files)

```
scripts/test_basemap_coastline.py        scripts/test_road_geometry.py
scripts/test_bikeroute_bounds.py         scripts/test_road_info.mjs
scripts/test_caution_help.mjs            scripts/test_route_connector.mjs
scripts/test_compressed_overlays.mjs     scripts/test_route_crossings.mjs
scripts/test_desktop_controls.mjs        scripts/test_route_detail_actions.mjs
scripts/test_directional_graph_data.mjs  scripts/test_route_portfolio.mjs
scripts/test_directional_road_tiles.py   scripts/test_router_startup_readiness.mjs
scripts/test_directional_wsdot.py        scripts/test_safety_model.mjs
scripts/test_endpoint_selection.mjs      scripts/test_service_worker_updates.mjs
scripts/test_grade_reporting.mjs         scripts/test_sharrow_not_space.mjs
scripts/test_graph_format10.py           scripts/test_steep_grade_avoidance.mjs
scripts/test_help_content.mjs            scripts/test_surface_graph_data.mjs
scripts/test_native_shell.mjs            scripts/test_surface_preference.mjs
scripts/test_navigation_guidance.mjs     scripts/test_tile_retry.mjs
scripts/test_road_blocks.mjs             scripts/test_turn_preference.mjs
scripts/test_urban_sidewalk_rules.mjs    scripts/test_weights_editor_cost.mjs
scripts/test_wide_road_rule.mjs
```

`test_native_shell.mjs` additionally cannot pass in the cloud container at all;
it needs `npm run ios:prepare-shell` and `cap sync ios` on a Mac.

## Before the first commit of a session

The container's disk has twice rolled back to an older commit while `origin`
kept the real history, so committing from a stale tree would silently delete
work. Check first, every session:

```
git fetch origin claude/help-2zed4z
git log --oneline HEAD..origin/claude/help-2zed4z     # must be empty
```

If it is not empty, `git reset --hard origin/claude/help-2zed4z` before doing
anything else.

## Other standing rules

- Keep replies short. Surface decisions instead of burying them; do not make
  design choices silently.
- The user does the field testing on a phone. Do not simulate rides or run long
  routing comparisons to prove a change is safe.
- All mechanics of the safety model belong in `docs/SAFETY-MODEL.md` — the
  specification, not a summary of the code.
- Bump `APP_VERSION` in `app.js` and `version.json` together; bump `VERSION` in
  `sw.js` when the app shell changes.
