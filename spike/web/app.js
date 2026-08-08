import {
  generateKey,
  loadKey,
  authorizedKeysLine,
  rawPublicKey,
  makeSigner,
  proveNonExtractable,
} from "./keys.js";

const $ = (id) => document.getElementById(id);
const log = (msg, cls = "") => {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = msg;
  $("log").prepend(d);
  // Surfaced for the automated Phase 0 check.
  (window.__trace ??= []).push({ msg, cls });
};

// ---------------------------------------------------------------- terminal
const term = new Terminal({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  theme: { background: "#0b0e14", foreground: "#c9d1d9" },
  cursorBlink: true,
  allowProposedApi: true,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($("term"));
fit.fit();
addEventListener("resize", () => {
  fit.fit();
  session?.resize(term.cols, term.rows);
});

// ---------------------------------------------------------------- wasm boot
let wasmReady = (async () => {
  const t0 = performance.now();
  const go = new Go();
  const res = await WebAssembly.instantiateStreaming(fetch("ssh.wasm"), go.importObject);
  go.run(res.instance); // runs forever; do not await
  const ms = performance.now() - t0;
  window.__wasmBootMs = ms;
  log(`wasm ready in ${ms.toFixed(0)} ms`, "ok");
})();

// ---------------------------------------------------------------- key setup
let keyPair = null;

async function useKey(pair) {
  keyPair = pair;
  const line = await authorizedKeysLine(pair);
  $("pubkey").textContent = line;
  window.__pubkey = line;

  const proof = await proveNonExtractable(pair);
  $("proof").innerHTML = proof.ok
    ? `<span class="ok">✓ private key is non-extractable</span><br><span class="dim">${proof.detail}</span>`
    : `<span class="bad">✗ ${proof.detail}</span>`;
  window.__nonExtractable = proof.ok;
  log(proof.ok ? "private key is non-extractable" : `NOT non-extractable: ${proof.detail}`,
      proof.ok ? "ok" : "bad");

  $("connect").disabled = false;
}

$("gen").onclick = async () => {
  try {
    await useKey(await generateKey());
    log("generated Ed25519 keypair via WebCrypto", "ok");
  } catch (e) {
    log(`key generation failed: ${e.message}`, "bad");
  }
};

$("copy").onclick = () => navigator.clipboard?.writeText($("pubkey").textContent);

// Reuse a previously generated key so a reload doesn't need re-authorizing.
loadKey().then((p) => p && useKey(p).then(() => log("restored key from IndexedDB", "dim")));

// ---------------------------------------------------------------- connect
let session = null;
let sftp = null;
let dataHooks = new Set();
window.__bytesIn = 0;
window.__benchMode = false;

async function connect() {
  await wasmReady;
  const host = $("host").value.trim();
  const port = parseInt($("port").value, 10);
  const user = $("user").value.trim();

  const relay = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}` +
                `/ws?host=${encodeURIComponent(host)}&port=${port}`;

  term.clear();
  log(`connecting to ${user}@${host}:${port}`, "dim");
  const t0 = performance.now();

  try {
    session = await webxtermSSH.connect({
      relay,
      host,
      port,
      user,
      cols: term.cols,
      rows: term.rows,
      auth: {
        kind: "publickey",
        keyType: "ed25519",
        publicKey: await rawPublicKey(keyPair),
        sign: makeSigner(keyPair),
      },
      onData: (bytes) => {
        window.__bytesIn += bytes.length;
        for (const h of dataHooks) h(bytes);
        // Benchmark mode skips rendering so throughput measures the SSH core
        // (relay + WASM decrypt), not xterm.js paint speed.
        if (!window.__benchMode) term.write(bytes);
      },
      onStatus: (s) => log(`${s.phase}: ${s.detail} (${s.ms.toFixed(1)} ms)`, "dim"),
      onHostKey: (k) => log(`host key ${k.type} ${k.fingerprint}`, "dim"),
      onClose: (reason) => {
        log(`closed: ${reason}`, "dim");
        session = null;
        $("connect").disabled = false;
        $("disconnect").disabled = true;
        window.__connected = false;
      },
    });

    // The file explorer rides the same SSH connection, so it opens right
    // alongside the shell rather than as a separate login.
    sftp = await session.sftp();
    window.__sftpReady = true;

    const ms = performance.now() - t0;
    window.__connectMs = ms;
    window.__connected = true;
    log(`AUTHENTICATED in ${ms.toFixed(0)} ms — WebCrypto signer accepted by sshd`, "ok");

    $("connect").disabled = true;
    $("disconnect").disabled = false;
    term.focus();
  } catch (e) {
    window.__connectError = String(e.message ?? e);
    log(`connect failed: ${e.message ?? e}`, "bad");
  }
}

$("connect").onclick = connect;
$("disconnect").onclick = () => session?.close();

term.onData((d) => session?.write(d));

const heapNow = () => performance.memory?.usedJSHeapSize ?? 0;

/**
 * Heap size after giving the collector a chance to run. Requires Chromium
 * launched with --js-flags=--expose-gc; without it this still works, just
 * noisier.
 */
async function settledHeap() {
  for (let i = 0; i < 3; i++) {
    window.gc?.();
    await new Promise((r) => setTimeout(r, 60));
  }
  return heapNow();
}

// Hooks for the automated Phase 0 verification.
window.__api = {
  connect,
  generate: async () => useKey(await generateKey()),
  send: (s) => session?.write(s),

  screen: () =>
    term.buffer.active
      ? Array.from({ length: term.buffer.active.length }, (_, i) =>
          term.buffer.active.getLine(i)?.translateToString(true) ?? "",
        ).join("\n")
      : "",

  /** Round-trip time for one character to echo back from the remote PTY. */
  echoLatency: () =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const h = () => {
        dataHooks.delete(h);
        resolve(performance.now() - t0);
      };
      dataHooks.add(h);
      session.write("x");
    }),

  // ------------------------------------------------------------ sftp
  sftpList: (dir) => sftp.list(dir),
  sftpStat: (p) => sftp.stat(p),
  sftpRemove: (p) => sftp.remove(p),

  /**
   * Stream a synthetic file up from a real Blob, exactly as a drag-dropped
   * File would arrive: read from the stream, hand chunks to WASM, never hold
   * the whole thing.
   *
   * Reports *retained* heap after a forced GC, not peak. Peak measures
   * allocation rate and GC timing; retained answers the only question that
   * matters — are we still holding the file when the transfer is done?
   */
  sftpUpload: async (remotePath, sizeMB) => {
    const chunk = new Uint8Array(1048576).fill(65);
    let blob = new Blob(Array.from({ length: sizeMB }, () => chunk));
    let reader = blob.stream().getReader();

    const base = await settledHeap();
    let peak = base;
    const next = async () => {
      const { value, done } = await reader.read();
      peak = Math.max(peak, heapNow());
      return done ? null : value;
    };

    const res = await sftp.upload(remotePath, next);
    blob = reader = null;
    const retained = (await settledHeap()) - base;

    return { ...res, retainedMB: retained / 1048576, peakMB: (peak - base) / 1048576 };
  },

  /** Stream a file down, discarding bytes, to measure the wire not the disk. */
  sftpDownload: async (remotePath) => {
    let bytes = 0;
    const base = await settledHeap();
    let peak = base;

    const res = await sftp.download(remotePath, (buf) => {
      bytes += buf.length;
      peak = Math.max(peak, heapNow());
    });
    const retained = (await settledHeap()) - base;

    return {
      ...res,
      received: bytes,
      retainedMB: retained / 1048576,
      peakMB: (peak - base) / 1048576,
    };
  },

  /** Bytes/sec of a bulk transfer, measured at the WASM boundary. */
  throughput: (command, expectBytes, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      window.__benchMode = true;
      const start = window.__bytesIn;
      let t0 = null;
      const deadline = setTimeout(() => {
        dataHooks.delete(h);
        window.__benchMode = false;
        reject(new Error("throughput test timed out"));
      }, timeoutMs);

      const h = () => {
        t0 ??= performance.now();
        const got = window.__bytesIn - start;
        if (got >= expectBytes) {
          const ms = performance.now() - t0;
          clearTimeout(deadline);
          dataHooks.delete(h);
          window.__benchMode = false;
          resolve({ bytes: got, ms, mbPerSec: got / 1048576 / (ms / 1000) });
        }
      };
      dataHooks.add(h);
      session.write(command + "\n");
    }),
};
