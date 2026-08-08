"use client";

import { useEffect, useRef, useState } from "react";

import type { SftpHandle } from "@/lib/ssh/types";

/**
 * Remote file editing.
 *
 * Opens a file over SFTP, edits it in Monaco, writes it back on save. This is
 * the "VS Code Remote without installing VS Code" piece — the reason to keep
 * the file explorer attached to every session rather than treating it as a
 * separate transfer tool.
 *
 * Monaco is imported dynamically so its ~2 MB never lands in the initial
 * bundle; a user who only wants a terminal pays nothing for it.
 */

const TEXT_LIMIT = 2 * 1024 * 1024;

interface Props {
  sftp: SftpHandle;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function RemoteEditor({ sftp, path, onClose, onSaved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{
    getValue(): string;
    dispose(): void;
    onDidChangeModelContent(cb: () => void): void;
  } | null>(null);

  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      // Read the whole file: an editor needs it all anyway, and the limit
      // keeps someone from opening a 4 GB log and wedging the tab.
      const stat = await sftp.stat(path);
      if (stat.size > TEXT_LIMIT) {
        throw new Error(
          `${path} is ${(stat.size / 1048576).toFixed(1)} MB — too large to edit. ` +
            `Download it instead.`,
        );
      }

      const chunks: Uint8Array[] = [];
      await sftp.download(path, (c) => {
        chunks.push(c.slice());
      });
      const bytes = concat(chunks);

      // Refuse binaries rather than corrupting them on save: a NUL byte in the
      // first block is the same heuristic git uses.
      if (bytes.subarray(0, 8000).includes(0)) {
        throw new Error(`${path} looks like a binary file.`);
      }
      const text = new TextDecoder().decode(bytes);

      // The editor-only build plus Monarch highlighting for the basic
      // languages. The full `monaco-editor` entry pulls in language services
      // that need web workers, and IntelliSense over a remote file without its
      // dependency tree would be confidently wrong anyway — highlighting is
      // the part that carries real value here.
      // Subpaths go through monaco's exports map, which rewrites "./*" to
      // "./esm/vs/*" — so the esm/vs prefix must be left off.
      const monaco = await import("monaco-editor/editor/editor.api");
      await import("monaco-editor/basic-languages/monaco.contribution");
      if (disposed || !hostRef.current) return;

      const editor = monaco.editor.create(hostRef.current, {
        value: text,
        language: languageFor(path),
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        scrollBeyondLastLine: false,
      });
      editor.onDidChangeModelContent(() => setDirty(true));
      editorRef.current = editor;

      // Monaco 0.56 uses the EditContext API rather than a hidden textarea, so
      // there is no stable element for a test to type into. Expose the
      // instance in development, as the terminal does.
      if (process.env.NODE_ENV === "development") {
        (window as unknown as { __webxtermEditor?: unknown }).__webxtermEditor = editor;
      }

      cleanup = () => editor.dispose();
      setState("ready");
    })().catch((e) => {
      if (disposed) return;
      setError(String((e as Error).message ?? e));
      setState("error");
    });

    return () => {
      disposed = true;
      cleanup();
      editorRef.current = null;
    };
  }, [sftp, path]);

  async function save() {
    if (!editorRef.current) return;
    setState("saving");
    setError(null);
    try {
      const bytes = new TextEncoder().encode(editorRef.current.getValue());
      let sent = false;
      await sftp.upload(path, async () => {
        if (sent) return null;
        sent = true;
        return bytes;
      });
      setDirty(false);
      setState("ready");
      onSaved?.();
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setState("ready");
    }
  }

  // Ctrl/Cmd-S saves, as it would in any editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="bg-terminal flex h-full flex-col">
      <div className="border-border flex items-center gap-3 border-b px-3 py-2">
        <span className="truncate text-xs">
          {path}
          {dirty && <span className="text-warning ml-1.5">●</span>}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={save}
            disabled={!dirty || state !== "ready"}
            className="border-border bg-secondary hover:bg-accent rounded-sm border px-2.5 py-1 text-xs disabled:opacity-40"
          >
            {state === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onClose}
            className="border-border hover:bg-accent rounded-sm border px-2.5 py-1 text-xs"
          >
            Close
          </button>
        </div>
      </div>

      {error && <div className="bg-destructive/10 text-destructive px-3 py-2 text-xs">{error}</div>}
      {state === "loading" && (
        <div className="text-muted-foreground p-3 text-xs">Loading {path}…</div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function languageFor(path: string): string {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";

  const byName: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    "docker-compose.yml": "yaml",
  };
  if (byName[name.toLowerCase()]) return byName[name.toLowerCase()];

  const byExt: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", yml: "yaml", yaml: "yaml", toml: "ini",
    conf: "ini", ini: "ini", sh: "shell", bash: "shell", zsh: "shell",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
    sql: "sql", html: "html", css: "css", scss: "scss", xml: "xml",
    log: "plaintext", env: "ini",
  };
  return byExt[ext] ?? "plaintext";
}
