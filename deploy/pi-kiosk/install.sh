#!/usr/bin/env bash
# Streamanator kiosk installer for Raspberry Pi OS (Bookworm / Trixie, 64-bit;
# labwc, wayfire or the older X11/LXDE-pi desktop).
#
# Turns a Pi into an always-on wall display for the streamanator dashboard.
# Run it as the desktop user that auto-logs in, NOT with sudo: everything it
# installs lives in that user's home, and it calls sudo itself only for apt
# and raspi-config.
#
#   bash install.sh [--url URL] [--night-off HH:MM-HH:MM] [--rotate 0|90|180|270]
#   bash install.sh --uninstall
#
# Re-running is safe. Files are rewritten only when their content changes, and
# crontab/autostart entries are replaced rather than appended. The flags of the
# most recent run win, so re-run with the full set of flags you want.

set -euo pipefail
# Lets `producer | write_file ...` run write_file in this shell, so the files it
# records in CHANGED survive for the summary instead of vanishing in a subshell.
shopt -s lastpipe

readonly DEFAULT_URL="http://10.0.40.100:8600/wall"
readonly NAME="streamanator-kiosk"
# Every crontab line we add ends with this marker, so re-runs and --uninstall
# touch exactly our lines and never the user's own jobs.
readonly CRON_MARK="# ${NAME}"
readonly NIGHTLY_RESTART_MIN=30
readonly NIGHTLY_RESTART_HOUR=4

readonly LAUNCHER="$HOME/.local/bin/$NAME"
readonly CONF_DIR="$HOME/.config/$NAME"
readonly CONF_FILE="$CONF_DIR/kiosk.conf"
readonly STATE_DIR="$HOME/.local/state/$NAME"
readonly DATA_DIR="$HOME/.local/share/$NAME"
readonly PROFILE_DIR="$DATA_DIR/chromium"
readonly AUTOSTART_FILE="$HOME/.config/autostart/$NAME.desktop"
readonly WAYFIRE_INI="$HOME/.config/wayfire.ini"
readonly WAYFIRE_KEY="streamanator_kiosk"
# The blanking setting found on first install, so --uninstall can put it back
# instead of guessing. Never overwritten by later runs (by then it reads "off").
readonly BLANKING_STATE="$STATE_DIR/original-blanking"

CHANGED=()
NOTES=()
APT_UPDATED=0

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; NOTES+=("$*"); }
note() { NOTES+=("$*"); }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: bash install.sh [options]

Installs a Chromium kiosk that shows the streamanator /wall page full screen
and starts automatically when the desktop session starts.

Options:
  --url URL                Page to show (default: $DEFAULT_URL).
                           The kiosk waits for <origin>/api/health before
                           opening it.
  --night-off HH:MM-HH:MM  Turn the display off at the first time and on at
                           the second (e.g. 23:00-07:00). Omit to keep it on.
  --rotate 0|90|180|270    Rotate the display (clockwise) when the kiosk starts.
  --uninstall              Remove everything this script installed and restore
                           the original screen-blanking setting.
  -h, --help               Show this help.

Run as the normal desktop user (not root). Re-running is safe; the most
recent run's flags win.
EOF
}

# --- arguments ---------------------------------------------------------------

URL="$DEFAULT_URL"
NIGHT_OFF=""
ROTATE=""
MODE="install"

need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value (see --help)"; }

while (($#)); do
  case $1 in
    --url) need_value "$@"; URL=$2; shift 2 ;;
    --url=*) URL=${1#*=}; shift ;;
    --night-off) need_value "$@"; NIGHT_OFF=$2; shift 2 ;;
    --night-off=*) NIGHT_OFF=${1#*=}; shift ;;
    --rotate) need_value "$@"; ROTATE=$2; shift 2 ;;
    --rotate=*) ROTATE=${1#*=}; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# Installing as root would put the launcher, autostart entry and crontab in
# root's home, where the desktop session never looks.
((EUID != 0)) || die "run this as the desktop user, not as root or with sudo (it uses sudo itself where needed)"
[[ $(uname -s) == Linux ]] || die "this installer targets Raspberry Pi OS; copy it to the Pi and run it there"
command -v sudo >/dev/null || die "sudo is required"

if [[ $MODE == install ]]; then
  [[ $URL =~ ^https?://[^/[:space:]]+ ]] || die "--url must start with http:// or https://"
  if [[ -n $NIGHT_OFF ]]; then
    [[ $NIGHT_OFF =~ ^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$ ]] ||
      die "--night-off must look like 23:00-07:00 (24-hour, zero-padded)"
    [[ ${NIGHT_OFF%-*} != "${NIGHT_OFF#*-}" ]] || die "--night-off start and end must differ"
  fi
  case $ROTATE in "" | 0 | 90 | 180 | 270) ;; *) die "--rotate must be 0, 90, 180 or 270" ;; esac
fi

# The health endpoint lives at the root of whatever server --url points at.
ORIGIN=$(sed -E 's#^(https?://[^/]+).*#\1#' <<<"$URL")
HEALTH_URL="$ORIGIN/api/health"

# --- helpers -----------------------------------------------------------------

# Write stdin to $1 only when the content differs, so a second run leaves the
# files (and their mtimes) alone and the summary can truthfully say so.
write_file() {
  local dest=$1 mode=$2 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  mkdir -p "$(dirname "$dest")"
  if [[ -f $dest ]] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    chmod "$mode" "$dest"
    return 0
  fi
  install -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
  CHANGED+=("wrote $dest")
}

apt_install() {
  if ((!APT_UPDATED)); then
    info "Refreshing apt package lists"
    sudo apt-get update -qq
    APT_UPDATED=1
  fi
  info "Installing: $*"
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  CHANGED+=("apt installed: $*")
}

# Optional packages must never abort the install: a missing cursor hider is
# cosmetic, a missing kiosk is not.
apt_install_optional() {
  apt_install "$@" || warn "could not install $* (continuing without it)"
}

find_chromium() {
  command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true
}

# The installer is often run over SSH, where none of the desktop's environment
# variables exist, so look at what is actually running for this user first and
# fall back to what LightDM is configured to start.
detect_session() {
  local uid configured=""
  uid=$(id -u)
  if pgrep -u "$uid" -x 'labwc(-pi)?' >/dev/null 2>&1; then echo labwc; return; fi
  if pgrep -u "$uid" -x 'wayfire(-pi)?' >/dev/null 2>&1; then echo wayfire; return; fi
  if pgrep -u "$uid" -x 'lxsession|openbox|openbox-lxde|lxpanel' >/dev/null 2>&1 ||
    pgrep -x Xorg >/dev/null 2>&1; then
    echo x11
    return
  fi
  if [[ -r /etc/lightdm/lightdm.conf ]]; then
    configured=$(grep -E '^[[:space:]]*(autologin-session|user-session)[[:space:]]*=' /etc/lightdm/lightdm.conf |
      tail -n1 | cut -d= -f2 | tr -d '[:space:]') || true
  fi
  # Pi OS session names: LXDE-pi-labwc, LXDE-pi-wayfire, LXDE-pi-x (and plain
  # LXDE-pi on older X11 images). Order matters: test the Wayland ones first.
  case $configured in
    *labwc*) echo labwc; return ;;
    *wayfire*) echo wayfire; return ;;
    LXDE* | *-x | openbox*) echo x11; return ;;
  esac
  case ${XDG_SESSION_TYPE:-} in
    wayland) echo wayland ;;
    x11) echo x11 ;;
    *) echo unknown ;;
  esac
}

# Our crontab lines, in a fixed order so re-runs produce identical text.
desired_cron_lines() {
  printf '%s %s * * * %s restart-browser >/dev/null 2>&1 %s\n' \
    "$NIGHTLY_RESTART_MIN" "$NIGHTLY_RESTART_HOUR" "$LAUNCHER" "$CRON_MARK"
  if [[ -n $NIGHT_OFF ]]; then
    local off=${NIGHT_OFF%-*} on=${NIGHT_OFF#*-}
    # 10# strips leading zeros so cron sees plain numbers.
    printf '%d %d * * * %s display off >/dev/null 2>&1 %s\n' \
      "$((10#${off#*:}))" "$((10#${off%:*}))" "$LAUNCHER" "$CRON_MARK"
    printf '%d %d * * * %s display on >/dev/null 2>&1 %s\n' \
      "$((10#${on#*:}))" "$((10#${on%:*}))" "$LAUNCHER" "$CRON_MARK"
  fi
}

# Replace our marked lines with $1 (may be empty), leaving every other line of
# the user's crontab untouched. Only writes when something actually changes.
set_cron_lines() {
  local wanted=$1 existing others new
  existing=$(crontab -l 2>/dev/null) || existing=""
  others=$(grep -vF -- "$CRON_MARK" <<<"$existing") || others=""
  if [[ -z $others ]]; then
    new=$wanted
  elif [[ -z $wanted ]]; then
    new=$others
  else
    new="$others"$'\n'"$wanted"
  fi
  [[ $new != "$existing" ]] || return 0
  # Don't create an empty crontab for a user who never had one.
  [[ -n $new || -n $existing ]] || return 0
  if [[ -n $new ]]; then
    printf '%s\n' "$new" | crontab -
  else
    crontab -r 2>/dev/null || true
  fi
  CHANGED+=("updated crontab (lines marked \"$CRON_MARK\")")
}

# Wayfire config with our [autostart] entry removed ($1=keep) or present.
wayfire_ini_content() {
  local add=$1
  awk -v key="$WAYFIRE_KEY" -v line="$WAYFIRE_KEY = $LAUNCHER" -v add="$add" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { next }
    { print }
    add && !done && /^[[:space:]]*\[autostart\][[:space:]]*$/ { print line; done = 1 }
    END { if (add && !done) { print ""; print "[autostart]"; print line } }
  ' "$WAYFIRE_INI"
}

stop_running_kiosk() {
  local uid
  uid=$(id -u)
  # The launcher's own trap stops Chromium; the second pkill catches a
  # Chromium whose launcher was already gone.
  pkill -u "$uid" -f -- "$LAUNCHER" 2>/dev/null || true
  pkill -u "$uid" -f -- "--user-data-dir=$PROFILE_DIR" 2>/dev/null || true
}

# --- the launcher ------------------------------------------------------------

# Quoted heredoc: nothing in here is expanded at install time. Per-install
# values live in kiosk.conf, so this text is identical on every run and the
# idempotency check above holds.
launcher_content() {
  cat <<'LAUNCHER_EOF'
#!/usr/bin/env bash
# Streamanator kiosk launcher. Written by deploy/pi-kiosk/install.sh; local
# edits are overwritten when the installer runs again. Settings: kiosk.conf.
#
#   streamanator-kiosk                       supervise Chromium (session autostart)
#   streamanator-kiosk restart-browser       make Chromium exit; the supervisor relaunches it
#   streamanator-kiosk display on|off|auto   screen power, used by the --night-off cron lines
#
# No `set -e` on purpose: this is a long-running supervisor and one failed
# command (a curl timeout, a missing optional tool) must not end the kiosk.
set -uo pipefail

NAME=streamanator-kiosk
CONF_FILE="$HOME/.config/$NAME/kiosk.conf"
STATE_DIR="$HOME/.local/state/$NAME"
LOG="$STATE_DIR/kiosk.log"
CHROMIUM_LOG="$STATE_DIR/chromium.log"
LOG_MAX_BYTES=$((512 * 1024))
CHROMIUM_LOG_MAX_BYTES=$((2 * 1024 * 1024))
# A Chromium that dies sooner than this after launch counts towards the
# crash-loop guard; one that ran longer resets it.
QUICK_EXIT_SECS=60

URL="http://10.0.40.100:8600/wall"
HEALTH_URL="http://10.0.40.100:8600/api/health"
NIGHT_OFF=""
ROTATE=""
PROFILE_DIR="$HOME/.local/share/$NAME/chromium"
# shellcheck source=/dev/null
[[ -r $CONF_FILE ]] && . "$CONF_FILE"

mkdir -p "$STATE_DIR"
CHROME_PID=""

# Copy-then-truncate rather than rename: Chromium keeps its log open in append
# mode, and truncating keeps it writing to the live file instead of the archive.
bound_log() {
  local f=$1 max=$2 size
  size=$(stat -c %s "$f" 2>/dev/null) || return 0
  ((size > max)) || return 0
  cp -f "$f" "$f.1" && : >"$f"
}

log() {
  bound_log "$LOG" "$LOG_MAX_BYTES"
  printf '%s [%s] %s\n' "$(date '+%F %T')" "$$" "$*" >>"$LOG"
}

# Cron jobs get none of the desktop's environment, so find the compositor's
# socket (or the X display) ourselves. Inside the session this changes nothing.
session_env() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [[ -z ${WAYLAND_DISPLAY:-} ]]; then
    local s
    for s in "$XDG_RUNTIME_DIR"/wayland-[0-9]*; do
      [[ -S $s ]] && { export WAYLAND_DISPLAY="${s##*/}"; break; }
    done
  fi
  if [[ -z ${WAYLAND_DISPLAY:-} ]]; then
    export DISPLAY="${DISPLAY:-:0}"
    export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
  fi
}

# Wayland wins when both are set: labwc/wayfire also export DISPLAY for
# Xwayland, but X11 tools cannot power or rotate a Wayland output.
is_wayland() { [[ -n ${WAYLAND_DISPLAY:-} ]]; }

wayland_outputs() { wlr-randr 2>/dev/null | awk '/^[^[:space:]]/ { print $1 }'; }
x11_outputs() { xrandr --query 2>/dev/null | awk '/ connected/ { print $1 }'; }

# raspi-config's blanking switch needs a reboot to apply and older images lack
# it, so on X11 also switch blanking off for this session directly.
x11_no_blank() {
  command -v xset >/dev/null || return 0
  xset s off
  xset s noblank
  xset -dpms
}

apply_rotation() {
  [[ -n $ROTATE ]] || return 0
  local out transform
  if is_wayland; then
    command -v wlr-randr >/dev/null || { log "rotate: wlr-randr not installed"; return 0; }
    transform=$ROTATE
    [[ $transform == 0 ]] && transform=normal
    for out in $(wayland_outputs); do
      wlr-randr --output "$out" --transform "$transform" || log "rotate: failed on $out"
    done
  else
    command -v xrandr >/dev/null || { log "rotate: xrandr not installed"; return 0; }
    case $ROTATE in 0) transform=normal ;; 90) transform=right ;; 180) transform=inverted ;; 270) transform=left ;; esac
    for out in $(x11_outputs); do
      xrandr --output "$out" --rotate "$transform" || log "rotate: failed on $out"
    done
  fi
}

display_power() {
  local state=$1 out
  session_env
  if is_wayland; then
    # wlopm only toggles power and leaves the layout alone; wlr-randr disables
    # the output outright. Prefer wlopm when someone has installed it.
    if command -v wlopm >/dev/null; then
      wlopm --"$state" '*' || log "display $state: wlopm failed"
    elif command -v wlr-randr >/dev/null; then
      for out in $(wayland_outputs); do
        wlr-randr --output "$out" --"$state" || log "display $state: failed on $out"
      done
      # Re-enabling an output can come back with its default transform.
      [[ $state == on ]] && apply_rotation
    else
      log "display $state: neither wlopm nor wlr-randr is installed"
      return 1
    fi
  else
    command -v xset >/dev/null || { log "display $state: xset not installed"; return 1; }
    if [[ $state == off ]]; then
      # "force off" needs DPMS enabled, which the kiosk normally keeps disabled.
      xset +dpms
      xset dpms force off
    else
      xset dpms force on
      x11_no_blank
    fi
  fi
  log "display $state"
}

to_minutes() { echo $((10#${1%:*} * 60 + 10#${1#*:})); }

in_night_window() {
  [[ $NIGHT_OFF == ??:??-??:?? ]] || return 1
  local start end now
  start=$(to_minutes "${NIGHT_OFF%-*}")
  end=$(to_minutes "${NIGHT_OFF#*-}")
  now=$(to_minutes "$(date +%H:%M)")
  if ((start < end)); then
    ((now >= start && now < end))
  else
    ((now >= start || now < end))
  fi
}

health_ok() {
  local body re='"ok"[[:space:]]*:[[:space:]]*true'
  body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null) || return 1
  [[ $body =~ $re ]]
}

# Opening the page before the server answers would leave Chromium's own
# "can't reach this site" page on the wall, which never retries. So wait with
# backoff (2s doubling to 30s) and only log occasionally to keep the log small.
wait_for_server() {
  local delay=2 tries=0
  until health_ok; do
    tries=$((tries + 1))
    if ((tries == 1)); then
      log "waiting for $HEALTH_URL"
    elif ((tries % 20 == 0)); then
      log "still waiting for $HEALTH_URL ($tries failed checks)"
    fi
    sleep "$delay" &
    wait $!
    delay=$((delay * 2))
    ((delay > 30)) && delay=30
  done
  ((tries > 0)) && log "server answered after $tries failed checks"
  return 0
}

# Chromium shows a "restore pages?" bubble after any unclean exit (power cut,
# kill, crash). Marking the last exit as clean suppresses it on a kiosk with no
# one to dismiss it.
prepare_profile() {
  local prefs="$PROFILE_DIR/Default/Preferences"
  if [[ -f $prefs ]]; then
    sed -i -e 's/"exited_cleanly":[[:space:]]*false/"exited_cleanly":true/g' \
      -e 's/"exit_type":[[:space:]]*"[A-Za-z]*"/"exit_type":"Normal"/g' "$prefs"
  fi
  # After a power cut these links still name the old PID, and after a hostname
  # change Chromium refuses the profile as "in use on another computer". We hold
  # the kiosk lock, so no live Chromium of ours owns them.
  rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonSocket"
}

chromium_bin() { command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null; }

start_unclutter() {
  command -v unclutter >/dev/null || return 0
  pgrep -u "$(id -u)" -x unclutter >/dev/null && return 0
  # 9>&-: unclutter outlives the launcher and must not keep holding its lock.
  unclutter -idle 0.5 -root >/dev/null 2>&1 9>&- &
}

on_signal() {
  log "launcher stopping"
  [[ -n $CHROME_PID ]] && kill -TERM "$CHROME_PID" 2>/dev/null
  exit 0
}

run_kiosk() {
  # Autostart can fire twice (XDG autostart plus wayfire's own [autostart]
  # entry); the lock makes any second copy exit quietly.
  exec 9>"$STATE_DIR/kiosk.lock"
  if ! flock -n 9; then
    log "another launcher already holds the lock; exiting"
    exit 0
  fi
  trap on_signal TERM INT HUP
  log "launcher start: url=$URL"

  session_env
  if ! is_wayland; then
    x11_no_blank
    start_unclutter
  fi
  apply_rotation
  # A reboot inside the night-off window would otherwise leave the screen on
  # until the morning "on" job.
  in_night_window && display_power off

  local flags=(
    --user-data-dir="$PROFILE_DIR"
    --kiosk
    --noerrdialogs
    --disable-infobars
    --disable-session-crashed-bubble
    --no-first-run
    --no-default-browser-check
    --check-for-update-interval=31536000
    --overscroll-history-navigation=0
    --disable-pinch
    --password-store=basic
    --ozone-platform-hint=auto
    --autoplay-policy=no-user-gesture-required
    # Chromium honours only the last --disable-features, so keep them in one.
    --disable-features=Translate,TranslateUI
  )
  local bin started ran rc delay quick_exits=0

  while :; do
    wait_for_server
    if ! bin=$(chromium_bin); then
      log "chromium not found; retrying in 60s"
      sleep 60 &
      wait $!
      continue
    fi
    prepare_profile
    : >"$CHROMIUM_LOG"
    started=$SECONDS
    # 9>&- keeps the lock fd out of Chromium, so an orphaned browser can't stop
    # the next session's launcher from taking the lock.
    "$bin" "${flags[@]}" "$URL" >>"$CHROMIUM_LOG" 2>&1 9>&- &
    CHROME_PID=$!
    log "chromium started: pid=$CHROME_PID bin=$bin"

    # Poll rather than a bare `wait` so the Chromium log stays bounded during
    # a long run, and so signals to the launcher are handled promptly.
    while kill -0 "$CHROME_PID" 2>/dev/null; do
      sleep 5 &
      wait $!
      bound_log "$CHROMIUM_LOG" "$CHROMIUM_LOG_MAX_BYTES"
    done
    wait "$CHROME_PID"
    rc=$?
    CHROME_PID=""
    ran=$((SECONDS - started))

    # Crash-loop guard: a Chromium that keeps dying at startup (bad profile,
    # GPU trouble) would otherwise spin the CPU and flood the log.
    if ((ran < QUICK_EXIT_SECS)); then
      quick_exits=$((quick_exits + 1))
    else
      quick_exits=0
    fi
    if ((quick_exits >= 5)); then
      delay=300
    elif ((quick_exits >= 3)); then
      delay=60
    else
      delay=5
    fi
    log "chromium exited: rc=$rc after ${ran}s (quick exits in a row: $quick_exits); relaunching in ${delay}s"
    sleep "$delay" &
    wait $!
  done
}

# Nightly job: bounds long-run browser memory. -o signals only the oldest
# matching process, the main browser, so it shuts down cleanly instead of
# watching its renderers die first.
restart_browser() {
  if pkill -TERM -o -u "$(id -u)" -f -- "--user-data-dir=$PROFILE_DIR"; then
    log "restart-browser: asked chromium to exit; the launcher will relaunch it"
  else
    log "restart-browser: no kiosk chromium was running"
  fi
}

case ${1:-run} in
  run) run_kiosk ;;
  restart-browser) restart_browser ;;
  display)
    case ${2:-} in
      on | off) display_power "$2" ;;
      auto) if in_night_window; then display_power off; else display_power on; fi ;;
      *) echo "usage: $NAME display on|off|auto" >&2; exit 2 ;;
    esac
    ;;
  *) echo "usage: $NAME [run | restart-browser | display on|off|auto]" >&2; exit 2 ;;
esac
LAUNCHER_EOF
}

# --- uninstall ---------------------------------------------------------------

uninstall() {
  info "Stopping the kiosk if it is running"
  # If night-off has the screen off right now, turn it back on while the
  # helper that knows how still exists.
  if [[ -x $LAUNCHER && -r $CONF_FILE ]] && (
    # shellcheck source=/dev/null
    . "$CONF_FILE"
    [[ -n ${NIGHT_OFF:-} ]]
  ); then
    "$LAUNCHER" display on >/dev/null 2>&1 || true
  fi
  stop_running_kiosk

  info "Removing crontab entries"
  set_cron_lines ""

  if [[ -f $WAYFIRE_INI ]] && grep -qE "^[[:space:]]*${WAYFIRE_KEY}[[:space:]]*=" "$WAYFIRE_INI"; then
    info "Removing wayfire autostart entry"
    wayfire_ini_content 0 | write_file "$WAYFIRE_INI" 644
  fi
  if [[ -f $WAYFIRE_INI.$NAME.bak ]]; then
    rm -f -- "$WAYFIRE_INI.$NAME.bak"
    CHANGED+=("removed $WAYFIRE_INI.$NAME.bak")
  fi

  if [[ -f $BLANKING_STATE ]]; then
    local original
    original=$(<"$BLANKING_STATE")
    if [[ $original == 0 || $original == 1 ]] && command -v raspi-config >/dev/null; then
      info "Restoring screen blanking setting (raspi-config do_blanking $original)"
      if sudo raspi-config nonint do_blanking "$original"; then
        CHANGED+=("restored screen blanking to its original setting")
      else
        warn "raspi-config could not restore blanking; set it in raspi-config > Display Options"
      fi
    fi
  else
    warn "no record of the original blanking setting; left as is (raspi-config > Display Options > Screen Blanking)"
  fi

  local path
  for path in "$AUTOSTART_FILE" "$LAUNCHER" "$CONF_DIR" "$DATA_DIR" "$STATE_DIR"; do
    if [[ -e $path ]]; then
      rm -rf -- "$path"
      CHANGED+=("removed $path")
    fi
  done

  echo
  echo "Streamanator kiosk uninstalled."
  if ((${#CHANGED[@]})); then
    printf '  - %s\n' "${CHANGED[@]}"
  else
    echo "  Nothing to remove; it was not installed."
  fi
  echo
  echo "Packages were left installed (other software may use them). To remove them:"
  echo "  sudo apt remove wlr-randr unclutter     # chromium and curl are usually worth keeping"
  echo "Reboot so the desktop starts without the kiosk: sudo reboot"
  if ((${#NOTES[@]})); then
    echo
    echo "Notes:"
    printf '  - %s\n' "${NOTES[@]}"
  fi
}

if [[ $MODE == uninstall ]]; then
  uninstall
  exit 0
fi

# --- install -----------------------------------------------------------------

SESSION=$(detect_session)
info "Desktop session: $SESSION"
[[ $SESSION != unknown ]] ||
  warn "could not tell which desktop session this Pi runs; installing for all of them"

command -v crontab >/dev/null || apt_install cron
command -v curl >/dev/null || apt_install curl

CHROMIUM=$(find_chromium)
if [[ -z $CHROMIUM ]]; then
  # Trixie and late-2024+ Bookworm ship "chromium"; older Pi OS images only had
  # "chromium-browser". Ask apt which one it can actually provide.
  if ((!APT_UPDATED)); then
    info "Refreshing apt package lists"
    sudo apt-get update -qq
    APT_UPDATED=1
  fi
  # Captured rather than piped into `grep -q`, which under pipefail can fail
  # the test when grep exits early and apt-cache gets SIGPIPE.
  policy=$(apt-cache policy chromium 2>/dev/null) || policy=""
  if [[ $policy =~ Candidate:\ [0-9] ]]; then
    apt_install chromium
  else
    apt_install chromium-browser
  fi
  CHROMIUM=$(find_chromium)
  [[ -n $CHROMIUM ]] || die "Chromium installed but no chromium or chromium-browser binary found"
fi

case $SESSION in
  labwc | wayfire | wayland)
    command -v wlr-randr >/dev/null || apt_install_optional wlr-randr
    ;;
  x11)
    command -v unclutter >/dev/null || apt_install_optional unclutter
    command -v xset >/dev/null || apt_install_optional x11-xserver-utils
    ;;
  *)
    command -v wlr-randr >/dev/null || apt_install_optional wlr-randr
    command -v unclutter >/dev/null || apt_install_optional unclutter
    ;;
esac

info "Writing launcher, config and autostart entry"
mkdir -p "$STATE_DIR" "$PROFILE_DIR"

{
  echo "# Generated by deploy/pi-kiosk/install.sh. Re-run the installer to change"
  echo "# these; manual edits are overwritten on the next run."
  printf 'URL=%q\n' "$URL"
  printf 'HEALTH_URL=%q\n' "$HEALTH_URL"
  printf 'NIGHT_OFF=%q\n' "$NIGHT_OFF"
  printf 'ROTATE=%q\n' "$ROTATE"
  printf 'PROFILE_DIR=%q\n' "$PROFILE_DIR"
} | write_file "$CONF_FILE" 644

launcher_content | write_file "$LAUNCHER" 755

# XDG autostart is the one mechanism all three Pi OS desktops honour: LXDE-pi
# via lxsession, labwc via lxsession-xdg-autostart in /etc/xdg/labwc/autostart,
# and wayfire likewise. We deliberately do NOT create ~/.config/labwc/autostart:
# labwc runs only the first autostart file it finds, so a user copy would
# shadow the system one and the panel and desktop would no longer start.
cat <<EOF | write_file "$AUTOSTART_FILE" 644
[Desktop Entry]
Type=Application
Name=Streamanator kiosk
Comment=Full-screen streamanator wall display (deploy/pi-kiosk/install.sh)
Exec=$LAUNCHER
Terminal=false
X-GNOME-Autostart-enabled=true
EOF

# Wayfire on early Bookworm images is the one place we can't be sure XDG
# autostart is wired up, so also add an entry to its own [autostart] section.
# If both fire, the launcher's lock makes the second one exit. We only edit an
# existing wayfire.ini: Pi OS creates it from a template on first login, and a
# file holding only [autostart] would replace the whole desktop config.
if [[ $SESSION == wayfire ]]; then
  if [[ -f $WAYFIRE_INI ]]; then
    if [[ ! -f $WAYFIRE_INI.$NAME.bak ]]; then
      cp -p "$WAYFIRE_INI" "$WAYFIRE_INI.$NAME.bak"
    fi
    wayfire_ini_content 1 | write_file "$WAYFIRE_INI" 644
  else
    warn "$WAYFIRE_INI does not exist yet (log in to the desktop once, then re-run); relying on XDG autostart"
  fi
fi

info "Disabling screen blanking"
if command -v raspi-config >/dev/null; then
  current=$(sudo raspi-config nonint get_blanking 2>/dev/null) || current=""
  if [[ ! -f $BLANKING_STATE && ($current == 0 || $current == 1) ]]; then
    echo "$current" >"$BLANKING_STATE"
  fi
  # raspi-config convention: 1 means "blanking disabled".
  if [[ $current != 1 ]]; then
    if sudo raspi-config nonint do_blanking 1; then
      CHANGED+=("disabled screen blanking (raspi-config; takes effect after reboot)")
    else
      warn "raspi-config could not disable screen blanking; set it in raspi-config > Display Options"
    fi
  fi
else
  warn "raspi-config not found; on X11 the launcher disables blanking itself, on Wayland disable it in the desktop settings"
fi

info "Updating crontab"
set_cron_lines "$(desired_cron_lines)"

# Without auto-login the kiosk only starts once someone logs in at the screen.
autologin=""
if [[ -r /etc/lightdm/lightdm.conf ]]; then
  autologin=$(grep -E '^[[:space:]]*autologin-user[[:space:]]*=' /etc/lightdm/lightdm.conf |
    tail -n1 | cut -d= -f2 | tr -d '[:space:]') || true
fi
if [[ $autologin != "$(id -un)" ]]; then
  warn "desktop auto-login for $(id -un) is not enabled; turn it on with: sudo raspi-config nonint do_boot_behaviour B4"
fi
if [[ $SESSION != x11 ]]; then
  note "on Wayland the kiosk can't hide the mouse cursor; unplug the mouse (or have the page set cursor: none)"
fi

# --- summary -----------------------------------------------------------------

echo
echo "Streamanator kiosk installed."
echo
echo "  Session        : $SESSION"
echo "  Chromium       : $CHROMIUM"
echo "  Page           : $URL"
echo "  Waits for      : $HEALTH_URL"
echo "  Nightly restart: Chromium at $(printf '%02d:%02d' "$NIGHTLY_RESTART_HOUR" "$NIGHTLY_RESTART_MIN")"
echo "  Night-off      : ${NIGHT_OFF:-not set (display stays on)}"
echo "  Rotation       : ${ROTATE:-not set}"
echo
echo "Files:"
echo "  Launcher       : $LAUNCHER"
echo "  Settings       : $CONF_FILE"
echo "  Autostart      : $AUTOSTART_FILE"
[[ $SESSION == wayfire && -f $WAYFIRE_INI ]] && echo "  Wayfire entry  : $WAYFIRE_INI ([autostart] $WAYFIRE_KEY)"
echo "  Chromium data  : $PROFILE_DIR"
echo "  Logs           : $STATE_DIR/kiosk.log, $STATE_DIR/chromium.log"
echo "  Crontab        : crontab -l   (lines ending \"$CRON_MARK\")"
echo
if ((${#CHANGED[@]})); then
  echo "Changed this run:"
  printf '  - %s\n' "${CHANGED[@]}"
else
  echo "Nothing changed: already installed with these settings."
fi
if ((${#NOTES[@]})); then
  echo
  echo "Notes:"
  printf '  - %s\n' "${NOTES[@]}"
fi
echo
echo "Start it now with: sudo reboot"
echo "Uninstall with:    bash install.sh --uninstall"
