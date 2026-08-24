# MPV integration scripts

`jellyfin_dc.lua` and `thumbfast.lua` are maintained as part of Noktus. `thumbfast.lua`
implements the Jellyfin MPV Shim message contract and is based on the
compatibility-layer design in
[`jellyfin_mpv_shim/thumbfast.lua`](https://github.com/jellyfin/jellyfin-mpv-shim/blob/master/jellyfin_mpv_shim/thumbfast.lua).

`osc.lua` is the minimally patched stock MPV OSC from
[`iwalton3/jf-mpv-osc`](https://github.com/iwalton3/jf-mpv-osc), imported from commit
`3ad84e62fcb2820c48992e8fb6c5b4d1ca6a7255`. Changes made by that project's author are
marked with `BEGIN patch` / `END patch` comments.

The file must keep the name `osc.lua`: MPV derives a script's name from its filename, so
this is what keeps `script-binding osc/visibility` and `--script-opts=osc-*` resolving
the way users and mpv.net's menu expect. Noktus loads it only alongside `--osc=no`, so
it never collides with the built-in OSC.

Noktus changes on top of the imported file:

- `visibility_mode("never")` called an undefined global `img_is_shown`, so the thumbnail
  overlay was never removed; it now calls the file's own `thumbfast_clear()`.

Its SHA-256 after normalizing line endings to LF is
`76cf0f7fe89e2279b4ba0899d217eb6070a4fc25e0a20d887c772f0b1ddbb24c`. The check in
`test/mpv-resources.test.js` pins that value, so any further edit has to update both.

The imported project and Noktus are licensed under GPL-3.0-or-later.
