"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldGrantFullscreenPermission,
} = require("../build/main/fullscreen-permission");

const validRequest = {
  permission: "fullscreen",
  requestingUrl: "https://media.example/jellyfin/web/index.html#!/video",
  isMainFrame: true,
  requestingWebContentsId: 42,
  mainWindowWebContentsId: 42,
  serverUrl: "https://media.example/jellyfin",
};

test("allows fullscreen only for the active Jellyfin main frame", () => {
  assert.equal(shouldGrantFullscreenPermission(validRequest), true);
  assert.equal(
    shouldGrantFullscreenPermission({ ...validRequest, permission: "notifications" }),
    false,
  );
  assert.equal(
    shouldGrantFullscreenPermission({
      ...validRequest,
      requestingWebContentsId: 41,
    }),
    false,
  );
  assert.equal(
    shouldGrantFullscreenPermission({ ...validRequest, isMainFrame: false }),
    false,
  );
  assert.equal(
    shouldGrantFullscreenPermission({
      ...validRequest,
      requestingUrl: "https://media.example/another-app/video",
    }),
    false,
  );
  assert.equal(
    shouldGrantFullscreenPermission({
      ...validRequest,
      requestingUrl: "https://attacker.example/jellyfin/web/",
    }),
    false,
  );
});
