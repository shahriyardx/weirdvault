export interface SftpEntry {
  name: string;
  size: number;
  mode: string;
  modTime: number;
  isDir: boolean;
  isLink: boolean;
}

export interface TransferResult {
  bytes: number;
  ms: number;
  mbPerSec: number;
}

export interface SftpHandle {
  list(dir: string): Promise<{ path: string; entries: SftpEntry[] }>;
  stat(path: string): Promise<SftpEntry>;
  mkdir(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  rename(from: string, to: string): Promise<boolean>;
  chmod(path: string, mode: number): Promise<boolean>;
  realpath(path: string): Promise<string>;
  /** Push-based: the sink may return a promise, which applies backpressure. */
  download(
    path: string,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<TransferResult>;
  /** Pull-based: return null to end the stream. */
  upload(
    path: string,
    next: () => Promise<Uint8Array | null>,
  ): Promise<TransferResult>;
}

export interface SshSession {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  sftp(): Promise<SftpHandle>;
  /** Appends a public key to the remote authorized_keys. */
  installKey(authorizedKeysLine: string): Promise<"installed" | "already-present">;
  run(command: string): Promise<string>;
  /** Streams a tar archive into `tar -x` remotely — the many-small-files path. */
  uploadTar(remoteDir: string, next: () => Promise<Uint8Array | null>): Promise<TransferResult>;
  downloadTar(
    remotePath: string,
    onChunk: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<TransferResult>;
}

export interface HostKeyInfo {
  fingerprint: string;
  type: string;
  /** base64 of the marshaled key — what gets pinned. */
  key: string;
  status: "unknown" | "match" | "mismatch";
}

export type SshAuth =
  | {
      kind: "publickey";
      keyType: "ed25519" | "ecdsa-p256" | "rsa";
      publicKey: Uint8Array;
      /** Signs with a key it cannot read. See lib/keys.ts. */
      sign: (data: Uint8Array, algorithm: string) => Promise<Uint8Array>;
    }
  | { kind: "password"; password: string };

export interface ConnectConfig {
  relay: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** Pinned host key (base64). Omit only on first contact. */
  knownHostKey?: string;
  cols?: number;
  rows?: number;
  onData?: (bytes: Uint8Array) => void;
  onStatus?: (s: { phase: string; detail: string; ms: number }) => void;
  onHostKey?: (k: HostKeyInfo) => void;
  onClose?: (reason: string) => void;
}

declare global {
  interface Window {
    webxtermSSH?: {
      connect(config: ConnectConfig): Promise<SshSession>;
      version: string;
    };
    // Provided by Go's wasm_exec.js.
    Go?: new () => {
      importObject: WebAssembly.Imports;
      run(instance: WebAssembly.Instance): Promise<void>;
    };
  }
}
