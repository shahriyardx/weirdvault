/* eslint-disable no-undef */
/**
 * webxterm service worker.
 *
 * Two jobs:
 *
 * 1. Precache the app shell and the 6 MB WASM SSH core, so the download is paid
 *    once rather than on every visit.
 *
 * 2. Act as the sink for streaming downloads on browsers without the File
 *    System Access API (Firefox, Safari). The page opens a URL under
 *    /__download/, and this worker answers it with a ReadableStream that the
 *    page feeds chunk by chunk. That makes the browser write straight to disk,
 *    so a multi-gigabyte file never has to exist in a Blob in memory.
 */

const CACHE = "webxterm-v1";
const PRECACHE = ["/ssh.wasm", "/wasm_exec.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** id -> { stream, filename, size } awaiting a fetch to attach to. */
const pending = new Map();

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "download-start") return;

  const { id, filename, size } = data;
  const port = event.ports[0];

  // The page pushes chunks over the MessagePort; backpressure comes from the
  // stream's pull signal, relayed back as "pull" messages.
  const stream = new ReadableStream({
    start(controller) {
      port.onmessage = (e) => {
        if (e.data === null) {
          controller.close();
          port.onmessage = null;
        } else if (e.data instanceof Uint8Array || e.data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(e.data));
          port.postMessage("pull");
        } else if (e.data?.type === "abort") {
          controller.error(new Error(e.data.reason ?? "aborted"));
          port.onmessage = null;
        }
      };
      port.postMessage("pull");
    },
    cancel() {
      port.postMessage({ type: "cancelled" });
      port.onmessage = null;
    },
  });

  pending.set(id, { stream, filename, size });
  port.postMessage("ready");
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && url.pathname.startsWith("/__download/")) {
    const id = url.pathname.slice("/__download/".length);
    const entry = pending.get(id);
    if (!entry) return; // fall through to the network -> 404
    pending.delete(id);

    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.filename)}"`,
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    if (entry.size > 0) headers.set("Content-Length", String(entry.size));

    event.respondWith(new Response(entry.stream, { headers }));
    return;
  }

  // Cache-first for the immutable WASM assets; everything else goes to network.
  if (PRECACHE.includes(url.pathname) && url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit ?? fetch(event.request)),
    );
  }
});
