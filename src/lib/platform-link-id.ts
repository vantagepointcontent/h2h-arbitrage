/**
 * Creates a stable React key for a newly-added platform link.
 *
 * crypto.randomUUID() is only exposed in secure browser contexts. EdgeFinder
 * is also used through raw HTTP on a Tailscale IP, so keep a local fallback
 * rather than making the add-link control silently throw there.
 */
export function createPlatformLinkId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
    return randomUUID.call(globalThis.crypto);
  }

  return `platform-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
