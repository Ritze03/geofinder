#!/usr/bin/env bash
# Run a command inside a throwaway HEADLESS sway session (Linux + sway only), so Electron
# windows never appear on a real desktop:  tests/electron/headless-sway.sh <cmd...>
# Propagates the command's exit code and always stops the sway it started.
set -u
[ $# -gt 0 ] || { echo "usage: $0 <cmd...>" >&2; exit 2; }
command -v sway >/dev/null || { echo "headless-sway: sway not found" >&2; exit 127; }

dir=$(mktemp -d)
printf 'output HEADLESS-1 resolution 1920x1080\nxwayland disable\n' > "$dir/config"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
  env -u DISPLAY -u WAYLAND_DISPLAY -u SWAYSOCK -u I3SOCK \
  sway -d -c "$dir/config" >"$dir/sway.log" 2>&1 &
sway_pid=$!
cleanup() { kill "$sway_pid" 2>/dev/null; wait "$sway_pid" 2>/dev/null; rm -rf "$dir"; }
trap cleanup EXIT

# sway picks the first free wayland-N (never wayland-1 while that is taken); read it from its debug log.
display=""
for _ in $(seq 1 100); do
  kill -0 "$sway_pid" 2>/dev/null || { echo "headless-sway: sway exited early:" >&2; cat "$dir/sway.log" >&2; exit 1; }
  swaysock="$XDG_RUNTIME_DIR/sway-ipc.$(id -u).$sway_pid.sock"
  if [ -S "$swaysock" ]; then
    display=$(SWAYSOCK="$swaysock" swaymsg -t get_version >/dev/null 2>&1 && sed -n "s/.*Running compositor on wayland display '\(wayland-[0-9]*\)'.*/\1/p" "$dir/sway.log")
    [ -n "$display" ] && break
  fi
  sleep 0.1
done
[ -n "$display" ] || { echo "headless-sway: no wayland socket found; sway log:" >&2; cat "$dir/sway.log" >&2; exit 1; }

echo "headless-sway: pid $sway_pid, WAYLAND_DISPLAY=$display, SWAYSOCK=$swaysock" >&2
env -u DISPLAY WAYLAND_DISPLAY="$display" SWAYSOCK="$swaysock" ELECTRON_OZONE_PLATFORM_HINT=wayland "$@"
