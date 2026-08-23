# MPV integration scripts

`jellyfin_dc.lua` and `thumbfast.lua` are maintained as part of Noktus. `thumbfast.lua`
implements the Jellyfin MPV Shim message contract and is based on the
compatibility-layer design in
[`jellyfin_mpv_shim/thumbfast.lua`](https://github.com/jellyfin/jellyfin-mpv-shim/blob/master/jellyfin_mpv_shim/thumbfast.lua).

`trickplay-osc.lua` is the minimally patched stock MPV OSC from
[`iwalton3/jf-mpv-osc`](https://github.com/iwalton3/jf-mpv-osc), imported from commit
`3ad84e62fcb2820c48992e8fb6c5b4d1ca6a7255`. Its SHA-256 after normalizing line endings
to LF is `7b08e8150c9a7963d7664e6b8090dfc4ef53e3c2b0ae9e136f4344c3db1a8557`.

The imported project and Noktus are licensed under GPL-3.0-or-later. Changes to the
upstream OSC are marked by its author with `BEGIN patch` / `END patch` comments.
