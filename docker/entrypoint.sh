#!/bin/sh
set -e

umask "${UMASK:-002}"
mkdir -p "$CONFIG_DIR"

# Run as PUID:PGID (Unraid default 99:100 = nobody:users) so /config stays editable from shares.
if [ "$(id -u)" = "0" ]; then
  chown -R "${PUID:-99}:${PGID:-100}" "$CONFIG_DIR"
  exec su-exec "${PUID:-99}:${PGID:-100}" "$@"
fi

exec "$@"
