# Dualarr: handoff notes

A standalone companion to Sonarr for anime. It keeps every file in Japanese audio with subtitles, and swaps subbed-only releases for dual audio when the dub comes out. It was split out of Courarr (`github.com/jpjoseph12/courarr`) because the job is different: Courarr decides what gets added to Sonarr, Dualarr checks the quality of what's already on disk. **Copy Courarr's conventions and code style**: Node 24 ESM with no build step, Express 5, `node:sqlite`, `node --test` with local mock servers, and a plain `public/app.js` UI with dark CSS tokens. Comments should be short and explain *why*.

## Done (in `server/`)

- `config.js`: CONFIG_DIR (default `/config`), PORT (default **6162**; Courarr uses 6161), TZ, VERSION, `log`.
- `db.js`: tables `settings`, `series` (latest scan per Sonarr series as JSON, plus `searched_at`), `sessions` and `runs` (activity log). Includes `SETTING_DEFAULTS`: Sonarr URL/key, `scope` ('anime' | 'japanese'), `requireSubtitles`, `subtitleLanguage` ('any' | 'en' | …), `dualScore` (2000), `profileIds`, `schedule` ('0 4 * * *'), `autoSearch`, `searchPerRun` (10), `searchAgainDays` (7), notifiers, `notifyUpgrades`, `notifyProblems`, auth fields and `apiKey`.
- `auth.js`: copied from Courarr (scrypt login, cookie sessions `dualarr_session`, API key, login rate limit). The feed key was removed, and the reset env var is `DUALARR_RESET_AUTH`.
- `sonarr.js`: the v4 API client (series, seriesById, episodeFiles, episodes, seriesHistory, markFailed, deleteEpisodeFile, command, customFormats/saveCustomFormat, qualityProfiles/qualityProfile/saveQualityProfile). Empty response bodies return null.
- `rules.js`: **pure logic, no I/O**:
  - `langs()` normalises `mediaInfo.audioLanguages` / `subtitles` ("jpn/eng" from v4, "Japanese / English" from v3) to codes.
  - `classifyFile()` gives each file a verdict: `dual | subbed | noSubs | noJapanese | unknown`. It treats a "HardSub" release name as subtitled.
  - `inScope`, `summariseSeries`, `seriesState` (done/waiting/problem/unknown/empty), `totals`, `diffScans` (upgraded series and new problems since the last scan; series seen for the first time are skipped).
  - `searchPlan()`: SeasonSearch when a whole season needs work, otherwise EpisodeSearch for the monitored episodes.
  - `grabFor()`: finds the history "grabbed" record behind a file, via the import record's `importedPath` or the release name, so Replace can blocklist it.
  - Custom formats: `CF_NAMES`, `DUAL_RE`, `DUB_RE`, `customFormats()`. `profileWithScores()` sets dual = dualScore and dub = -10000, turns upgrades on, sets `cutoffFormatScore` ≥ dualScore and ≥ the top other format score + 1, and raises the minimum score just enough that dub-only releases can't be grabbed. `profileState()` reports readiness and problems per profile.
- `notify.js`: adapted from Courarr. Events are `upgraded`, `problems`, `error` and `test`.
- `jobs.js`: a serialised job runner, and every job is recorded in `runs`:
  - `scanJob(trigger, { autoSearch })`: scan, notify, then (on the schedule) `dueForSearch()`, which searches least-recently-searched first and is capped by `searchPerRun` and `searchAgainDays`.
  - `searchJob(ids)`: manual search.
  - `replaceJob(seriesId, fileIds)`: only for `noSubs`/`noJapanese` files. It marks the grab failed (blocklisting it), deletes the file, sends an EpisodeSearch and rescans the series.
  - `setupJob()`: creates or updates the custom formats and applies scores to `settings.profileIds`.
  - `setupState()`: formats, plus each profile's state and how many in-scope series use it.
  - `currentJob()`.

## To do

1. **`server/scheduler.js`**: copy Courarr's. On the cron schedule, call `scanJob('schedule', { autoSearch: true })`.
2. **`server/app.js`**: base it on Courarr's `server/app.js`. Keep: the BUILD header and stale-page reload, the auth middleware (the `X-Dualarr: 1` header is required for session writes, replacing `X-Courarr`), `/api/health`, `/api/auth/*` (status, setup, login, logout, account, `keys/api`), `/api/status` (version, tz, schedule, nextRun, `running: currentJob()`, lastRun), settings GET/PUT (mask the Sonarr key, validate every field), `/api/settings/test` (Sonarr only), notifier sanitising and `/api/notify/test`, and `/api/runs`. Add:
   - `GET /api/library` → `{ series: store.listSeries() (each with state = rules.seriesState), totals, sonarrUrl }`
   - `POST /api/scan` → start `scanJob('scan')` without awaiting it, respond 202. The UI polls `/api/status`.
   - `POST /api/search` `{ ids?: number[] }` → `searchJob(ids ?? every series that needsSearch)`
   - `POST /api/series/:id/replace` `{ fileIds }` → `replaceJob`
   - `GET /api/setup` → `setupState`; `POST /api/setup` `{ profileIds, dualScore }` → save the settings, then `setupJob`, then return `setupState`
3. **`server/index.js`**: copy Courarr's (reset-auth env var, `ensureKeys`, listen, schedule).
4. **`public/`**: `index.html`, `app.js` and a logo/icon (`app.css` is already copied from Courarr; trim what isn't used). The logo could be two overlapping speech bubbles or sound waves in the accent colour, with a matching `tools/make-icon.mjs` for `icon.png`. Pages:
   - **Library** (`#/`): summary tiles (series done / waiting for dub / problems, file counts by verdict); filter tabs (All, Waiting for dub, Problems, Done, Unknown); a series table with poster, title, count badges, last scanned/searched and a Search button. Expanding a row shows its non-dual files (path, audio langs, subtitle langs, verdict) with a Replace button on `noSubs`/`noJapanese` files (confirm first; it deletes the file). Header buttons: Scan now and "Search all that need it" (confirm with a count). Link each series to `${sonarrUrl}/series/${titleSlug}`. Show a hint when many files are `unknown` (Sonarr → Settings → Media Management → "Analyse video files" must be on).
   - **Settings** (`#/settings`): Sonarr connection with a Test button; **Sonarr setup** panel with profile checkboxes (pre-tick the profiles in-scope series use), dual score, status from `GET /api/setup` with each profile's problems, and an "Apply to Sonarr" button; **Rules** (scope, require subtitles, subtitle language); **Schedule & searching** (cron presets, autoSearch, searchPerRun, searchAgainDays); **Notifications**; **Login & API key**.
   - **Activity** (`#/activity`): the runs table, showing scanned/totals/upgraded/problems/searched/replaced/profiles/warnings.
   - Login and first-run account screens as in Courarr. After the account is created, go to Settings if Sonarr isn't connected.
5. **Tests** (`test/`): a `fixtures/mock-sonarr.mjs` like Courarr's `test/fixtures/mock-arr.mjs`, with series (anime + standard), episode files with varied mediaInfo, episodes, history, custom formats and quality profiles, recording every write. Add `rules.test.js` (langs, classifyFile incl. hardsub and subtitleLanguage, searchPlan, grabFor, profileWithScores/profileState, diffScans, the regexes against real-world release names), `jobs.test.js` (scan, dueForSearch pacing, replace blocklists + deletes + searches, setup creates/updates formats idempotently), `api.test.js` (auth like Courarr's, the library/scan/search/replace/setup routes) and `notify.test.js`. Keep coverage thresholds as in `package.json`.
6. **Packaging**: copy and adapt Courarr's `Dockerfile` (port 6162, labels), `docker-compose.yml`, `.dockerignore`, `.github/workflows/docker.yml` (smoke test: health, 401 before setup, account creation, API key works, PUID/PGID, TZ), `templates/dualarr.xml` and `ca_profile.xml` (Unraid CA). `docker/entrypoint.sh` is already copied.
7. **README**: install (Unraid, compose), how the custom formats work, a note that Sonarr must have "Analyse video files" on, caveats (below), and screenshots.

## Caveats to document

- Sonarr ranks quality above custom format score, so a dual audio release at a lower quality than the current file won't replace it.
- Custom formats only see release names. Dual audio detection relies on names like "Dual Audio", "Multi-Audio" or "JPN+ENG". The file scan (media info) is the ground truth, which is why the two parts work together.
- A subtitle track can be signs & songs only. Media info can't tell that apart from full subtitles.
- If other custom formats in a profile score very high, raise the dual audio score above them. The setup panel flags this.
