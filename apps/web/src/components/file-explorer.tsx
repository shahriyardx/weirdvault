"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ArrowClockwiseIcon,
  ArrowUpIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
      <div className="border-border flex items-center gap-0.5 border-b px-1.5 py-1.5">
        <IconAction label="Up a directory" onClick={() => void refresh(join(cwd, ".."))}>
          <ArrowUpIcon />
        </IconAction>
        <IconAction label="Refresh" onClick={() => void refresh()}>
          <ArrowClockwiseIcon />
        </IconAction>

        <span className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-[11px]">
          {busy ? "Loading…" : cwd}
        </span>

        <IconAction
          label={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          active={showHidden}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <EyeIcon /> : <EyeSlashIcon />}
        </IconAction>
        <IconAction label="Upload files" onClick={() => inputRef.current?.click()}>
          <UploadSimpleIcon />
        </IconAction>
        <IconAction label="Upload folder" onClick={() => dirInputRef.current?.click()}>
          <FolderIcon />
        </IconAction>
        <IconAction
          label="New folder"
          onClick={() =>
            void mutate(async () => {
              const name = prompt("New folder name");
              if (name) await sftp.mkdir(join(cwd, name));
            })
          }
        >
          <FolderPlusIcon />
        </IconAction>
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
        // @ts-expect-error non-standard but supported everywhere that matters
        webkitdirectory=""
        onChange={(e) => e.target.files && void doUpload(itemsFromInput(e.target.files))}
      />

      {error && (
        <div className="border-border bg-destructive/10 text-destructive border-b px-2 py-1.5 text-[11px]">
          {error}
        </div>
      )}

      {/* listing */}
      <ScrollArea className="min-h-0 flex-1">
        <div className={dragging ? "bg-primary/10" : undefined}>
          {dragging && (
            <p className="text-primary px-2 py-3 text-center text-[11px]">
              Drop files or folders to upload to {cwd}
            </p>
          )}
          {visible.map((entry) => (
            <div
              key={entry.name}
              onDoubleClick={() =>
                entry.isDir ? void refresh(join(cwd, entry.name)) : onEdit(join(cwd, entry.name))
              }
              className="hover:bg-accent/60 group flex items-center gap-2 px-2 py-[3px] text-[12px]"
            >
              {entry.isDir ? (
                <FolderIcon weight="fill" className="text-primary size-3.5 shrink-0" />
              ) : (
                <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!entry.isDir && (
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {fmtSize(entry.size)}
                </span>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                    aria-label={`Actions for ${entry.name}`}
                  >
                    <DotsThreeIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {!entry.isDir && (
                    <>
                      <DropdownMenuItem onSelect={() => onEdit(join(cwd, entry.name))}>
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void doDownload(entry)}>
                        Download
                      </DropdownMenuItem>
                    </>
                  )}
                  {entry.isDir && (
                    <DropdownMenuItem onSelect={() => onOpenTerminalAt?.(join(cwd, entry.name))}>
                      Open terminal here
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() => {
                      const to = prompt("Rename to", entry.name);
                      if (to) void mutate(() => sftp.rename(join(cwd, entry.name), join(cwd, to)));
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      const mode = prompt("New mode (octal)", "644");
                      if (mode) void mutate(() => sftp.chmod(join(cwd, entry.name), parseInt(mode, 8)));
                    }}
                  >
                    Change permissions
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      if (confirm(`Delete ${entry.name}? This cannot be undone.`)) {
                        void mutate(() => sftp.remove(join(cwd, entry.name)));
                      }
                    }}
                  >
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
          {visible.length === 0 && !busy && (
            <p className="text-muted-foreground px-2 py-3 text-[11px]">Empty directory.</p>
          )}
        </div>
      </ScrollArea>

      {/* transfer queue */}
      {transfers.length > 0 && (
        <div className="border-border max-h-40 overflow-y-auto border-t">
          {transfers.map((t) => (
            <div key={t.id} className="px-2 py-1.5 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{t.kind === "upload" ? "↑" : "↓"}</span>
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {t.state === "running" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hover:text-destructive size-5"
                    aria-label="Cancel transfer"
                    onClick={() => {
                      t.controller.abort();
                      patch(t.id, { state: "cancelled" });
                    }}
                  >
                    <XIcon />
                  </Button>
                ) : (
                  <span
                    className={
                      t.state === "complete"
                        ? "text-success"
                        : t.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }
                  >
                    {t.state}
                  </span>
                )}
              </div>
              {t.state === "running" && (
                <Progress
                  value={t.total ? Math.min(100, (t.done / t.total) * 100) : 0}
                  className="mt-1 h-[3px]"
                />
              )}
              {t.detail && (
                <p className="text-muted-foreground mt-0.5 truncate text-[10px]">{t.detail}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {!supportsFileSystemAccess() && (
        <p className="border-border text-muted-foreground border-t px-2 py-1 text-[10px]">
          Downloads stream via service worker in this browser.
        </p>
      )}
    </div>
  );
}

/** A compact toolbar button with a tooltip, so the icons stay legible. */
function IconAction({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          aria-label={label}
          className={active ? "text-primary size-7" : "size-7"}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
