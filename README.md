# Dualarr

Keeps the anime in **Sonarr** in Japanese with subtitles, and swaps subbed-only releases for **dual audio** once the dub comes out.

> Work in progress. See [CLAUDE.md](CLAUDE.md) for what's built and what's left.

## What it does

1. **Custom formats in Sonarr (one click).** Dualarr creates two custom formats and scores them in the quality profiles you pick:
   - **Dual Audio (Dualarr)**: scored high (default +2000), so a dual audio release is always an upgrade over a subbed one.
   - **Dub Only (Dualarr)**: scored −10000, so English-only dubs are never grabbed.

   It also turns upgrades on and sets the profile's "upgrade until" score so subbed files keep upgrading until dual audio arrives. After that, Sonarr's own RSS and upgrade logic replaces subbed files by itself.
2. **A check of every file on disk**, using Sonarr's media info (audio and subtitle track languages). Each file gets one verdict:
   - **Dual audio**: Japanese and English audio, with subtitles
   - **Subbed**: Japanese audio and subtitles, waiting for the dub
   - **No subtitles**: Japanese audio but no (matching) subtitle track
   - **No Japanese audio**: for example an English-only dub
   - **Unknown**: Sonarr has no media info, or the tracks aren't tagged with a language
3. **Search and replace.** Dualarr searches Sonarr for dual audio versions of subbed-only seasons. A nightly search works through the library a few series at a time. For files that break the rules (no Japanese audio or no subtitles), Replace blocklists the release, deletes the file and searches again.
4. **Notifications** (Discord, Telegram, ntfy, Gotify, webhook) when files are upgraded to dual audio, or when new files break the rules.

Built from the same stack as [Courarr](https://github.com/jpjoseph12/courarr): Node 24, Express, `node:sqlite` and a plain ES-module web UI, packaged as a Docker image and Unraid template.
