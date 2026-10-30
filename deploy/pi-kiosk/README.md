# Raspberry Pi wall kiosk

`install.sh` turns a Raspberry Pi into an always-on screen that shows the
streamanator `/wall` page full screen in Chromium. It starts with the desktop,
waits for the dashboard server, and relaunches Chromium if it ever exits.

## Prerequisites

- Raspberry Pi OS **Desktop** (Bookworm or Trixie, 64-bit recommended). Older
  X11 (LXDE-pi) images also work. Lite images have no desktop and are not supported.
- Desktop auto-login for the user you install as:
  `sudo raspi-config nonint do_boot_behaviour B4` (the installer warns if it is off).
- That user can use `sudo` (it is used for `apt` and `raspi-config` only).
- **Network:** the Pi must reach `10.0.40.100:8600` on the internal network
  (same LAN/VLAN or routed to it). Port 8600 is internal only. **Never
  port-forward it** or expose it to the internet to make a kiosk work; put the
  Pi on the internal network instead.

Check from the Pi before installing:

```bash
curl -s http://10.0.40.100:8600/api/health    # expect {"ok":true,...}
```

## Install

From the workstation:

```bash
scp deploy/pi-kiosk/install.sh pi@<pi-host>:~/
ssh pi@<pi-host>
bash install.sh                 # as the desktop user, NOT with sudo
sudo reboot
```

Running it again is safe: nothing changes unless a setting changed. The most
recent run's flags win, so always pass the full set you want.

## Flags

| Flag | Meaning |
| --- | --- |
| `--url URL` | Page to show. Default `http://10.0.40.100:8600/wall`. The kiosk waits for `<origin>/api/health`. |
| `--night-off HH:MM-HH:MM` | Display off at the first time, on at the second, e.g. `23:00-07:00`. Uses `wlopm`/`wlr-randr` on Wayland and `xset dpms` on X11. |
| `--rotate 0\|90\|180\|270` | Rotate the screen when the kiosk starts. |
| `--uninstall` | Remove everything the installer added and restore the screen-blanking setting. |
| `--help` | Usage. |

Example: `bash install.sh --night-off 23:30-06:45 --rotate 90`

## How it works

| What | Where |
| --- | --- |
| Launcher/supervisor | `~/.local/bin/streamanator-kiosk` |
| Settings (written by the installer) | `~/.config/streamanator-kiosk/kiosk.conf` |
| Autostart entry | `~/.config/autostart/streamanator-kiosk.desktop` (plus a `[autostart]` line in `~/.config/wayfire.ini` on wayfire) |
| Chromium profile | `~/.local/share/streamanator-kiosk/chromium` |
| Logs | `~/.local/state/streamanator-kiosk/kiosk.log` and `chromium.log` (each capped, one `.1` backup) |
| Cron jobs | `crontab -l`, lines ending `# streamanator-kiosk` |

At login the launcher:

1. Polls `/api/health` until it returns `{"ok":true}`, backing off from 2s up
   to 30s. Until then the normal desktop shows; no error page is put on screen.
2. Clears Chromium's "exited uncleanly" flag so no "Restore pages?" bubble
   appears, then starts Chromium in `--kiosk` mode with a dedicated profile.
3. If Chromium exits, it waits for the server again and relaunches after 5s.
   Repeated fast crashes back off to 60s and then 300s so a broken setup does
   not spin the CPU.

The page handles its own reconnects and STALE banner, so the kiosk never
reloads it. Cron restarts Chromium at 04:30 every night to bound its memory
use, and the supervisor brings it straight back. Screen blanking is turned off
with `raspi-config`, and on X11 also with `xset` for the running session.

Only one launcher runs at a time (it holds a lock file), so the extra wayfire
entry and the XDG entry never start two browsers.

Useful commands on the Pi:

```bash
tail -f ~/.local/state/streamanator-kiosk/kiosk.log
~/.local/bin/streamanator-kiosk restart-browser    # restart Chromium now
~/.local/bin/streamanator-kiosk display off|on     # screen power by hand
```

## Troubleshooting

**Blank screen / just the desktop, no dashboard.** The launcher is usually
waiting for the server: check `kiosk.log` for `waiting for .../api/health`.
If the log does not exist, the autostart did not run: confirm auto-login is on
and the `.desktop` file exists, then reboot. A black screen with no desktop at
all is usually blanking or night-off: check `crontab -l` and that
`raspi-config` > Display Options > Screen Blanking is off.

**Server unreachable.** Run `curl -v http://10.0.40.100:8600/api/health` on
the Pi. A timeout means a routing/VLAN/firewall problem between the Pi and
`streamanator`; fix the network path, do not port-forward. A refused connection
means the dashboard service is down on the server. The kiosk shows the page by
itself as soon as health answers.

**Mouse cursor visible.** On X11 the installer adds `unclutter`, which hides an
idle cursor. On Wayland (labwc/wayfire) there is no reliable cursor hider:
unplug the mouse, or have the `/wall` page set `cursor: none`.

**"Restore pages?" bubble.** The launcher clears the crash flag before every
start, so this should not appear. If it does, Chromium was probably started
outside the launcher with the same profile: run `restart-browser`, or reboot.

**Chromium will not start ("profile in use").** Stale lock links are removed
automatically before each launch. If it persists, check `chromium.log`, or
delete `~/.local/share/streamanator-kiosk/chromium` and reboot (a fresh profile
is recreated).

**Rotation is wrong or reverts.** On labwc, the Screen Configuration tool
(kanshi) can override it; setting the orientation there instead of using
`--rotate` is the more durable option.

## Uninstall

```bash
bash install.sh --uninstall
sudo reboot
```

This stops the kiosk and removes the launcher, settings, autostart entries,
cron lines, Chromium profile and logs, and restores the screen-blanking setting
found at first install. Packages (`chromium`, `curl`, `wlr-randr`, `unclutter`)
stay installed.
