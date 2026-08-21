# Discord Rich Presence

Noktus publishes title-only playback activity through Discord's local RPC endpoint by
default. Disable it in Noktus Settings to opt out. It does not send Jellyfin server
addresses, account data, media URLs, media artwork, or playback progress percentages.

## Release setup

The project-owned Discord application ID is embedded in Noktus. Upload a 1024px Noktus
logo asset with the key `noktus` to that application before release. The application ID
is public; do not place a Discord client secret in Noktus or its release pipeline. Set
`NOKTUS_DISCORD_APPLICATION_ID` only when you need to override the project application
for local testing.

Until Discord is running, the Settings page reports the integration as unavailable and
retries quietly while playback is active.
