-- Same shape as the official Nearby Hello demo. Extra require() modules
-- and retrying enable() were exhausting BLE heap (Malloc failed -> WDT).

local enabled = false
local next_send = 0
local received = 0
local pick = 1
local LINES = { "hey", "where?", "ok", "wait", "on my way" }
local status, peer, signal

function on_enter(root)
  local title = badge.ui.label(root, "Nored")
  title:align("top_mid", 0, 12)
  status = badge.ui.label(root, "Starting radio...")
  status:align("top_mid", 0, 48)
  peer = badge.ui.label(root, "Open Nored on both badges")
  peer:align("center", 0, 0)
  signal = badge.ui.label(root, "UP/DOWN pick line, A send")
  signal:align("center", 0, 32)
  local hint = badge.ui.label(root, "A send   HOME exit")
  hint:align("bottom_mid", 0, -16)

  enabled = badge.radio.enable()
  if not enabled then
    status:set_text("Radio unavailable - reboot")
    return
  end
  status:set_text("Ready - A sends " .. LINES[pick])
  badge.radio.on_recv(function(mac, rssi, payload)
    if type(payload) ~= "string" or payload:sub(1, 4) ~= "NR1:" then
      return
    end
    received = received + 1
    peer:set_text("From " .. mac)
    signal:set_text(payload:sub(5) .. "  " .. tostring(rssi) .. " dBm")
  end)
end

function on_button(button, kind)
  if kind ~= badge.input.KIND.PRESSED then
    return
  end
  local B = badge.input.BUTTON
  if button == B.UP then
    pick = pick - 1
    if pick < 1 then
      pick = #LINES
    end
    status:set_text("Ready - A sends " .. LINES[pick])
    return
  end
  if button == B.DOWN then
    pick = pick + 1
    if pick > #LINES then
      pick = 1
    end
    status:set_text("Ready - A sends " .. LINES[pick])
    return
  end
  if button ~= B.A or not enabled then
    return
  end
  local now = badge.sys.ms()
  if now < next_send then
    status:set_text("Wait a second, then A")
    return
  end
  next_send = now + 1000
  if badge.radio.send("NR1:" .. LINES[pick]) then
    status:set_text("Queued " .. LINES[pick])
  else
    status:set_text("Send failed - retry A")
  end
end

function on_exit()
  if enabled then
    badge.radio.on_recv(nil)
    badge.radio.disable()
  end
end
