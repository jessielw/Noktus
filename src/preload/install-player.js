"use strict";

// This function is serialized by Electron and executed in the page's Main World.
// We must keep it self contained: closure variables and Node globals are not available there.
function installPlayer(config) {
  "use strict";

  const server = new URL(config.serverUrl);
  const basePath = server.pathname.replace(/\/$/, "");
  if (
    location.origin !== server.origin ||
    !location.pathname.startsWith(`${basePath}/web`)
  ) {
    return {
      installed: false,
      reason: "outside configured Jellyfin Web scope",
    };
  }
  if (window.__jellyfinDcElectronInstalled) {
    return { installed: true, reason: "already installed" };
  }
  window.__jellyfinDcElectronInstalled = true;

  const bridge = window.jellyfinDesktop;
  const state = { backend: config.backend, startFullscreen: true };
  const TRICKPLAY_WINDOW_BYTES = 24 * 1024 * 1024;
  const TRICKPLAY_CHUNK_BYTES = 1536 * 1024;
  const TRICKPLAY_MAX_TILE_BYTES = 128 * 1024 * 1024;
  let activeMpvPlayer = null;
  let activeWebMedia = null;

  function publishPresence(activity) {
    if (!activity || typeof bridge.updatePresence !== "function") return;
    Promise.resolve(bridge.updatePresence(activity)).catch(() => {});
  }

  function clearPresence() {
    if (typeof bridge.clearPresence !== "function") return;
    Promise.resolve(bridge.clearPresence()).catch(() => {});
  }

  function presenceTitle() {
    try {
      const title = navigator.mediaSession?.metadata?.title;
      if (typeof title === "string" && title.trim()) return title.trim();
    } catch {
      // Media Session metadata is optional in Jellyfin Web.
    }
    const title = String(document.title || "").trim();
    const normalized = title.replace(/\s*[-|]\s*Jellyfin\s*$/i, "").trim();
    return normalized.toLowerCase() === "jellyfin" ? "" : normalized;
  }

  function publishWebPresence(media) {
    if (state.backend !== "web" || !media || media.paused || media.ended) return;
    const title = presenceTitle();
    if (!title) return;
    publishPresence({
      title,
      mediaType: media instanceof HTMLAudioElement ? "audio" : "video",
      playbackState: "playing",
      positionSeconds: Math.max(0, Number(media.currentTime) || 0),
    });
  }

  function publishPausedWebPresence(media) {
    if (state.backend !== "web" || !media || media.ended) return;
    const title = presenceTitle();
    if (!title) {
      clearPresence();
      return;
    }
    publishPresence({
      title,
      mediaType: media instanceof HTMLAudioElement ? "audio" : "video",
      playbackState: "paused",
      positionSeconds: Math.max(0, Number(media.currentTime) || 0),
    });
  }

  function installWebPresenceObserver() {
    if (typeof document === "undefined" || !document.addEventListener) return;
    document.addEventListener(
      "play",
      (event) => {
        const media = event.target;
        if (!(media instanceof HTMLMediaElement) || state.backend !== "web") return;
        activeWebMedia = media;
        publishWebPresence(media);
      },
      true,
    );
    for (const eventName of ["loadedmetadata", "playing"]) {
      document.addEventListener(
        eventName,
        (event) => {
          const media = event.target;
          if (media === activeWebMedia) publishWebPresence(media);
        },
        true,
      );
    }
    document.addEventListener(
      "pause",
      (event) => {
        const media = event.target;
        if (media !== activeWebMedia) return;
        publishPausedWebPresence(media);
      },
      true,
    );
    document.addEventListener(
      "seeked",
      (event) => {
        const media = event.target;
        if (media !== activeWebMedia) return;
        if (media.paused) publishPausedWebPresence(media);
        else publishWebPresence(media);
      },
      true,
    );
    for (const eventName of ["ended", "emptied"]) {
      document.addEventListener(
        eventName,
        (event) => {
          if (event.target !== activeWebMedia) return;
          activeWebMedia = null;
          clearPresence();
        },
        true,
      );
    }
  }

  bridge.on("mode", (payload) => {
    if (["web", "mpv"].includes(payload?.value)) {
      state.backend = payload.value;
      if (state.backend === "web") publishWebPresence(activeWebMedia);
      else clearPresence();
    }
  });
  const bridgeReady = bridge
    .status()
    .then((status) => {
      state.backend = status.backend || config.backend;
      state.startFullscreen = status.startFullscreen !== false;
    })
    .catch((error) => {
      console.warn("[Noktus] Native bridge initialization failed:", error);
    });

  const invoke = (method, ...args) => {
    if (!bridge || typeof bridge[method] !== "function") {
      return Promise.reject(new Error("Native MPV bridge is unavailable"));
    }
    return Promise.resolve(bridge[method](...args));
  };

  // Trickplay used to fail silently, which made "where are my thumbnails?" reports
  // impossible to triage. Every outcome is reported once per playback instead.
  let lastTrickplayReport = null;
  function resetTrickplayReport() {
    lastTrickplayReport = null;
  }
  function reportTrickplay(state, detail) {
    if (typeof bridge?.reportTrickplay !== "function") return;
    const message = String(detail || "");
    const line = `${state}|${message}`;
    if (line === lastTrickplayReport) return;
    lastTrickplayReport = line;
    invoke("reportTrickplay", { state, detail: message }).catch(() => {});
  }
  function describeError(error) {
    return error?.message || String(error);
  }
  bridge.on("shutdown", (payload) => {
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || !requestId) return;
    if (activeMpvPlayer) {
      activeMpvPlayer._prepareForShutdown(requestId).catch((error) => {
        console.warn("[Noktus] Playback shutdown failed:", error);
      });
    } else {
      invoke("shutdownReady", requestId).catch((error) => {
        console.warn("[Noktus] Could not acknowledge playback shutdown:", error);
      });
    }
  });
  if (typeof bridge.onPresenceSync === "function") {
    bridge.onPresenceSync(() => {
      if (state.backend === "web") publishWebPresence(activeWebMedia);
      else activeMpvPlayer?._publishPresence();
    });
  }
  installWebPresenceObserver();

  const mpvProfile = {
    Name: "Noktus Electron MPV",
    MaxStreamingBitrate: 140000000,
    MaxStaticBitrate: 140000000,
    MusicStreamingTranscodingBitrate: 1280000,
    TimelineOffsetSeconds: 5,
    TranscodingProfiles: [
      {
        Container: "ts",
        Type: "Video",
        Protocol: "hls",
        AudioCodec: "aac,mp3,ac3,opus,flac,vorbis",
        VideoCodec: "h264,mpeg4,mpeg2video",
        MaxAudioChannels: "8",
      },
    ],
    DirectPlayProfiles: [{ Type: "Video" }],
    ResponseProfiles: [],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
      { Format: "srt", Method: "External" },
      { Format: "srt", Method: "Embed" },
      { Format: "ass", Method: "External" },
      { Format: "ass", Method: "Embed" },
      { Format: "ssa", Method: "External" },
      { Format: "ssa", Method: "Embed" },
      { Format: "sub", Method: "External" },
      { Format: "sub", Method: "Embed" },
      { Format: "vtt", Method: "External" },
      { Format: "pgssub", Method: "Embed" },
      { Format: "pgs", Method: "Embed" },
      { Format: "dvdsub", Method: "Embed" },
      { Format: "dvbsub", Method: "Embed" },
    ],
  };

  function isEligibleVideo(item, options, playbackManager) {
    if (state.backend !== "mpv" || item?.MediaType !== "Video") return false;
    if (!Number.isFinite(item.RunTimeTicks) || item.RunTimeTicks <= 0 || item.IsLive)
      return false;
    if (["TvChannel", "LiveTvChannel", "LiveTvProgram"].includes(item.Type))
      return false;
    const recordingStatus = String(
      item.RecordingStatus || item.Status || "",
    ).toLowerCase();
    if (["inprogress", "recording"].includes(recordingStatus)) return false;
    if (playbackManager?.syncPlayEnabled || options?.syncPlay === true) return false;
    return true;
  }

  function relativeTrack(streams, jellyfinIndex, type) {
    if (!Number.isInteger(jellyfinIndex) || jellyfinIndex < 0) return 0;
    let relative = 1;
    for (const stream of streams || []) {
      if (stream.Type !== type || stream.IsExternal) continue;
      if (stream.Index === jellyfinIndex) return relative;
      relative += 1;
    }
    return 0;
  }

  function jellyfinTrackIndex(streams, mpvIndex, type) {
    if (mpvIndex === false || mpvIndex === "no" || mpvIndex == null) return -1;
    const wanted = Number(mpvIndex);
    if (!Number.isInteger(wanted) || wanted <= 0) return null;
    let relative = 0;
    for (const stream of streams || []) {
      if (stream.Type !== type || stream.IsExternal) continue;
      relative += 1;
      if (relative === wanted) return stream.Index;
    }
    return null;
  }

  function selectedTracks(options) {
    const source = options.mediaSource || {};
    const streams = source.MediaStreams || [];
    if (options.playMethod === "Transcode") {
      return {
        audioTrack: 1,
        externalAudioUrl: null,
        subtitleStreamIndex: -1,
        subtitleTracks: [],
      };
    }
    const audioIndex =
      options.selectedAudioStreamIndex ?? source.DefaultAudioStreamIndex ?? -1;
    const subtitleIndex =
      options.selectedSubtitleStreamIndex ?? source.DefaultSubtitleStreamIndex ?? -1;
    const audio = streams.find(
      (stream) => stream.Index === audioIndex && stream.Type === "Audio",
    );
    const absolute = (value) => {
      if (!value) return null;
      try {
        return new URL(value, options.url).href;
      } catch {
        return null;
      }
    };
    const subtitleTracks = streams.flatMap((stream) => {
      if (
        stream.Type !== "Subtitle" ||
        !Number.isInteger(stream.Index) ||
        stream.Index < 0
      ) {
        return [];
      }
      const external = stream.IsExternal || stream.DeliveryMethod === "External";
      const externalUrl = external ? absolute(stream.DeliveryUrl) : null;
      if (external && !externalUrl) return [];
      const title = String(
        stream.DisplayTitle ||
          stream.Title ||
          stream.Language ||
          `Subtitle ${stream.Index}`,
      );
      return [
        {
          jellyfinIndex: stream.Index,
          mpvTrack: external ? 0 : relativeTrack(streams, stream.Index, "Subtitle"),
          externalUrl,
          title,
          language: String(stream.Language || ""),
        },
      ];
    });
    return {
      audioTrack: audio?.IsExternal ? 0 : relativeTrack(streams, audioIndex, "Audio"),
      externalAudioUrl: audio?.IsExternal ? absolute(audio.DeliveryUrl) : null,
      subtitleStreamIndex: subtitleTracks.some(
        (track) => track.jellyfinIndex === subtitleIndex,
      )
        ? subtitleIndex
        : -1,
      subtitleTracks,
    };
  }

  function apiClientFor(item) {
    const connectionManager = window.ConnectionManager || window.connectionManager;
    let apiClient = null;
    if (connectionManager?.getApiClient) {
      try {
        apiClient = connectionManager.getApiClient(item?.ServerId || item);
      } catch {
        try {
          apiClient = connectionManager.getApiClient();
        } catch {
          apiClient = null;
        }
      }
    }
    return apiClient || window.ApiClient || null;
  }

  function apiClientValue(client, names) {
    for (const name of names) {
      try {
        const value = client?.[name];
        if (typeof value === "function") {
          const result = value.call(client);
          if (result != null && result !== "") return String(result);
        } else if (value != null && value !== "") {
          return String(value);
        }
      } catch {
        // A client getter is optional; continue with the standard fallback.
      }
    }
    return "";
  }

  function isWithinConfiguredServer(rawUrl) {
    try {
      const candidate = new URL(rawUrl);
      if (candidate.origin !== server.origin) return false;
      return (
        !basePath ||
        candidate.pathname === basePath ||
        candidate.pathname.startsWith(`${basePath}/`)
      );
    } catch {
      return false;
    }
  }

  function mpvPlaybackUrl(options) {
    const rawUrl = options?.url;
    if (typeof rawUrl !== "string" || !rawUrl) {
      throw new Error("Jellyfin did not provide a media URL");
    }
    if (isWithinConfiguredServer(rawUrl)) return rawUrl;

    let remoteUrl;
    try {
      remoteUrl = new URL(rawUrl);
    } catch {
      throw new Error("Jellyfin provided an invalid remote media URL");
    }
    if (!["http:", "https:"].includes(remoteUrl.protocol)) {
      throw new Error("Remote media must use HTTP or HTTPS");
    }

    const itemId = String(options.item?.Id || "");
    const mediaSource = options.mediaSource || {};
    const mediaSourceId = String(mediaSource.Id || "");
    if (
      String(mediaSource.Protocol || "").toLowerCase() !== "http" ||
      mediaSource.SupportsDirectStream !== true
    ) {
      throw new Error("The remote media source cannot be streamed through Jellyfin");
    }
    if (!itemId || !mediaSourceId) {
      throw new Error("The remote media source is missing its Jellyfin identifiers");
    }

    const apiClient = apiClientFor(options.item);
    const accessToken = apiClientValue(apiClient, ["accessToken"]);
    if (!accessToken) {
      throw new Error("The remote media source cannot be authenticated with Jellyfin");
    }

    const url = new URL(server.href);
    url.pathname = `${basePath}/Videos/${encodeURIComponent(itemId)}/stream`;
    url.search = "";
    url.hash = "";
    url.searchParams.set("static", "true");
    url.searchParams.set("MediaSourceId", mediaSourceId);
    url.searchParams.set("ApiKey", accessToken);
    if (mediaSource.LiveStreamId != null && mediaSource.LiveStreamId !== "") {
      url.searchParams.set("LiveStreamId", String(mediaSource.LiveStreamId));
    }
    return url.href;
  }

  function authorizationValue(value) {
    return encodeURIComponent(String(value)).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  function mediaBrowserAuthorization(apiClient) {
    const token = apiClientValue(apiClient, ["accessToken"]);
    if (!token) return "";
    const values = [
      ["Token", token],
      ["Client", config.appName || "Noktus"],
      ["Version", config.appVersion || "0.0.0"],
      ["Device", config.deviceName || "Electron"],
    ];
    const deviceId = apiClientValue(apiClient, ["deviceId", "getDeviceId"]);
    if (deviceId) values.push(["DeviceId", deviceId]);
    return `MediaBrowser ${values
      .map(([name, value]) => `${name}="${authorizationValue(value)}"`)
      .join(", ")}`;
  }

  function apiHeaders(apiClient, accept) {
    const headers = { Accept: accept };
    const authorization = mediaBrowserAuthorization(apiClient);
    if (authorization) headers.Authorization = authorization;
    return headers;
  }

  async function apiJson(apiClient, url) {
    if (typeof apiClient.getJSON === "function") {
      return apiClient.getJSON(url.href);
    }
    const response = await fetch(url.href, {
      headers: apiHeaders(apiClient, "application/json"),
    });
    if (!response.ok) throw new Error(`Jellyfin returned HTTP ${response.status}`);
    return response.json();
  }

  async function currentUserId(item) {
    const apiClient = apiClientFor(item);
    if (!apiClient) return "";
    for (const name of ["getCurrentUserId", "currentUserId", "userId"]) {
      try {
        const value = apiClient[name];
        const result =
          typeof value === "function" ? await value.call(apiClient) : value;
        if (result != null && result !== "") return String(result);
      } catch {
        // Jellyfin Web client versions expose different user ID accessors.
      }
    }
    return "";
  }

  function seriesTrackDescriptors(options) {
    const streams = options.mediaSource?.MediaStreams || [];
    return streams.flatMap((stream) => {
      if (
        !["Audio", "Subtitle"].includes(stream.Type) ||
        !Number.isInteger(stream.Index) ||
        stream.Index < 0
      ) {
        return [];
      }
      return [
        {
          index: stream.Index,
          type: stream.Type,
          language: String(stream.Language || ""),
          title: String(
            stream.DisplayTitle ||
              stream.Title ||
              stream.Language ||
              `${stream.Type} ${stream.Index}`,
          ),
          isDefault: stream.IsDefault === true,
          isForced: stream.IsForced === true,
          isHearingImpaired: stream.IsHearingImpaired === true,
          isCommentary: stream.IsCommentary === true,
          isExternal:
            stream.IsExternal === true || stream.DeliveryMethod === "External",
        },
      ];
    });
  }

  function buildSeriesTrackContext(options, userId, audioIndex, subtitleIndex) {
    const item = options.item;
    if (
      item?.Type !== "Episode" ||
      !item.SeriesId ||
      !userId ||
      options.playMethod === "Transcode"
    ) {
      return null;
    }
    return {
      userId,
      seriesId: String(item.SeriesId),
      seriesName: String(item.SeriesName || item.Name || "Series"),
      audioStreamIndex: Number(audioIndex),
      subtitleStreamIndex: Number(subtitleIndex),
      tracks: seriesTrackDescriptors(options),
    };
  }

  async function resolveSeriesTrackSelection(options) {
    const source = options.mediaSource || {};
    const defaults = {
      audioStreamIndex: Number(source.DefaultAudioStreamIndex ?? -1),
      subtitleStreamIndex: Number(source.DefaultSubtitleStreamIndex ?? -1),
      context: null,
    };
    if (typeof bridge.resolveSeriesTracks !== "function") return defaults;
    const userId = await currentUserId(options.item);
    const context = buildSeriesTrackContext(
      options,
      userId,
      defaults.audioStreamIndex,
      defaults.subtitleStreamIndex,
    );
    if (!context) {
      if (typeof bridge.clearSeriesTrackContext === "function") {
        await invoke("clearSeriesTrackContext").catch(() => {});
      }
      return defaults;
    }
    try {
      const resolution = await invoke("resolveSeriesTracks", context);
      const audioStreamIndex = Number(resolution?.audioStreamIndex);
      const subtitleStreamIndex = Number(resolution?.subtitleStreamIndex);
      const selected = {
        ...context,
        audioStreamIndex: Number.isInteger(audioStreamIndex)
          ? audioStreamIndex
          : defaults.audioStreamIndex,
        subtitleStreamIndex: Number.isInteger(subtitleStreamIndex)
          ? subtitleStreamIndex
          : defaults.subtitleStreamIndex,
      };
      return { ...selected, context: selected };
    } catch (error) {
      console.debug("[Noktus] Series track preferences unavailable:", error);
      return defaults;
    }
  }

  function normalizeMediaSegments(payload) {
    const items = Array.isArray(payload?.Items) ? payload.Items : [];
    return items
      .map((segment) => {
        const type = String(segment?.Type || "");
        const startTicks = Number(segment?.StartTicks ?? segment?.StartPositionTicks);
        const endTicks = Number(segment?.EndTicks ?? segment?.EndPositionTicks);
        if (
          !["Intro", "Outro"].includes(type) ||
          !Number.isFinite(startTicks) ||
          !Number.isFinite(endTicks) ||
          startTicks < 0 ||
          endTicks <= startTicks
        ) {
          return null;
        }
        return {
          type,
          startSeconds: startTicks / 10000000,
          endSeconds: endTicks / 10000000,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.startSeconds - right.startSeconds)
      .slice(0, 100);
  }

  async function fetchMediaSegments(item) {
    const itemId = String(item?.Id || "");
    if (!itemId) return [];

    const apiClient = apiClientFor(item);
    if (!apiClient) return [];

    const path = `MediaSegments/${encodeURIComponent(itemId)}`;
    const rawUrl =
      typeof apiClient.getUrl === "function"
        ? apiClient.getUrl(path)
        : new URL(`${basePath}/${path}`, server).href;
    const url = new URL(rawUrl, location.href);
    ["Intro", "Outro"].forEach((type) =>
      url.searchParams.append("includeSegmentTypes", type),
    );

    try {
      return normalizeMediaSegments(await apiJson(apiClient, url));
    } catch (error) {
      console.debug("[Noktus] MediaSegments unavailable:", error);
      return [];
    }
  }

  function normalizeTrickplayManifest(value, itemId, mediaSourceId, rejected = []) {
    const trickplay = value?.Trickplay;
    if (!trickplay || typeof trickplay !== "object") return null;

    // Jellyfin exposes Trickplay as media-source ID -> width -> metadata.
    // Older/test clients may already hand us the inner width dictionary, so
    // retain support for that shape while preferring the selected source.
    const topLevelEntries = Object.entries(trickplay);
    const isResolutionDictionary = topLevelEntries.some(
      ([, candidate]) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate.Width != null || candidate.Height != null),
    );
    let selectedMediaSourceId = mediaSourceId;
    let resolutionDictionary = trickplay;
    if (!isResolutionDictionary) {
      let selected = mediaSourceId ? trickplay[mediaSourceId] : null;
      if (!selected || typeof selected !== "object") {
        const fallback = topLevelEntries.find(
          ([, candidate]) => candidate && typeof candidate === "object",
        );
        if (!fallback) return null;
        selectedMediaSourceId = fallback[0];
        selected = fallback[1];
      }
      resolutionDictionary = selected;
    }

    const resolutions = Object.entries(resolutionDictionary)
      .map(([key, candidate]) => {
        const width = Number(candidate?.Width ?? key);
        const height = Number(candidate?.Height);
        const intervalMs = Number(candidate?.Interval);
        const thumbnailCount = Number(candidate?.ThumbnailCount);
        const tileWidth = Number(candidate?.TileWidth);
        const tileHeight = Number(candidate?.TileHeight);
        if (
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          !Number.isInteger(intervalMs) ||
          !Number.isInteger(thumbnailCount) ||
          !Number.isInteger(tileWidth) ||
          !Number.isInteger(tileHeight) ||
          width < 1 ||
          width > 1920 ||
          height < 1 ||
          height > 1920 ||
          intervalMs < 1 ||
          intervalMs > 60 * 60 * 1000 ||
          thumbnailCount < 1 ||
          thumbnailCount > 100000 ||
          tileWidth < 1 ||
          tileWidth > 20 ||
          tileHeight < 1 ||
          tileHeight > 20 ||
          width * height * 4 > TRICKPLAY_WINDOW_BYTES ||
          width * tileWidth * height * tileHeight * 4 > TRICKPLAY_MAX_TILE_BYTES
        ) {
          rejected.push(`${candidate?.Width ?? key}x${candidate?.Height ?? "?"}`);
          return null;
        }
        return {
          itemId,
          mediaSourceId: selectedMediaSourceId,
          width,
          height,
          intervalMs,
          thumbnailCount,
          tileWidth,
          tileHeight,
        };
      })
      .filter(Boolean)
      // Sharpest tier that still fits the window budget checked above.
      .sort((left, right) => right.width - left.width);
    return resolutions[0] || null;
  }

  async function fetchTrickplayManifest(item, mediaSource, rejected = []) {
    const itemId = String(item?.Id || "");
    if (!itemId) return null;
    const mediaSourceId = String(mediaSource?.Id || "");
    const apiClient = apiClientFor(item);
    if (!apiClient) return null;

    const manifest = normalizeTrickplayManifest(item, itemId, mediaSourceId, rejected);
    if (manifest) return { ...manifest, apiClient };

    const userId = await currentUserId(item);
    if (!userId) return null;
    // Both routes ignore `Fields` on newer servers and honour it on older ones, and
    // the `Users/...` form is deprecated, so try the current route first and fall back.
    const itemPaths = [
      `Items/${encodeURIComponent(itemId)}`,
      `Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}`,
    ];
    let lastError = null;
    for (const itemPath of itemPaths) {
      const rawUrl =
        typeof apiClient.getUrl === "function"
          ? apiClient.getUrl(itemPath)
          : new URL(`${basePath}/${itemPath}`, server).href;
      const url = new URL(rawUrl, location.href);
      url.searchParams.set("Fields", "Trickplay");
      if (itemPath.startsWith("Items/")) url.searchParams.set("userId", userId);
      let source;
      try {
        source = await apiJson(apiClient, url);
      } catch (error) {
        lastError = error;
        continue;
      }
      const found = normalizeTrickplayManifest(source, itemId, mediaSourceId, rejected);
      if (found) return { ...found, apiClient };
    }
    if (lastError) throw lastError;
    return null;
  }

  function trickplayWindow(manifest, seconds) {
    const bytesPerFrame = manifest.width * manifest.height * 4;
    const capacity = Math.max(1, Math.floor(TRICKPLAY_WINDOW_BYTES / bytesPerFrame));
    const count = Math.min(manifest.thumbnailCount, capacity);
    const requested = Math.max(
      0,
      Math.min(
        manifest.thumbnailCount - 1,
        Math.floor((Math.max(0, seconds) * 1000) / manifest.intervalMs),
      ),
    );
    const first = Math.max(
      0,
      Math.min(requested - Math.floor(count / 2), manifest.thumbnailCount - count),
    );
    return { first, count, requested };
  }

  function trickplayTileUrl(manifest, index) {
    const tilePath = `Videos/${encodeURIComponent(manifest.itemId)}/Trickplay/${manifest.width}/${index}.jpg`;
    const rawUrl =
      typeof manifest.apiClient.getUrl === "function"
        ? manifest.apiClient.getUrl(tilePath)
        : new URL(`${basePath}/${tilePath}`, server).href;
    const url = new URL(rawUrl, location.href);
    if (manifest.mediaSourceId) {
      url.searchParams.set("MediaSourceId", manifest.mediaSourceId);
    }
    return url;
  }

  async function fetchTrickplayTile(manifest, index) {
    const response = await fetch(trickplayTileUrl(manifest, index).href, {
      headers: apiHeaders(manifest.apiClient, "image/jpeg"),
    });
    if (!response.ok) {
      throw new Error(`Trickplay tile ${index} returned HTTP ${response.status}`);
    }
    return createImageBitmap(await response.blob());
  }

  function bgraFrame(context, bitmap, manifest, tileFrame) {
    const x = (tileFrame % manifest.tileWidth) * manifest.width;
    const y = Math.floor(tileFrame / manifest.tileWidth) * manifest.height;
    context.clearRect(0, 0, manifest.width, manifest.height);
    context.drawImage(
      bitmap,
      x,
      y,
      manifest.width,
      manifest.height,
      0,
      0,
      manifest.width,
      manifest.height,
    );
    const pixels = context.getImageData(0, 0, manifest.width, manifest.height).data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      pixels[offset] = pixels[offset + 2];
      pixels[offset + 2] = red;
    }
    return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }

  async function emitTrickplayWindow(manifest, seconds, isCurrent) {
    const window = trickplayWindow(manifest, seconds);
    const generation = await invoke("beginTrickplay", {
      count: window.count,
      intervalMs: manifest.intervalMs,
      width: manifest.width,
      height: manifest.height,
      first: window.first,
      total: manifest.thumbnailCount,
    });
    if (!generation) return null;

    const canvas = document.createElement("canvas");
    canvas.width = manifest.width;
    canvas.height = manifest.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      await invoke("abortTrickplay", generation).catch(() => {});
      throw new Error("Canvas pixel access is unavailable");
    }

    let buffered = [];
    let bufferedBytes = 0;
    const flush = async () => {
      if (!bufferedBytes) return;
      const chunk = new Uint8Array(bufferedBytes);
      let offset = 0;
      for (const frame of buffered) {
        chunk.set(frame, offset);
        offset += frame.byteLength;
      }
      buffered = [];
      bufferedBytes = 0;
      await invoke("appendTrickplay", generation, chunk.buffer);
    };
    const appendFrame = async (bytes) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const available = TRICKPLAY_CHUNK_BYTES - bufferedBytes;
        const length = Math.min(available, bytes.byteLength - offset);
        buffered.push(bytes.subarray(offset, offset + length));
        bufferedBytes += length;
        offset += length;
        if (bufferedBytes === TRICKPLAY_CHUNK_BYTES) await flush();
      }
    };

    try {
      const perTile = manifest.tileWidth * manifest.tileHeight;
      const last = window.first + window.count;
      const firstTile = Math.floor(window.first / perTile);
      const lastTile = Math.floor((last - 1) / perTile);
      for (let tileIndex = firstTile; tileIndex <= lastTile; tileIndex += 1) {
        if (!isCurrent()) throw new Error("Trickplay generation was cancelled");
        const bitmap = await fetchTrickplayTile(manifest, tileIndex);
        try {
          if (
            bitmap.width !== manifest.width * manifest.tileWidth ||
            bitmap.height !== manifest.height * manifest.tileHeight
          ) {
            throw new Error(`Trickplay tile ${tileIndex} has unexpected dimensions`);
          }
          const tileFirst = tileIndex * perTile;
          const from = Math.max(window.first, tileFirst);
          const to = Math.min(last, tileFirst + perTile);
          for (let frame = from; frame < to; frame += 1) {
            if (!isCurrent()) throw new Error("Trickplay generation was cancelled");
            const bytes = bgraFrame(context, bitmap, manifest, frame - tileFirst);
            await appendFrame(bytes);
          }
        } finally {
          if (typeof bitmap.close === "function") bitmap.close();
        }
      }
      await flush();
      if (!isCurrent()) throw new Error("Trickplay generation was cancelled");
      await invoke("commitTrickplay", generation);
      return window;
    } catch (error) {
      await invoke("abortTrickplay", generation).catch(() => {});
      throw error;
    }
  }

  function queueEntryIdentity(entry) {
    const item = entry?.Item || entry?.item || entry;
    return {
      playlistItemId: String(
        entry?.PlaylistItemId ||
          entry?.playlistItemId ||
          item?.PlaylistItemId ||
          item?.playlistItemId ||
          "",
      ),
      itemId: String(item?.Id || item?.id || ""),
    };
  }

  function navigationFromPlaylist(payload, options, currentIndex) {
    const playlist = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.Items)
        ? payload.Items
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
    if (playlist.length < 2) return { previous: false, next: false };

    if (
      Number.isInteger(currentIndex) &&
      currentIndex >= 0 &&
      currentIndex < playlist.length
    ) {
      return {
        previous: currentIndex > 0,
        next: currentIndex < playlist.length - 1,
      };
    }

    const currentPlaylistItemId = String(
      options?.playlistItemId ||
        options?.PlaylistItemId ||
        options?.item?.PlaylistItemId ||
        options?.item?.playlistItemId ||
        "",
    );
    let matches = [];
    if (currentPlaylistItemId) {
      matches = playlist
        .map((entry, index) => ({ ...queueEntryIdentity(entry), index }))
        .filter((entry) => entry.playlistItemId === currentPlaylistItemId);
    }

    if (matches.length !== 1) {
      const currentItemId = String(options?.item?.Id || "");
      if (!currentItemId) return { previous: false, next: false };
      matches = playlist
        .map((entry, index) => ({ ...queueEntryIdentity(entry), index }))
        .filter((entry) => entry.itemId === currentItemId);
    }
    if (matches.length !== 1) return { previous: false, next: false };

    const index = matches[0].index;
    return {
      previous: index > 0,
      next: index < playlist.length - 1,
    };
  }

  async function getNavigationState(playbackManager, player, options) {
    if (typeof playbackManager?.getPlaylist !== "function") {
      return { previous: false, next: false };
    }
    try {
      const playlist = await playbackManager.getPlaylist(player);
      const currentIndex =
        typeof playbackManager.getCurrentPlaylistIndex === "function"
          ? playbackManager.getCurrentPlaylistIndex(player)
          : null;
      return navigationFromPlaylist(playlist, options, currentIndex);
    } catch (error) {
      console.debug("[Noktus] Jellyfin playlist unavailable:", error);
      return { previous: false, next: false };
    }
  }

  function playbackTitle(options) {
    const item = options.item || {};
    const fallback = options.title || item.Name || "";
    if (item.Type !== "Episode" || !item.SeriesName) return fallback;

    const season = Number.isInteger(item.ParentIndexNumber)
      ? `S${String(item.ParentIndexNumber).padStart(2, "0")}`
      : "";
    const episode = Number.isInteger(item.IndexNumber)
      ? `E${String(item.IndexNumber).padStart(2, "0")}`
      : "";
    const episodeLabel = [season + episode, item.Name].filter(Boolean).join(" · ");
    return [item.SeriesName, episodeLabel].filter(Boolean).join(" — ");
  }

  function showMpvRecovery(item, reason, actions) {
    document.getElementById("jellyfin-dc-electron-recovery")?.remove();
    if (!document.body) return;

    const host = document.createElement("div");
    host.id = "jellyfin-dc-electron-recovery";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { position: fixed; inset: 0; z-index: 2147483647; display: grid;
          place-items: center; padding: 1.5rem; box-sizing: border-box;
          background: rgb(0 0 0 / 65%); font: 16px system-ui, sans-serif; }
        section { width: min(31rem, 100%); box-sizing: border-box; padding: 1.5rem;
          border: 1px solid rgb(255 255 255 / 16%); border-radius: .8rem;
          color: #fff; background: #202026; box-shadow: 0 1rem 4rem #000a; }
        h2 { margin: 0 0 .75rem; font-size: 1.35rem; }
        p { margin: .6rem 0; line-height: 1.45; overflow-wrap: anywhere; }
        #reason { color: #cfcfd6; font-size: .9rem; }
        #status { color: #ffb4ab; min-height: 1.3rem; }
        footer { display: flex; justify-content: flex-end; gap: .7rem; margin-top: 1rem; }
        button { border: 0; border-radius: .45rem; padding: .65rem .9rem;
          color: #fff; background: #45454f; font: inherit; cursor: pointer; }
        #retry, #web { background: #7f56d9; font-weight: 700; }
        button:disabled { cursor: wait; opacity: .65; }
      </style>
      <section role="dialog" aria-modal="true" aria-labelledby="title">
        <h2 id="title">MPV playback failed</h2>
        <p id="message"></p>
        <p id="reason"></p>
        <p id="status" role="alert"></p>
        <footer><button id="cancel">Cancel</button>
          <button id="browser">Browser</button>
          <button id="web">Play Here</button>
          <button id="retry">Retry MPV</button></footer>
      </section>`;

    const itemId = String(item?.Id || "");
    const serverId = String(item?.ServerId || "");
    const params = new URLSearchParams({ id: itemId });
    if (serverId) params.set("serverId", serverId);
    const itemUrl = `${server.origin}${basePath}/web/#/details?${params}`;
    const buttons = [...root.querySelectorAll("button")];
    const retry = root.getElementById("retry");
    const web = root.getElementById("web");
    const browser = root.getElementById("browser");
    const cancel = root.getElementById("cancel");
    const close = () => host.remove();
    let busy = false;
    root.getElementById("message").textContent =
      `MPV could not play ${String(item?.Name || "this item")}.`;
    root.getElementById("reason").textContent = String(reason).slice(0, 1000);
    web.disabled = !itemId || typeof actions.playHere !== "function";
    browser.disabled = !itemId || typeof actions.openBrowser !== "function";
    const run = async (button, label, failureMessage, action) => {
      if (busy) return;
      busy = true;
      buttons.forEach((candidate) => {
        candidate.disabled = true;
      });
      root.getElementById("status").textContent = label;
      try {
        await action(itemUrl);
        close();
      } catch (error) {
        busy = false;
        buttons.forEach((candidate) => {
          candidate.disabled = false;
        });
        web.disabled = !itemId || typeof actions.playHere !== "function";
        browser.disabled = !itemId || typeof actions.openBrowser !== "function";
        root.getElementById("reason").textContent = String(error).slice(0, 1000);
        root.getElementById("status").textContent = failureMessage;
        button.focus();
      }
    };
    retry.addEventListener("click", () =>
      run(
        retry,
        "Retrying MPV...",
        "MPV is still unavailable. Check its configured path or choose Play Here.",
        actions.retry,
      ),
    );
    web.addEventListener("click", () =>
      run(
        web,
        "Switching to Web playback...",
        "Could not switch to Web playback.",
        actions.playHere,
      ),
    );
    browser.addEventListener("click", () =>
      run(
        browser,
        "Opening the system browser...",
        "Could not open the system browser.",
        actions.openBrowser,
      ),
    );
    cancel.addEventListener("click", () =>
      run(
        cancel,
        "Stopping playback...",
        "Could not stop the failed playback cleanly.",
        actions.cancel,
      ),
    );
    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        run(
          cancel,
          "Stopping playback...",
          "Could not stop the failed playback cleanly.",
          actions.cancel,
        );
      }
    });
    document.body.append(host);
    retry.focus();
  }

  class JellyfinDcMpvPlayer {
    constructor(args) {
      this.events = args.events;
      this.appSettings = args.appSettings;
      this.playbackManager = args.playbackManager;
      this.type = "mediaplayer";
      this.id = "jellyfindcelectronmpvplayer";
      this.name = "Noktus Electron MPV";
      this.priority = -1;
      this.isLocalPlayer = true;
      this.isFetching = false;
      this.useFullSubtitleUrls = true;
      this._currentSrc = null;
      this._options = null;
      this._seriesTrackContext = null;
      this._seriesTrackPersistenceReady = false;
      this._currentTime = 0;
      this._duration = 0;
      this._paused = false;
      this._muted = false;
      this._rate = 1;
      this._fullscreen = false;
      this._volume = Math.round((this.appSettings.get("volume") || 1) * 100);
      this._failurePending = false;
      this._loadRequest = null;
      this._shutdownRequestId = null;
      this._playGeneration = 0;
      this._navigationTimer = null;
      this._navigation = { previous: false, next: false };
      this._trickplay = null;
      this._trickplaySupported = false;
      this._wireBridge();
      if (typeof this.events?.on === "function") {
        for (const eventName of [
          "playlistitemadd",
          "playlistitemremove",
          "playlistitemmove",
          "shufflequeuemodechange",
        ]) {
          this.events.on(this, eventName, () => this._scheduleNavigationRefresh());
        }
      }
    }

    _wireBridge() {
      bridge.on("loaded", () => {
        if (!this._currentSrc) return;
        this._seriesTrackPersistenceReady = true;
        this._paused = false;
        this.events.trigger(this, "playing");
        this._publishPresence();
        this._scheduleNavigationRefresh();
      });
      bridge.on("paused", (payload) => {
        const paused = Boolean(payload?.value);
        const changed = this._paused !== paused;
        this._paused = paused;
        this._publishPresence();
        if (changed) this.events.trigger(this, paused ? "pause" : "unpause");
      });
      bridge.on("position", (payload) => {
        this._currentTime = Number(payload?.value) * 1000;
        this.events.trigger(this, "timeupdate");
      });
      bridge.on("duration", (payload) => {
        this._duration = Number(payload?.value) * 1000;
      });
      bridge.on("volume", (payload) => {
        this._volume = Number(payload?.value);
        this.events.trigger(this, "volumechange");
      });
      bridge.on("muted", (payload) => {
        this._muted = Boolean(payload?.value);
        this.events.trigger(this, "volumechange");
      });
      bridge.on("rate", (payload) => {
        this._rate = Number(payload?.value);
      });
      bridge.on("fullscreen", (payload) => {
        const fullscreen = Boolean(payload?.value);
        if (this._fullscreen === fullscreen) return;
        this._fullscreen = fullscreen;
        this.events.trigger(this, "fullscreenchange");
      });
      bridge.on("audioTrack", (payload) =>
        this._syncNativeTrack("Audio", payload?.value),
      );
      bridge.on("subtitleTrack", (payload) =>
        this._syncNativeTrack("Subtitle", payload?.value, payload?.jellyfinIndex),
      );
      bridge.on("next", () => this._changeQueueItem("nextTrack"));
      bridge.on("previous", () => this._changeQueueItem("previousTrack"));
      bridge.on("trickplayNeed", (payload) => {
        const seconds = Number(payload?.seconds);
        if (Number.isFinite(seconds) && seconds >= 0) {
          this._requestTrickplay(seconds);
        }
      });
      bridge.on("ended", () => this._finish());
      bridge.on("quit", () => this._handleMpvQuit());
      bridge.on("failed", (payload) =>
        this._queueFailure(payload?.code, payload?.message),
      );
    }

    canPlayMediaType(mediaType) {
      return state.backend === "mpv" && mediaType === "Video";
    }
    canPlayItem(item, options) {
      return isEligibleVideo(item, options, this.playbackManager);
    }
    canPlayUrl() {
      return false;
    }
    supportsPlayMethod() {
      return true;
    }
    supports(feature) {
      return ["PlaybackRate", "SetAspectRatio"].includes(feature);
    }
    getDeviceProfile() {
      return Promise.resolve(mpvProfile);
    }

    async play(options) {
      activeMpvPlayer = this;
      this._options = options;
      this._currentSrc = options.url;
      this._currentTime = Number(options.playerStartPositionTicks || 0) / 10000;
      this._duration = Number(options.item?.RunTimeTicks || 0) / 10000;
      this.audioStreamIndex = options.mediaSource?.DefaultAudioStreamIndex ?? -1;
      this.subtitleStreamIndex = options.mediaSource?.DefaultSubtitleStreamIndex ?? -1;
      this._seriesTrackContext = null;
      this._seriesTrackPersistenceReady = false;
      this._failurePending = false;
      this._navigation = { previous: false, next: false };
      const playGeneration = ++this._playGeneration;
      const segmentsPromise = fetchMediaSegments(options.item);
      try {
        const seriesSelection = await resolveSeriesTrackSelection(options);
        if (
          this._options !== options ||
          this._playGeneration !== playGeneration ||
          !this._currentSrc
        ) {
          return;
        }
        this.audioStreamIndex = seriesSelection.audioStreamIndex;
        this.subtitleStreamIndex = seriesSelection.subtitleStreamIndex;
        this._seriesTrackContext = seriesSelection.context;
        const status = await invoke("status");
        this._fullscreen = status.startFullscreen ?? state.startFullscreen;
        this._trickplaySupported =
          status.presentation === "jellyfin" && status.provider !== "mpv.net";
        this._loadRequest = {
          url: mpvPlaybackUrl(options),
          startSeconds: this._currentTime / 1000,
          title: playbackTitle(options),
          fullscreen: this._fullscreen,
          ...selectedTracks({
            ...options,
            selectedAudioStreamIndex: this.audioStreamIndex,
            selectedSubtitleStreamIndex: this.subtitleStreamIndex,
          }),
        };
        await invoke("load", this._loadRequest);
        if (typeof bridge.beginTrickplay === "function") {
          if (this._trickplaySupported) {
            this._initializeTrickplay(
              options,
              playGeneration,
              this._currentTime / 1000,
            );
          } else if (status.provider === "mpv.net") {
            reportTrickplay(
              "unsupported",
              "mpv.net draws its own on-screen controller, so Noktus cannot add trickplay previews there.",
            );
          } else {
            reportTrickplay(
              "off",
              "Controls are set to your own MPV configuration, which keeps its own OSC and thumbnail scripts.",
            );
          }
        }
        this._scheduleNavigationRefresh(options, playGeneration);
        segmentsPromise
          .then((segments) => {
            if (
              this._options !== options ||
              this._playGeneration !== playGeneration ||
              !this._currentSrc ||
              this._failurePending
            ) {
              return;
            }
            if (typeof bridge.setSegments !== "function") return;
            return invoke("setSegments", segments);
          })
          .catch((error) => {
            console.debug("[Noktus] Could not pass MediaSegments to MPV:", error);
          });
      } catch (error) {
        this._queueFailure("unavailable", String(error));
      }
    }

    _finish() {
      if (!this._currentSrc) return;
      document.getElementById("jellyfin-dc-electron-recovery")?.remove();
      const src = this._currentSrc;
      this._currentSrc = null;
      this._options = null;
      this._seriesTrackContext = null;
      this._seriesTrackPersistenceReady = false;
      this._loadRequest = null;
      this._failurePending = false;
      if (this._navigationTimer) clearTimeout(this._navigationTimer);
      this._navigationTimer = null;
      this._navigation = { previous: false, next: false };
      this._trickplay = null;
      this._playGeneration += 1;
      if (activeMpvPlayer === this) activeMpvPlayer = null;
      clearPresence();
      if (typeof bridge.clearSeriesTrackContext === "function") {
        invoke("clearSeriesTrackContext").catch(() => {});
      }
      this.events.trigger(this, "stopped", [{ src }]);
    }

    _scheduleNavigationRefresh(
      options = this._options,
      playGeneration = this._playGeneration,
    ) {
      if (!options || !this._currentSrc) return;
      if (this._navigationTimer) clearTimeout(this._navigationTimer);
      this._navigationTimer = setTimeout(() => {
        this._navigationTimer = null;
        getNavigationState(this.playbackManager, this, options)
          .then((navigation) => {
            if (
              this._options !== options ||
              this._playGeneration !== playGeneration ||
              !this._currentSrc ||
              this._failurePending
            ) {
              return;
            }
            this._navigation = navigation;
            if (typeof bridge.setNavigation !== "function") return;
            return invoke("setNavigation", navigation);
          })
          .catch((error) => {
            console.debug("[Noktus] Could not pass playlist state to MPV:", error);
          });
      }, 0);
    }

    async _initializeTrickplay(options, playGeneration, seconds) {
      resetTrickplayReport();
      const trickplay = {
        playGeneration,
        manifest: null,
        window: null,
        wantSeconds: seconds,
        loading: false,
      };
      this._trickplay = trickplay;
      const rejected = [];
      try {
        const manifest = await fetchTrickplayManifest(
          options.item,
          options.mediaSource,
          rejected,
        );
        if (
          this._trickplay !== trickplay ||
          this._options !== options ||
          this._playGeneration !== playGeneration ||
          !this._currentSrc
        ) {
          return;
        }
        if (!manifest) {
          this._trickplay = null;
          reportTrickplay(
            rejected.length ? "error" : "no-manifest",
            rejected.length
              ? `Noktus cannot use the trickplay sizes this server offers (${rejected.join(", ")}).`
              : "This server has no trickplay images for the item that was played.",
          );
          return;
        }
        trickplay.manifest = manifest;
        this._pumpTrickplay(trickplay);
      } catch (error) {
        if (this._trickplay === trickplay) this._trickplay = null;
        reportTrickplay(
          "error",
          `Trickplay metadata is unavailable: ${describeError(error)}`,
        );
      }
    }

    _requestTrickplay(seconds) {
      const trickplay = this._trickplay;
      if (!trickplay) return;
      trickplay.wantSeconds = Math.max(0, Number(seconds) || 0);
      if (trickplay.manifest) this._pumpTrickplay(trickplay);
    }

    async _pumpTrickplay(trickplay) {
      if (trickplay.loading || !trickplay.manifest) return;
      trickplay.loading = true;
      const isCurrent = () =>
        this._trickplay === trickplay &&
        this._playGeneration === trickplay.playGeneration &&
        Boolean(this._currentSrc) &&
        !this._failurePending;
      try {
        while (isCurrent() && trickplay.wantSeconds != null) {
          const seconds = trickplay.wantSeconds;
          trickplay.wantSeconds = null;
          const requested = trickplayWindow(trickplay.manifest, seconds).requested;
          const current = trickplay.window;
          if (
            current &&
            requested >= current.first &&
            requested < current.first + current.count
          ) {
            continue;
          }
          try {
            const loaded = await emitTrickplayWindow(
              trickplay.manifest,
              seconds,
              isCurrent,
            );
            if (loaded && isCurrent()) {
              trickplay.window = loaded;
              const { thumbnailCount, width, height } = trickplay.manifest;
              reportTrickplay(
                "ready",
                `${thumbnailCount} previews at ${width}x${height}.`,
              );
            }
          } catch (error) {
            if (isCurrent()) {
              reportTrickplay(
                "error",
                `Could not load trickplay thumbnails: ${describeError(error)}`,
              );
            }
            break;
          }
        }
      } finally {
        trickplay.loading = false;
        if (isCurrent() && trickplay.wantSeconds != null) {
          Promise.resolve().then(() => this._pumpTrickplay(trickplay));
        }
      }
    }

    async _prepareForShutdown(requestId) {
      if (this._shutdownRequestId === requestId) return;
      this._shutdownRequestId = requestId;
      try {
        if (this._currentSrc) {
          try {
            if (typeof this.playbackManager?.stop === "function") {
              await this.playbackManager.stop(this);
            } else {
              await this.stop();
            }
          } catch {
            await this.stop();
          }
          if (this._currentSrc) await this.stop();
        }
      } finally {
        await invoke("shutdownReady", requestId).catch((error) => {
          console.warn("[Noktus] Could not acknowledge playback shutdown:", error);
        });
      }
    }

    _queueFailure(code, message) {
      if (!this._options || this._failurePending) return;
      this._failurePending = true;
      setTimeout(() => this._fail(code, message), 0);
    }

    _syncNativeTrack(type, mpvIndex, explicitJellyfinIndex) {
      if (!this._options) return;
      const streams = this._options.mediaSource?.MediaStreams || [];
      const index =
        type === "Subtitle" && Number.isInteger(explicitJellyfinIndex)
          ? explicitJellyfinIndex
          : jellyfinTrackIndex(streams, mpvIndex, type);
      if (index == null) return;
      const field = type === "Audio" ? "audioStreamIndex" : "subtitleStreamIndex";
      if (this[field] === index) return;
      this[field] = index;
      this._updateSeriesTrackContext();
      this.events.trigger(this, "timeupdate");
    }

    _updateSeriesTrackContext() {
      if (!this._seriesTrackContext) return;
      this._seriesTrackContext = {
        ...this._seriesTrackContext,
        audioStreamIndex: Number(this.audioStreamIndex ?? -1),
        subtitleStreamIndex: Number(this.subtitleStreamIndex ?? -1),
      };
      if (
        !this._seriesTrackPersistenceReady ||
        typeof bridge.rememberSeriesTracks !== "function"
      ) {
        return;
      }
      invoke("rememberSeriesTracks", this._seriesTrackContext).catch((error) =>
        console.debug("[Noktus] Could not remember series tracks:", error),
      );
    }

    _changeQueueItem(method) {
      const direction = method === "nextTrack" ? "next" : "previous";
      if (
        !this._currentSrc ||
        !this._navigation[direction] ||
        typeof this.playbackManager?.[method] !== "function"
      )
        return;
      Promise.resolve(this.playbackManager[method](this)).catch((error) => {
        console.warn(`[Noktus] Jellyfin ${method} failed:`, error);
      });
    }

    _handleMpvQuit() {
      if (!this._currentSrc) return;
      const stop =
        typeof this.playbackManager?.stop === "function"
          ? this.playbackManager.stop(this)
          : this.stop();
      Promise.resolve(stop)
        .catch(() => this.stop())
        .finally(() => invoke("focusApp").catch(() => {}));
    }

    _fail(code, message) {
      if (!this._options) return;
      const item = this._options.item;
      const reason = String(message || code || "Unknown MPV error");
      console.warn(`[Noktus] MPV failed (${code}):`, reason);
      invoke("stop").catch(() => {});
      setTimeout(
        () =>
          showMpvRecovery(item, reason, {
            retry: () => this._retryMpv(),
            playHere: (itemUrl) => this._playHere(itemUrl),
            openBrowser: (itemUrl) => this._openBrowser(itemUrl),
            cancel: () => this._cancelFailure(),
          }),
        0,
      );
    }

    async _retryMpv() {
      if (!this._loadRequest || !this._options)
        throw new Error("Playback is no longer active");
      this._failurePending = false;
      this._loadRequest.startSeconds = this._currentTime / 1000;
      await invoke("load", this._loadRequest);
      if (this._trickplaySupported) {
        this._initializeTrickplay(
          this._options,
          this._playGeneration,
          this._currentTime / 1000,
        );
      }
      if (typeof bridge.setNavigation === "function") {
        await invoke("setNavigation", this._navigation);
      }
    }

    async _playHere(itemUrl) {
      await invoke("stop").catch(() => {});
      this._finish();
      await invoke("playHere", itemUrl);
    }

    async _openBrowser(itemUrl) {
      await invoke("stop").catch(() => {});
      this._finish();
      await invoke("openExternal", itemUrl);
    }

    async _cancelFailure() {
      await invoke("stop").catch(() => {});
      this._finish();
    }

    stop() {
      const stopping = invoke("stop").catch((error) => {
        console.warn("[Noktus] Could not stop MPV cleanly:", error);
      });
      this._finish();
      return stopping.then(() => undefined);
    }
    destroy() {
      return this.stop();
    }
    pause() {
      this._paused = true;
      this._publishPresence();
      invoke("pause").catch(() => {});
    }
    resume() {
      this._paused = false;
      this._publishPresence();
      invoke("play").catch(() => {});
    }
    unpause() {
      this.resume();
    }
    paused() {
      return this._paused;
    }
    currentSrc() {
      return this._currentSrc;
    }
    currentTime(value) {
      if (value != null) {
        this._currentTime = Number(value);
        this._publishPresence();
        invoke("seek", this._currentTime / 1000).catch(() => {});
      }
      return this._currentTime;
    }

    _publishPresence() {
      if (!this._options || !this._currentSrc || state.backend !== "mpv") return;
      const title = playbackTitle(this._options);
      if (!title) return;
      publishPresence({
        title,
        mediaType: this._options.item?.MediaType === "Audio" ? "audio" : "video",
        playbackState: this._paused ? "paused" : "playing",
        positionSeconds: Math.max(0, Number(this._currentTime) / 1000 || 0),
      });
    }
    currentTimeAsync() {
      return Promise.resolve(this._currentTime);
    }
    duration() {
      return this._duration || null;
    }
    seekable() {
      return this._duration > 0;
    }
    getBufferedRanges() {
      return [];
    }

    setVolume(value, save = true) {
      this._volume = Math.max(0, Math.min(100, Number(value)));
      if (save) this.appSettings.set("volume", this._volume / 100);
      invoke("setVolume", this._volume).catch(() => {});
      if (save) this.events.trigger(this, "volumechange");
    }
    getVolume() {
      return this._volume;
    }
    volumeUp() {
      this.setVolume(this._volume + 2);
    }
    volumeDown() {
      this.setVolume(this._volume - 2);
    }
    setMute(value, trigger = true) {
      this._muted = Boolean(value);
      invoke("setMuted", this._muted).catch(() => {});
      if (trigger) this.events.trigger(this, "volumechange");
    }
    isMuted() {
      return this._muted;
    }
    setPlaybackRate(value) {
      this._rate = Number(value);
      invoke("setRate", this._rate).catch(() => {});
    }
    getPlaybackRate() {
      return this._rate;
    }
    getSupportedPlaybackRates() {
      return [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4].map((id) => ({
        id,
        name: `${id}x`,
      }));
    }

    setAudioStreamIndex(index) {
      const streams = this._options?.mediaSource?.MediaStreams || [];
      const selectedIndex = Number(index);
      const changed = this.audioStreamIndex !== selectedIndex;
      this.audioStreamIndex = selectedIndex;
      if (changed) this._updateSeriesTrackContext();
      invoke("setAudioTrack", relativeTrack(streams, index, "Audio")).catch(() => {});
    }
    getAudioStreamIndex() {
      return this.audioStreamIndex ?? -1;
    }
    setSubtitleStreamIndex(index) {
      const selectedIndex = Number(index);
      const changed = this.subtitleStreamIndex !== selectedIndex;
      this.subtitleStreamIndex = selectedIndex;
      if (changed) this._updateSeriesTrackContext();
      invoke("setSubtitleTrack", this.subtitleStreamIndex).catch(() => {});
    }
    getSubtitleStreamIndex() {
      return this.subtitleStreamIndex ?? -1;
    }
    setSecondarySubtitleStreamIndex() {}
    canSetAudioStreamIndex() {
      return true;
    }
    resetSubtitleOffset() {}
    setSubtitleOffset() {}
    getSubtitleOffset() {
      return 0;
    }
    enableShowingSubtitleOffset() {}
    disableShowingSubtitleOffset() {}
    isShowingSubtitleOffsetEnabled() {
      return false;
    }

    isFullscreen() {
      return this._fullscreen;
    }
    setFullscreen(value) {
      this._fullscreen = Boolean(value);
      invoke("setFullscreen", this._fullscreen).catch(() => {});
    }
    toggleFullscreen() {
      this.setFullscreen(!this._fullscreen);
    }
    getSupportedAspectRatios() {
      return [{ id: "auto", name: "Auto" }];
    }
    getAspectRatio() {
      return "auto";
    }
    setAspectRatio() {}
    setPictureInPictureEnabled() {}
    isPictureInPictureEnabled() {
      return false;
    }
    togglePictureInPicture() {}
    setAirPlayEnabled() {}
    isAirPlayEnabled() {
      return false;
    }
    toggleAirPlay() {}
    setBrightness() {}
    getBrightness() {
      return 100;
    }
    getStats() {
      return Promise.resolve({ categories: [] });
    }
  }

  window.jellyfinDcMpvPlayer = async () => {
    await bridgeReady;
    return JellyfinDcMpvPlayer;
  };

  const browserFeatures = new Set([
    "displaylanguage",
    "displaymode",
    "externallinks",
    "fullscreenchange",
    "htmlaudioautoplay",
    "htmlvideoautoplay",
    "remotecontrol",
    "remotevideo",
    "screensaver",
    "targetblank",
  ]);
  window.NativeShell = {
    getPlugins() {
      return ["jellyfinDcMpvPlayer"];
    },
    openUrl(url) {
      return bridge.openExternal(url);
    },
    AppHost: {
      init() {
        return bridgeReady.then(() => ({
          deviceName: config.deviceName,
          appName: config.appName,
          appVersion: config.appVersion,
        }));
      },
      getDefaultLayout() {
        return "desktop";
      },
      supports(command) {
        return browserFeatures.has(String(command).toLowerCase());
      },
      getDeviceProfile(profileBuilder) {
        return profileBuilder({});
      },
      getSyncProfile(profileBuilder) {
        return profileBuilder({});
      },
      appName() {
        return config.appName;
      },
      appVersion() {
        return config.appVersion;
      },
      deviceName() {
        return config.deviceName;
      },
    },
  };
  return {
    installed: true,
    nativeShell: typeof window.NativeShell,
    pluginFactory: typeof window.jellyfinDcMpvPlayer,
  };
}

module.exports = installPlayer;
