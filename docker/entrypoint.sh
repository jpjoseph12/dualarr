#!/bin/sh
set -e

umask "${UMASK:-002}"
mkdir -p "$CONFIG_DIR"

# Run as PUID:PGID (Unraid default 99:100 = nobody:users) so /config stays editable from shares.
if [ "$(id -u)" = "0" ]; then
  chown -R "${PUID:-99}:${PGID:-100}" "$CONFIG_DIR"
  # GPU device nodes (/dev/dri for Intel and AMD, /dev/nvidia*) belong to groups like "video" or
  # "render" whose numbers differ between hosts: join whichever groups own the ones passed in.
  groups="${PGID:-100}"
  for dev in /dev/dri/* /dev/nvidia*; do
    [ -c "$dev" ] || continue
    gid=$(stat -c %g "$dev")
    case ",$groups," in *",$gid,"*) ;; *) groups="$groups,$gid" ;; esac
  done
  exec setpriv --reuid="${PUID:-99}" --regid="${PGID:-100}" --groups="$groups" "$@"
fi

exec "$@"
