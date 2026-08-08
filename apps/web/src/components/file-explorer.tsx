"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { downloadFile, supportsFileSystemAccess } from "@/lib/transfers/download";
import {
  chooseStrategy,
  itemsFromDataTransfer,
  itemsFromInput,
  upload,
  type UploadItem,
} from "@/lib/transfers/upload";
import type { SftpEntry, SftpHandle, SshSession } from "@/lib/ssh/types";

export interface Transfer {
  id: string;
  kind: "upload" | "download";
  label: string;
  done: number;
  total: number;
  state: "running" | "complete" | "failed" | "cancelled";
  detail?: string;
  controller: AbortController;
}

interface Props {
  sftp: SftpHandle;
  session: SshSession;
  onEdit: (path: string) => void;
  onOpenTerminalAt?: (dir: string) => void;
}

export function FileExplorer({ sftp, session, onEdit, onOpenTerminalAt }: Props) {
  const [cwd, setCwd] = useState<string>(".");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(
    async (dir = cwd) => {
      setBusy(true);
      setError(null);
      try {
        const listing = await sftp.list(dir);
        // Resolve to an absolute path so ".." navigation stays sane.
        const real = await sftp.realpath(listing.path);
        setCwd(real);
        setEntries(listing.entries);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [sftp, cwd],
  );

  useEffect(() => {
    void refresh(".");
    // Only on mount / when the connection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftp]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  function track(kind: Transfer["kind"], label: string, total: number): Transfer {
    const t: Transfer = {
      id: crypto.randomUUID(),
      kind,
      label,
      done: 0,
      total,
      state: "running",
      controller: new AbortController(),
    };
    setTransfers((prev) => [t, ...prev].slice(0, 8));
    return t;
  }

  const patch = (id: string, fields: Partial<Transfer>) =>
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...fields } : t)));

  async function doDownload(entry: SftpEntry) {
    const path = join(cwd, entry.name);
    const t = track("download", entry.name, entry.size);
    try {
      const { strategy } = await downloadFile(sftp, path, entry.size, {
        signal: t.controller.signal,
        onProgress: (bytes) => patch(t.id, { done: bytes }),
      });
      patch(t.id, { state: "complete", done: entry.size, detail: strategy });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      patch(t.id, { state: msg === "cancelled" ? "cancelled" : "failed", detail: msg });
    }
  }

  async function doUpload(items: UploadItem[]) {
    if (items.length === 0) return;
    const total = items.reduce((n, i) => n + i.file.size, 0);
    const label = items.length === 1 ? items[0].path : `${items.length} files`;
    const t = track("upload", label, total);
    try {
      const { strategy } = await upload(session, sftp, cwd, items, {
        signal: t.controller.signal,
        onProgress: (done, _total, current) => patch(t.id, { done, detail: current }),
      });
      patch(t.id, { state: "complete", done: total, detail: `via ${strategy}` });
      await refresh();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      patch(t.id, { state: msg === "cancelled" ? "cancelled" : "failed", detail: msg });
    }
  }

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        void doUpload(await itemsFromDataTransfer(e.dataTransfer));
      }}
    >
      {/* path bar */}
      <div className="flex items-center gap-1.5 border-b border-[#232a38] px-2 py-1.5">
        <button onClick={() => void refresh(join(cwd, ".."))} className="icon-btn" title="Up">
          ↑
        </button>
        <button onClick={() => void refresh()} className="icon-btn" title="Refresh">
          ⟳
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#7d8798]">
          {busy ? "…" : cwd}
        </span>
        <button
          onClick={() => setShowHidden((v) => !v)}
          className={`icon-btn ${showHidden ? "text-[#6aa9ff]" : ""}`}
          title="Toggle hidden files"
        >
          ⌘
        </button>
        <button onClick={() => inputRef.current?.click()} className="icon-btn" title="Upload files">
          ⬆
        </button>
        <button
          onClick={() => dirInputRef.current?.click()}
          className="icon-btn"
          title="Upload folder"
        >
          📁
        </button>
        <button
          onClick={() =>
            void mutate(async () => {
              const name = prompt("New folder name");
              if (name) await sftp.mkdir(join(cwd, name));
            })
          }
          className="icon-btn"
          title="New folder"
        >
          +
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => e.target.files && void doUpload(itemsFromInput(e.target.files))}
      />
      <input
        ref={dirInputRef}
        type="file"
        hidden
        // @ts-expect-error non-standard but universally supported
        webkitdirectory=""
        onChange={(e) => e.target.files && void doUpload(itemsFromInput(e.target.files))}
      />

      {error && (
        <div className="border-b border-[#232a38] bg-[#2a1519] px-2 py-1.5 text-[11px] text-[#ff6b6b]">
          {error}
        </div>
      )}

      {/* listing */}
      <div className={`min-h-0 flex-1 overflow-y-auto ${dragging ? "bg-[#16233a]" : ""}`}>
        {dragging && (
          <div className="px-2 py-3 text-center text-[11px] text-[#6aa9ff]">
            Drop files or folders to upload to {cwd}
          </div>
        )}
        {visible.map((entry) => (
          <div
            key={entry.name}
            onDoubleClick={() =>
              entry.isDir ? void refresh(join(cwd, entry.name)) : onEdit(join(cwd, entry.name))
            }
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, entry });
            }}
            className="flex cursor-default items-center gap-2 px-2 py-[3px] text-[12px] hover:bg-[#1b2230]"
          >
            <span className="w-4 shrink-0 text-center">{entry.isDir ? "📁" : "📄"}</span>
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {!entry.isDir && (
              <span className="shrink-0 text-[10px] text-[#7d8798]">{fmtSize(entry.size)}</span>
            )}
          </div>
        ))}
        {visible.length === 0 && !busy && (
          <p className="px-2 py-3 text-[11px] text-[#7d8798]">Empty directory.</p>
        )}
      </div>

      {/* transfer queue */}
      {transfers.length > 0 && (
        <div className="max-h-40 overflow-y-auto border-t border-[#232a38]">
          {transfers.map((t) => (
            <div key={t.id} className="px-2 py-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span>{t.kind === "upload" ? "⬆" : "⬇"}</span>
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {t.state === "running" ? (
                  <button
                    onClick={() => {
                      t.controller.abort();
                      patch(t.id, { state: "cancelled" });
                    }}
                    className="text-[#7d8798] hover:text-[#ff6b6b]"
                  >
                    ✕
                  </button>
                ) : (
                  <span
                    className={
                      t.state === "complete"
                        ? "text-[#46d47f]"
                        : t.state === "failed"
                          ? "text-[#ff6b6b]"
                          : "text-[#7d8798]"
                    }
                  >
                    {t.state}
                  </span>
                )}
              </div>
              {t.state === "running" && (
                <div className="mt-1 h-[3px] overflow-hidden rounded bg-[#232a38]">
                  <div
                    className="h-full bg-[#6aa9ff] transition-[width]"
                    style={{ width: `${t.total ? Math.min(100, (t.done / t.total) * 100) : 0}%` }}
                  />
                </div>
              )}
              {t.detail && (
                <p className="mt-0.5 truncate text-[10px] text-[#7d8798]">{t.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* context menu */}
      {menu && (
        <div
          className="fixed z-50 min-w-40 rounded-md border border-[#232a38] bg-[#131822] py-1 text-[12px] shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {!menu.entry.isDir && (
            <>
              <MenuItem onClick={() => { onEdit(join(cwd, menu.entry.name)); setMenu(null); }}>
                Edit
              </MenuItem>
              <MenuItem onClick={() => { void doDownload(menu.entry); setMenu(null); }}>
                Download
              </MenuItem>
            </>
          )}
          {menu.entry.isDir && (
            <MenuItem
              onClick={() => {
                onOpenTerminalAt?.(join(cwd, menu.entry.name));
                setMenu(null);
              }}
            >
              Open terminal here
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              const to = prompt("Rename to", menu.entry.name);
              if (to) void mutate(() => sftp.rename(join(cwd, menu.entry.name), join(cwd, to)));
              setMenu(null);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            onClick={() => {
              const mode = prompt("New mode (octal)", "644");
              if (mode) void mutate(() => sftp.chmod(join(cwd, menu.entry.name), parseInt(mode, 8)));
              setMenu(null);
            }}
          >
            Change permissions
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              if (confirm(`Delete ${menu.entry.name}? This cannot be undone.`)) {
                void mutate(() => sftp.remove(join(cwd, menu.entry.name)));
              }
              setMenu(null);
            }}
          >
            Delete
          </MenuItem>
        </div>
      )}

      {!supportsFileSystemAccess() && (
        <p className="border-t border-[#232a38] px-2 py-1 text-[10px] text-[#7d8798]">
          Downloads stream via service worker in this browser.
        </p>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left hover:bg-[#1b2230] ${
        danger ? "text-[#ff6b6b]" : ""
      }`}
    >
      {children}
    </button>
  );
}

function join(dir: string, name: string): string {
  if (name === "..") {
    const trimmed = dir.replace(/\/+$/, "");
    const i = trimmed.lastIndexOf("/");
    if (i <= 0) return i === 0 ? "/" : ".";
    return trimmed.slice(0, i);
  }
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function fmtSize(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export { chooseStrategy };
