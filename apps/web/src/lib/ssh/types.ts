export interface SftpEntry {
  name: string
  size: number
  mode: string
  modTime: number
  isDir: boolean
  isLink: boolean
}

export interface TransferResult {
  bytes: number
  ms: number
  mbPerSec: number
}

export interface SftpHandle {
  list(dir: string): Promise<{ path: string; entries: SftpEntry[] }>
  stat(path: string): Promise<SftpEntry>
  mkdir(path: string): Promise<boolean>
  remove(path: string): Promise<boolean>
  rename(from: string, to: string): Promise<boolean>
  chmod(path: string, mode: number): Promise<boolean>
  realpath(path: string): Promise<string>
  /** Push-based: the sink may return a promise, which applies backpressure. */
  download(
    path: string,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<TransferResult>
  /** Pull-based: return null to end the stream. */
  upload(path: string, next: () => Promise<Uint8Array | null>): Promise<TransferResult>
}

export interface SshSession {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  close(): void
  sftp(): Promise<SftpHandle>
  /** Appends a public key to the remote authorized_keys. */
  installKey(authorizedKeysLine: string): Promise<"installed" | "already-present">
  run(command: string): Promise<string>
  /** Streams a tar archive into `tar -x` remotely — the many-small-files path. */
  uploadTar(remoteDir: string, next: () => Promise<Uint8Array | null>): Promise<TransferResult>
  downloadTar(
    remotePath: string,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<TransferResult>
}

export interface HostKeyInfo {
  fingerprint: string
  type: string
  /** base64 of the marshaled key — what gets pinned. */
  key: string
  status: "unknown" | "match" | "mismatch"
}

/**
 * The key types the Go signer can build a public key for (signer.go).
 *
 * This is the *handshake* vocabulary, not the set of keys the app can hold end
 * to end — see CONNECTABLE_KEY_TYPES in lib/keys.ts for that, which is narrower
 * and says why.
 */
export type SshKeyType = "ed25519" | "ecdsa-p256" | "rsa"

export type SshAuth =
  | {
      kind: "publickey"
      keyType: SshKeyType
      publicKey: Uint8Array
      /** Signs with a key it cannot read. See lib/keys.ts. */
      sign: (data: Uint8Array, algorithm: string) => Promise<Uint8Array>
    }
  | { kind: "password"; password: string }

/**
 * What the WASM importer hands back for one parsed private key.
 *
 * `pkcs8` is the only plaintext private key material that ever crosses the
 * WASM boundary. The contract from keyparse.go is that the caller imports it
 * into WebCrypto non-extractably and zeroes the buffer immediately; lib/keys.ts
 * is the only place allowed to touch it.
 */
export interface ImportedKey {
  keyType: SshKeyType
  pkcs8: Uint8Array
  /** Raw public half in the shape the signer wants: 32 bytes, SPKI, or 0x04‖X‖Y. */
  publicKeyRaw: Uint8Array
  /** "ssh-ed25519 AAAA…\n" — the public key only; the core emits no comment. */
  authorizedKey: string
  fingerprint: string
  bits: number
}

/**
 * One host block from ~/.ssh/config, as far as the deliberately small parser in
 * sshconfig.go understands it. `identityFile` and `proxyJump` are reported so
 * the UI can say it cannot honour them, not so it can act on them.
 */
export interface ParsedConfigHost {
  alias: string
  hostname: string
  user: string
  port: number
  identityFile: string
  proxyJump: string
}

export interface ConnectConfig {
  relay: string
  host: string
  port: number
  user: string
  auth: SshAuth
  /** Pinned host key (base64). Omit only on first contact. */
  knownHostKey?: string
  cols?: number
  rows?: number
  onData?: (bytes: Uint8Array) => void
  onStatus?: (s: { phase: string; detail: string; ms: number }) => void
  onHostKey?: (k: HostKeyInfo) => void
  onClose?: (reason: string) => void
}

declare global {
  interface Window {
    webxtermSSH?: {
      connect(config: ConnectConfig): Promise<SshSession>
      /** Rejects with the parse error, including "a passphrase is required". */
      importKey(pem: string, passphrase?: string): Promise<ImportedKey>
      parseSSHConfig(text: string): Promise<ParsedConfigHost[]>
      version: string
    }
    // Provided by Go's wasm_exec.js.
    Go?: new () => {
      importObject: WebAssembly.Imports
      run(instance: WebAssembly.Instance): Promise<void>
    }
  }
}
