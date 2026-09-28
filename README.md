# Dualarr

Keeps the anime in **Sonarr** in Japanese with subtitles, and swaps subbed-only releases for **dual audio** once the dub comes out.

![Library](docs/screenshots/library.png)

Dualarr is a companion to Sonarr, and a sibling of [Courarr](https://github.com/jpjoseph12/courarr). Courarr decides what gets added to Sonarr. Dualarr checks what is already on disk.

## What it does

1. **Custom formats in Sonarr, in one click.** Dualarr creates two custom formats and scores them in the quality profiles you pick:
   - **Dual Audio (Dualarr)** is scored high (+2000 by default), so a dual audio release is always an upgrade over a subbed one.
   - **Dub Only (Dualarr)** is scored −10000, so English-only dubs are never grabbed.

   It also turns upgrades on and sets the profile's "upgrade until" score, so subbed files keep being upgraded until dual audio arrives. From then on, Sonarr's own RSS sync and upgrade logic replaces subbed files by itself.
2. **A check of every file on disk**, using Sonarr's media info (the languages of the audio and subtitle tracks). Each file gets one verdict:
   - **Dual audio**: Japanese and English audio, with subtitles
   - **Subbed**: Japanese audio and subtitles, waiting for the dub
   - **No subtitles**: Japanese audio but no (matching) subtitle track. "HardSub" in the file or release name counts as subtitled.
   - **No Japanese audio**: for example an English-only dub
   - **Unknown**: Sonarr has no media info, or the tracks aren't tagged with a language
3. **Search and replace.**
   - **Search** asks Sonarr to look for better releases. A season where every file needs work gets one season search, which finds batch releases (where dual audio usually turns up); otherwise the monitored episodes are searched one by one.
   - The **nightly scan** also searches a few series (10 by default), least recently searched first, and waits a week before searching the same series again. A big library is worked through over a few nights without hammering your indexers.
   - **Replace** is for files that break the rules (no Japanese audio, or no subtitles). It marks the release that produced the file as failed in Sonarr (so it is blocklisted), deletes the file and searches for the episode again.
4. **Notifications** (Discord, Telegram, ntfy, Gotify or a JSON webhook) when files are upgraded to dual audio, when new files break the rules, and when a scheduled scan can't reach Sonarr.

## Before you start: turn on "Analyse video files" in Sonarr

Dualarr reads each file's audio and subtitle languages from Sonarr's media info. Sonarr only collects it when **Settings → Media Management → Analyse video files** is on (click **Show Advanced** to see it). It is on by default. If Dualarr shows many **Unknown** files, check this setting, then use **Refresh & Scan** on the series in Sonarr and scan again in Dualarr.

## Install

### Unraid

Once Dualarr is listed in Community Applications: **Apps** → search **Dualarr** → **Install** → **Apply**. Until then:

- **Unraid 7**: open a terminal (the **>_** icon at the top right) and run
  ```bash
  mkdir -p /boot/config/plugins/dockerMan/templates-user && wget -qO /boot/config/plugins/dockerMan/templates-user/my-Dualarr.xml https://raw.githubusercontent.com/jpjoseph12/dualarr/main/templates/dualarr.xml
  ```
  then **Docker** tab → **Add Container** → **Template** → **Dualarr** (under *User templates*) → **Apply**.
- **Unraid 6**: **Docker** tab → **Template repositories** (at the bottom) → add `https://github.com/jpjoseph12/dualarr` → **Save**, then **Add Container** → **Template** → **Dualarr** → **Apply**.

The defaults are fine: web UI on port **6162**, settings in `/mnt/user/appdata/dualarr`, running as `99:100`. Unraid sets `TZ` for you.

### Docker Compose

```yaml
services:
  dualarr:
    image: ghcr.io/jpjoseph12/dualarr:latest
    container_name: dualarr
    restart: unless-stopped
    ports:
      - "6162:6162"
    environment:
      - TZ=Europe/London   # scheduled scans run in this time zone
      - PUID=1000
      - PGID=1000
    volumes:
      - ./config:/config
```

`docker compose up -d`, then open `http://<server>:6162`.

| Variable | Default | |
|---|---|---|
| `TZ` | `Etc/UTC` | Time zone for the schedule |
| `PUID` / `PGID` | `99` / `100` | User and group the app runs as. `/config` is owned by them. |
| `UMASK` | `002` | File creation mask |
| `PORT` | `6162` | Port inside the container |
| `DUALARR_RESET_AUTH` | | Set to `true` once to remove a forgotten login, then remove it again. Settings are kept. |

## First run

1. Open the web UI and create your login.
2. **Settings → Sonarr**: enter Sonarr's URL (your server's address, not `localhost`) and its API key (Sonarr → Settings → General). Press **Test**, then **Save settings**. Dualarr runs the first scan straight away.
3. **Settings → Sonarr setup**: tick the quality profiles your anime uses (the ones your anime series already use are ticked for you), and press **Apply to Sonarr**. Each profile should then show **Ready**.
4. Back in the **Library**, **Search all that need it** starts the first round of searches. After that the nightly scan takes over.

![Settings](docs/screenshots/settings.png)

## How the custom formats work

Sonarr gives every release a custom format score, and within the same quality it prefers the release with the higher score. Dualarr's two formats look at the release name:

- **Dual Audio (Dualarr)** matches names like `Dual Audio`, `Dual-Audio`, `Multi-Audio`, `Dual-Lang`, `JPN+ENG` or `JA-EN`.
- **Dub Only (Dualarr)** matches `Dub`, `Dubbed` or `English Dub`, unless the name also says dual audio.

In each profile you pick, **Apply to Sonarr**:

- scores Dual Audio at the dual audio score (2000 by default) and Dub Only at −10000,
- turns **Upgrades Allowed** on,
- raises **Upgrade Until Custom Format Score** to at least the dual audio score, so a subbed file keeps being upgraded until a dual audio release arrives, and then stops,
- raises **Minimum Custom Format Score** if it was negative enough to let a dub-only release through.

Everything else in the profile (qualities, other formats and their scores) is left alone. Applying again updates the formats in place; nothing is duplicated.

## Rules

- **Check**: series with the Anime series type (the default), or also any series whose original language is Japanese.
- **Require subtitles**: on by default. Turn it off if you are happy with Japanese audio alone.
- **Subtitle language**: any language by default, or a specific one (English, Spanish, Portuguese, French, German, Italian, Arabic, Russian).

Changing a rule rescans the library, without sending notifications.

## Caveats

- **Quality comes first.** Sonarr ranks quality above custom format score. A dual audio release at a lower quality than your current file (a 720p dual audio release against a 1080p subbed file, say) won't replace it. Allow the qualities you would accept for dual audio in the profile.
- **Custom formats only see release names.** Sonarr can only tell a release is dual audio if its name says so ("Dual Audio", "Multi-Audio", "JPN+ENG" and so on). The file scan reads the real audio tracks, so it is the ground truth: a dual audio release with a plain name shows up as dual audio once it is on disk, and a mislabelled one shows up as what it really is. The two parts work together.
- **Signs & songs tracks count as subtitles.** Media info can't tell a signs & songs track apart from full subtitles, so a file with only signs & songs passes the subtitle check.
- **Very high scores in other formats.** If another custom format in a profile scores more than the dual audio score, a subbed release with it could beat a dual audio one. Raise the dual audio score above it. The setup panel flags this, and also flags a profile where another format scores so high (10000 or more) that a dub-only release could still be grabbed.
- **Unknown files are skipped.** Files without media info are never searched or replaced. See [Analyse video files](#before-you-start-turn-on-analyse-video-files-in-sonarr).

## Activity and API

**Activity** lists every scan, search, replace and setup, with what it found and any warnings.

![Activity](docs/screenshots/activity.png)

Scripts can use the API key from **Settings → Login & API key**, in an `X-Api-Key` header or an `?apikey=` parameter:

```sh
curl -X POST -H "X-Api-Key: <key>" http://<server>:6162/api/scan       # scan now (runs in the background)
curl -X POST -H "X-Api-Key: <key>" http://<server>:6162/api/search     # search every monitored series that needs it
curl -H "X-Api-Key: <key>" http://<server>:6162/api/library            # every series with its counts and state
curl -H "X-Api-Key: <key>" http://<server>:6162/api/status             # the job in progress, next scan, last run
```

## Development

Node 24 (22.13+ works), no build step.

```sh
npm install
npm run dev             # http://localhost:6162, settings in ./.config
npm test                # unit and API tests against a local stand-in Sonarr
npm run test:coverage   # the same, with the coverage thresholds CI enforces
node test/fixtures/mock-sonarr.mjs   # a stand-in Sonarr on :8989 (API key "sonarrkey") to click around with
npm run icon            # redraw public/icon.png after changing the logo
```

## License

MIT
