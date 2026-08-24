-- Noktus Jellyfin trickplay provider for thumbfast-compatible OSC scripts.
-- The host publishes bounded raw-BGRA frame windows with shim-trickplay-bif.

local utils = require "mp.utils"

local image = {
    count = 0,
    interval_ms = 0,
    width = 0,
    height = 0,
    file = "",
    first = 0,
    total = 0,
    asked = nil,
    last_frame = -1,
    last_x = nil,
    last_y = nil,
    shown = false,
    enabled = false,
    overlay_id = 46,
}

local function publish_info()
    local json, error_message = utils.format_json({
        width = image.width,
        height = image.height,
        disabled = not image.enabled,
        available = image.enabled,
        overlay_id = image.overlay_id,
    })
    if error_message then
        mp.msg.error("Could not encode thumbfast metadata: " .. error_message)
        return
    end
    mp.commandv("script-message", "thumbfast-info", json)
end

local function remove_overlay()
    if not image.shown then return end
    mp.commandv("overlay-remove", image.overlay_id)
    image.shown = false
    image.last_frame = -1
    image.last_x = nil
    image.last_y = nil
end

local function clear()
    image.enabled = false
    image.asked = nil
    remove_overlay()
    publish_info()
end

local function receive_window(args)
    local count = tonumber(args[2])
    local interval_ms = tonumber(args[3])
    local width = tonumber(args[4])
    local height = tonumber(args[5])
    local file = args[6]
    local first = tonumber(args[7]) or 0
    local total = tonumber(args[8]) or count
    if not count or count < 1 or not interval_ms or interval_ms < 1
        or not width or width < 1 or not height or height < 1
        or type(file) ~= "string" or file == ""
        or first < 0 or not total or total < count or first + count > total then
        mp.msg.error("Ignoring invalid Noktus trickplay window")
        clear()
        return
    end
    image.count = count
    image.interval_ms = interval_ms
    image.width = width
    image.height = height
    image.file = file
    image.first = first
    image.total = total
    image.asked = nil
    image.last_frame = -1
    image.enabled = true
    publish_info()
    mp.msg.verbose(string.format(
        "Noktus trickplay window: %d frames [%d,%d) of %d at %dx%d from %s",
        count, first, first + count, total, width, height, file))
end

local function show_thumbnail(args)
    if not image.enabled then return end
    local seconds = tonumber(args[2])
    local x = tonumber(args[3])
    local y = tonumber(args[4])
    if not seconds or not x or not y then return end

    local video_frame = math.floor(seconds * 1000 / image.interval_ms)
    video_frame = math.max(0, math.min(video_frame, image.total - 1))
    local frame = video_frame - image.first
    if frame < 0 or frame >= image.count then
        if image.asked ~= video_frame then
            image.asked = video_frame
            mp.msg.verbose("Noktus trickplay frame " .. video_frame .. " is outside the window")
            mp.commandv("script-message", "shim-trickplay-need", tostring(seconds))
        end
        remove_overlay()
        return
    end

    if frame == image.last_frame and x == image.last_x and y == image.last_y then
        return
    end
    image.last_frame = frame
    image.last_x = x
    image.last_y = y
    image.shown = true
    mp.commandv(
        "overlay-add",
        image.overlay_id,
        x,
        y,
        image.file,
        frame * image.width * image.height * 4,
        "bgra",
        image.width,
        image.height,
        image.width * 4
    )
end

mp.register_event("client-message", function(event)
    local args = event.args or {}
    local name = args[1]
    if name == "shim-trickplay-bif" then
        receive_window(args)
    elseif name == "shim-trickplay-clear" then
        clear()
    elseif name == "thumb" then
        show_thumbnail(args)
    elseif name == "clear" then
        remove_overlay()
    end
end)

