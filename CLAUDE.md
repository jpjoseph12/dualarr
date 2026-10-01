# Dualarr: handoff notes

A standalone companion to Sonarr for anime. It keeps every file in Japanese audio with subtitles, and swaps subbed-only releases for dual audio when the dub comes out. It was split out of Courarr (`github.com/jpjoseph12/courarr`) because the job is different: Courarr decides what gets added to Sonarr, Dualarr checks the quality of what's already on disk. **Copy Courarr's conventions and code style**: Node 24 ESM with no build step, Express 5, `node:sqlite`, `node --test` with local mock servers, and a plain `public/app.js` UI with dark CSS tokens. Comments should be short and explain *why*.

## Done

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

- `jobs.js` details: `scanJob(trigger, { autoSearch, notify })` (`notify: false` for the quiet rescan after a rules change; a failed *scheduled* scan sends an `error` notification when `notifyProblems` is on); `setupJob()` turns a missing profile into a warning instead of failing; `summary.notified` only counts events that at least one notifier delivered.
- `scheduler.js`, `index.js`: as in Courarr. The cron job runs `scanJob('schedule', { autoSearch: true })`; `DUALARR_RESET_AUTH` removes the login.
- `app.js`: Courarr's auth, BUILD header, settings (every field validated, Sonarr key masked), notifier sanitising, `/api/status`, `/api/runs`, plus:
  - `GET /api/library` → `{ series, totals, sonarrUrl }`. Each series has `state` and `needsSearch` but **no `files`** (a large library has tens of thousands); the UI loads them per row from `GET /api/series/:id`.
  - `POST /api/scan` (202, background), `POST /api/search` `{ ids? }` (no ids = every *monitored* series that needs it), `POST /api/series/:id/replace` `{ fileIds }` (returns the rescanned series), `GET/POST /api/setup`.
  - A job that ends in `error` becomes a 400 with its message. Saving a change to `scope`/`requireSubtitles`/`subtitleLanguage` starts `scanJob('rules', { notify: false })` and returns `rescanning: true`.
- `public/`: `index.html`, `app.js` (Library / Settings / Activity, login and first-run screens; lands on Settings until Sonarr is connected, and saving a first connection starts a scan), trimmed `app.css` with a violet accent (`--accent #9d8cff`), `logo.svg` (two speech bubbles) and `icon.png` from `tools/make-icon.mjs`.
- Tests (`npm test`, all against `test/fixtures/mock-sonarr.mjs` and `test/fixtures/sink.mjs`): `rules`, `jobs`, `api` (includes the auth tests), `notify`, `template`, `verify`, and `ui`. Coverage is well above the thresholds in `package.json`.
- `test/ui.test.js`: the web UI in Chromium via Playwright (a devDependency; the image uses `--omit=dev`). It drives one page through a first run (login, connecting Sonarr, first scan, library tabs/filter/rows, Search, Search all, Replace, Sonarr setup, a rules rescan, notifiers, Check files, Activity), then phone width (no sideways scroll), the reload when the server build changes, an ended session and logout. The tests build on each other. It skips without Chromium (`npx playwright install chromium`, or `CHROMIUM_PATH`) but fails on CI (`CI` set), which installs it. The mock servers send `Connection: close`, because `makeEpisode()` blocks the event loop and a reused keep-alive socket then fails with ECONNRESET.
- Packaging: `Dockerfile` (port 6162), `docker-compose.yml`, `.dockerignore`, `.github/workflows/docker.yml` (tests + coverage, container smoke test, publish to GHCR), `templates/dualarr.xml`, `ca_profile.xml`.
- README with install, first run, custom formats, the "Analyse video files" note, caveats and screenshots (`docs/screenshots/`).

### Check files (0.2.0)

Instead of trusting Sonarr's language tags, Dualarr can listen to the audio and read the subtitles itself.
- `verify.js` (I/O): `tools()` finds ffmpeg/ffprobe/whisper-cli and the GPUs (`whisper-cli -h` still loads every ggml backend, and they log their devices; `parseDevices`). `deviceArgs(choice, devices)` turns `verifyDevice` ('auto' | 'cpu' | 'gpu:N') into `-ng` / `-dev N`; auto skips software renderers (llvmpipe, which is ~50× slower than the CPU backend). `checkFile(path, { model, device, subtitles })`: ffprobe → three 30 s clips per audio track (16 kHz mono WAV, one ffmpeg seek per position) → one whisper-cli `-dl` run for all clips (the model loads once; `parseWhisper` pairs each `processing '<file>'` log line with the `auto-detected language: xx (p = …)` after it) → subtitles to SRT (text tracks) or packet counts (PGS/DVD). The model downloads from Hugging Face into `/config/models` (`WHISPER_MODEL_URL` overrides; the file must start with the ggml magic). `mapPath` applies `pathMappings` (longest prefix).
- `rules.js` (pure): `clipStarts` (30/50/70% of the episode, because dubs keep the Japanese OP/ED), `audioLanguage` (probability-weighted vote; below `AUDIO_MIN_P` = 0.5 the tag stands), `parseSrt`, `dialogueRate` (distinct lines per minute in the middle 70%), `subtitleKind` (title/forced, else < 3 lines/min = signs), `textLanguage` (scripts, then weighted stop words), `checkedLanguages` + `classifyFile(f, opts, check)` (a check replaces the tags when its `size` matches; notes explain each disagreement; `subsChecked: false` keeps the subtitle tags).
- `db.js`: `checks` table (file id → series, size, result). Pruned with their files and series.
- `jobs.js`: the scheduled scan checks `dueForVerify` files (unchecked or changed; Sonarr's unknowns first, then the newest; `verifyPerRun`) **before** summarising, so notifications include what was found. `verifyJob({ seriesIds, force })` (Check files buttons), `verifyTestJob()` (Settings test; stores nothing). Files the container can't see are counted as `missing` with a warning, not stored.
- API: `GET /api/verify` (tools, devices, model, download progress, Sonarr root folders and whether they're visible), `POST /api/verify/model`, `POST /api/verify` (202), `POST /api/verify/test`.
- Docker: `Dockerfile` builds whisper.cpp (`WHISPER_VERSION`, v1.9.4) with `GGML_BACKEND_DL` + `GGML_CPU_ALL_VARIANTS`, in two flavours via `--build-arg GPU=`: `vulkan` (tag `latest`, Debian trixie, Mesa drivers minus lavapipe; arm64 gets CPU only) and `cuda` (tag `latest-cuda`, CUDA **12.9**, because CUDA 13 dropped Pascal/GTX 10; archs 52/61/75/86/89+PTX). The runtime is `node:24-trixie-slim`. The entrypoint drops to PUID:PGID with `setpriv` and joins the groups owning `/dev/dri/*` and `/dev/nvidia*`. CI smoke-tests both images, including a real model download and check on a tone file (there's no speech sample, so language accuracy isn't asserted).
- Unraid: `templates/dualarr.xml` (optional Media path and `/dev/dri` device) and `templates/dualarr-nvidia.xml` (`latest-cuda`, `--runtime=nvidia`, `NVIDIA_VISIBLE_DEVICES`, `NVIDIA_DRIVER_CAPABILITIES`).
- Tests use real ffmpeg (CI installs it) with `test/fixtures/fake-whisper.mjs`, which "hears" a clip's language from its tone (440 Hz Japanese, 880 Hz English; `FAKE_GPU` pretends a Vulkan GPU), and `test/fixtures/media.mjs` to make episodes. Tests needing ffmpeg skip without it.
- Verified during development: the CPU and Vulkan builds of whisper.cpp v1.9.4 on Ubuntu 24.04 (device logs, `-dev`/`-ng`, multi-file `-dl` output), run against real test episodes. **Not verified here** (no Docker daemon, GPU, or Hugging Face access in the dev sandbox): the Docker builds themselves, CUDA, real GPUs, and language accuracy with a real model. CI's smoke job is the first real run of the images.

### Replace automatically (0.3.0)

- Setting `autoReplace` (off by default) + `autoReplacePerRun` (10). `jobs.autoReplace()` runs in the scheduled scan (with Check files on) and in `verifyJob`, **after** the verdicts are saved and **before** `diffScans`, so a file replaced at once isn't also announced as a new problem. It sends a `replaced` notification (under `notifyProblems`).
- Candidates: `status === 'noJapanese'`, verified, and `rules.surelyNotJapanese(check)` (every audio track detected as non-Japanese with p ≥ `AUTO_REPLACE_MIN_P` = 0.8). Guards: monitored series with `originalLanguage` Japanese (`rules.expectsJapanese`; `summariseSeries` now stores `originalLanguage`), a monitored episode, the series' quality profile `profileState(...).ready`, at most `MAX_AUTO_REPLACES` (2) per episode (table `auto_replaced`), and the per-run cap. Skipped files are listed with a reason in `summary.autoReplaced.skipped`.
- `replaceFiles()` is shared with the Replace button and now classifies with the stored checks (before, a file the check had found to be English but tagged Japanese was refused).
- `sonarr.js` retries a GET once after a dropped kept-alive connection (`ECONNRESET`), which showed up in tests and happens behind proxies.

## Ideas for later

- Unticking a profile in the setup panel leaves Dualarr's scores in it; `setupJob` could reset the scores of profiles that are no longer chosen.
- Screenshots were taken with Playwright against the mock Sonarr (with extra series, generated posters, generated episodes and fake-whisper); a `tools/screenshots.mjs` would make them reproducible.
- Check files: a checked file isn't re-checked when "Require subtitles" is turned on later (its subtitles weren't read, so the tags stand). whisper.cpp's VAD could skip silent clips.
- The `DUAL_RE` doesn't match a bare `MULTi` on purpose (it often means a French multi-language dub). Revisit if users report missed dual audio releases.

## Caveats (documented in the README)

- Sonarr ranks quality above custom format score, so a dual audio release at a lower quality than the current file won't replace it.
- Custom formats only see release names. Dual audio detection relies on names like "Dual Audio", "Multi-Audio" or "JPN+ENG". The file scan (media info) is the ground truth, which is why the two parts work together.
- A subtitle track can be signs & songs only. Media info can't tell that apart from full subtitles (Check files can).
- If other custom formats in a profile score very high, raise the dual audio score above them. The setup panel flags this.
