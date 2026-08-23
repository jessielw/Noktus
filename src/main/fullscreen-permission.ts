import { isWithinServer } from "../shared/url-policy";

interface FullscreenPermissionContext {
  permission: string;
  requestingUrl: string;
  isMainFrame: boolean;
  requestingWebContentsId: number | null;
  mainWindowWebContentsId: number | null;
  serverUrl: string | null;
}

export function shouldGrantFullscreenPermission({
  permission,
  requestingUrl,
  isMainFrame,
  requestingWebContentsId,
  mainWindowWebContentsId,
  serverUrl,
}: FullscreenPermissionContext): boolean {
  return Boolean(
    permission === "fullscreen" &&
    isMainFrame &&
    requestingWebContentsId != null &&
    requestingWebContentsId === mainWindowWebContentsId &&
    serverUrl &&
    isWithinServer(requestingUrl, serverUrl),
  );
}
