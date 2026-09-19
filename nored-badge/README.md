# Nored on the HTN badge

Two paths:

1. **Lua app (stock firmware)** — this directory is a Badge IDE workspace. Badge-to-badge pings over the sandboxed `LUA1` radio (44-byte frames). Phones cannot join this channel.
2. **Custom ESP32 flash** — `firmware/` replaces stock Lua with a NimBLE GATT hop the Nored **phone** app can use. No Lua after that flash.

## Lua workspace (push these files)

```
manifest.cfg
main.lua
```

This is a single-file app on purpose. Extra `require()` modules and retrying `radio.enable()` used enough RAM that BLE `Malloc failed` and the chip watchdog-reset (often every second launch). It matches the official Nearby Hello demo: a few labels, `enable()` once, no retries.

### Install on a stock badge

1. Open [Badge IDE](https://badge.hackthenorth.com/ide/) (desktop Chrome/Edge).
2. Put config in `manifest.cfg` and code in `main.lua` only. In the IDE, delete leftover `proto.lua` / `radio.lua` / `screen.lua` / `leds.lua` if they are still listed (Push does not remove old files by itself). Skip `README.md` and `firmware/`.
3. Badge off → USB data cable → on **without** holding Start. Close other serial tools.
4. **Connect** → USB JTAG/serial debug unit → **Push**.
5. Reboot, then open **Nored**. After using radio, HOME reboots the badge to free BLE RAM (same as Share). If you open Nored again immediately from a live launcher, `enable()` can fail or panic.

### Controls

| Button | Action |
| --- | --- |
| UP / DOWN | Cycle canned line |
| A | Send `NR1:` + that line |
| HOME | Exit (radio teardown is deferred ~2s) |

This is **not** the phone mesh. Phone chat still needs the custom flash below.

## Custom GATT router (phones)

Reflashing is experimental. Back up anything you care about. See the official [custom flash guide](https://badge.hackthenorth.com/custom-flash).

- Advertises Nored service `6e4f5245-442d-4d45-5348-000000000001`
- Identity / RX / TX characteristics
- Two phone connections (GATT peripheral only)
- After both phones write identity JSON, each is notified with the **other** phone’s identity
- Forwards `0x4E` packet frames between those two links

```sh
. ~/.espressif/tools/activate_idf_v5.5.3.sh
cd nored-badge/firmware
idf.py set-target esp32c3
idf.py build
idf.py -p /dev/tty.usbmodemXXXX flash monitor
```

Turn the badge **off**, plug in USB-C, turn it **on** (do not hold Start). If esptool says `No serial data received`, unplug, hold **Start**, plug in, then flash.

Expected log: `Nored 2-link GATT router ready`. After this flash there are no Lua apps.

## Limits

| Lua app | Custom flash |
| --- | --- |
| 44-byte `LUA1` radio, one `main.lua` | 2 phone links |
| No GATT, no Nored phone protocol | No Lua / NFC / stock games |
