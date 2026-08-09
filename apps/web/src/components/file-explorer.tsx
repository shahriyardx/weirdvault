"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  ArrowClockwiseIcon,
  ArrowUpIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LockKeyIcon,
  PencilSimpleIcon,
  TerminalWindowIcon,
  TextAaIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react/dist/ssr";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/**
 * One entry in a row's menu, described rather than rendered.
 *
 * The literal "separator" instead of a tagged object because that is all a
 * separator is — the alternative was `{ kind: "separator" }` and a discriminant
 * on every real item to go with it, which is more type than the idea deserves.
 */
type EntryAction =
  | "separator"
  | {
      label: string;
      icon: ReactNode;
      destructive?: boolean;
      run: () => void;
    };

/**
 * A question this component is waiting on an answer to.
 *
 * These were `window.prompt` and `window.confirm` — which work, and are wrong
 * here for reasons beyond looking out of place. A native prompt is a modal on
 * the whole browser, so it blocks the event loop while an SFTP transfer is
 * running in the same tab; it cannot be styled, so a destructive action gets
 * the same chrome as a rename; on mobile Safari it is a system sheet with no
 * relation to the app; and it is trivially suppressed — a user who has ticked
 * "prevent this page from creating additional dialogs" loses rename, chmod and
 * new-folder with no error and no clue why.
 */
type Ask =
  | { kind: "rename"; entry: SftpEntry }
  | { kind: "chmod"; entry: SftpEntry }
  | { kind: "mkdir" }
  | { kind: "delete"; entry: SftpEntry };

/** The wording for each question that takes a typed answer. */
const ASK_FIELDS: Record<
  "rename" | "chmod" | "mkdir",
  { title: string; label: string; submit: string; placeholder?: string; hint?: string }
> = {
  rename: { title: "Rename", label: "New name", submit: "Rename" },
  chmod: {
    title: "Change permissions",
    label: "Mode",
    submit: "Apply",
    placeholder: "644",
    hint: "Octal, as chmod takes it: 644 for a file, 755 for a directory or a script.",
  },
  mkdir: {
    title: "New folder",
    label: "Folder name",
    submit: "Create",
    placeholder: "deploy",
  },
};

/**
 * One directory listing, with no React in it.
 *
 * This lives outside the component because both callers — the mount effect
 * and the navigation handler — want the same two round trips but own the
 * spinner differently, and because a fetch that touches no state is the only
 * kind an effect can start without forcing a second render before the first
 * has painted.
 */
async function readDir(
  sftp: SftpHandle,
  dir: string,
): Promise<{ cwd: string; entries: SftpEntry[] }> {
  const listing = await sftp.list(dir);
  // Resolve to an absolute path so ".." navigation stays sane.
  const cwd = await sftp.realpath(listing.path);
  return { cwd, entries: listing.entries };
}

export function FileExplorer({ sftp, session, onEdit, onOpenTerminalAt }: Props) {
  const [cwd, setCwd] = useState<string>(".");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  /** The open dialog, and what has been typed into it so far. */
  const [ask, setAsk] = useState<Ask | null>(null);
  const [answer, setAnswer] = useState("");

  function openAsk(next: Ask, initial = "") {
    setAsk(next);
    setAnswer(initial);
  }

  /**
   * Navigating, from a click. The spinner is raised here rather than inside
   * `readDir` because a user who asked for a directory should see something
   * happen on the same tick as the click, and an event handler is the one
   * place where a synchronous state write is unambiguously right.
   */
  const refresh = useCallback(
    async (dir = cwd) => {
      setBusy(true);
      setError(null);
      try {
        const listing = await readDir(sftp, dir);
        setCwd(listing.cwd);
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
    // A new connection always opens at the remote home directory, so `busy`
    // starts true: the component genuinely mounts into a listing that is
    // already in flight, and saying so costs no extra render.
    let cancelled = false;
    readDir(sftp, ".").then(
      (listing) => {
        if (cancelled) return;
        setCwd(listing.cwd);
        setEntries(listing.entries);
        setBusy(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(String((e as Error).message ?? e));
        setBusy(false);
      },
    );
    // The connection can be torn down mid-listing — closing the last session
    // while the home directory is still being read is the ordinary case — and
    // the answer that arrives afterwards belongs to nobody.
    return () => {
      cancelled = true;
    };
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

  /**
   * Whether the typed answer could work — not whether the host will accept it.
   *
   * A mode has to parse as octal before it is worth sending: `parseInt("hello",
   * 8)` is NaN, and chmod'ing a file to NaN used to be one keystroke away. A
   * name has to be a name rather than a path, because rename and mkdir here both
   * join it onto the current directory, and a "/" in it would silently write
   * somewhere else.
   */
  const trimmedAnswer = answer.trim();
  const answerIsUsable =
    ask === null || ask.kind === "delete"
      ? false
      : ask.kind === "chmod"
        ? /^[0-7]{3,4}$/.test(trimmedAnswer)
        : trimmedAnswer.length > 0 && !trimmedAnswer.includes("/");

  function submitAsk() {
    if (!ask) return;
    const current = ask;
    setAsk(null);

    switch (current.kind) {
      case "rename":
        void mutate(() =>
          sftp.rename(join(cwd, current.entry.name), join(cwd, trimmedAnswer)),
        );
        return;
      case "chmod":
        void mutate(() =>
          sftp.chmod(join(cwd, current.entry.name), parseInt(trimmedAnswer, 8)),
        );
        return;
      case "mkdir":
        void mutate(() => sftp.mkdir(join(cwd, trimmedAnswer)));
        return;
      case "delete":
        void mutate(() => sftp.remove(join(cwd, current.entry.name)));
        return;
    }
  }

  const visible = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  /**
   * What you can do to one entry, as data rather than as markup.
   *
   * There are two menus on every row now — the ⋯ button and the right-click —
   * and they have to offer the same things. Radix gives dropdowns and context
   * menus separate item components, so the only way to keep one list is to
   * describe the actions once and render them through whichever set of
   * components is asking. Two hand-written copies would have diverged the first
   * time somebody added an action to one of them.
   */
  function actionsFor(entry: SftpEntry): EntryAction[] {
    const path = join(cwd, entry.name);
    const actions: EntryAction[] = [];

    if (entry.isDir) {
      actions.push({
        label: "Open",
        icon: <FolderOpenIcon />,
        run: () => void refresh(path),
      });
      if (onOpenTerminalAt) {
        actions.push({
          label: "Open terminal here",
          icon: <TerminalWindowIcon />,
          run: () => onOpenTerminalAt(path),
        });
      }
    } else {
      actions.push({ label: "Edit", icon: <PencilSimpleIcon />, run: () => onEdit(path) });
      actions.push({
        label: "Download",
        icon: <DownloadSimpleIcon />,
        run: () => void doDownload(entry),
      });
    }

    actions.push("separator");
    actions.push({
      label: "Rename",
      icon: <TextAaIcon />,
      run: () => openAsk({ kind: "rename", entry }, entry.name),
    });
    actions.push({
      label: "Copy path",
      icon: <CopyIcon />,
      run: () => {
        void navigator.clipboard.writeText(path).catch(() => {
          setError("The clipboard was refused. Copy the path from the breadcrumb instead.");
        });
      },
    });
    actions.push({
      label: "Change permissions",
      icon: <LockKeyIcon />,
      run: () => openAsk({ kind: "chmod", entry }, "644"),
    });
    actions.push("separator");
    actions.push({
      label: "Delete",
      icon: <TrashIcon />,
      destructive: true,
      run: () => openAsk({ kind: "delete", entry }),
    });

    return actions;
  }

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
        <IconAction label="New folder" onClick={() => openAsk({ kind: "mkdir" })}>
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
          {visible.map((entry) => {
            const actions = actionsFor(entry);
            return (
              <ContextMenu key={entry.name}>
                <ContextMenuTrigger asChild>
                  <div
                    onDoubleClick={() =>
                      entry.isDir
                        ? void refresh(join(cwd, entry.name))
                        : onEdit(join(cwd, entry.name))
                    }
                    className="hover:bg-accent/60 group flex items-center gap-2 px-2 py-[3px] text-[12px] data-[state=open]:bg-accent/60"
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

                    {/* The ⋯ button stays. Right-click is the faster route once
                        you know it is there, and nothing announces that it is —
                        a menu reachable only by right-click is invisible on a
                        touch screen and to anyone who has never tried. */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                          aria-label={`Actions for ${entry.name}`}
                          // Without this the double-click handler on the row
                          // fires too, and opening the menu also opens the file.
                          onDoubleClick={(e) => e.stopPropagation()}
                        >
                          <DotsThreeIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {actions.map((action, i) =>
                          action === "separator" ? (
                            <DropdownMenuSeparator key={`sep-${i}`} />
                          ) : (
                            <DropdownMenuItem
                              key={action.label}
                              variant={action.destructive ? "destructive" : undefined}
                              onSelect={action.run}
                            >
                              {action.icon}
                              {action.label}
                            </DropdownMenuItem>
                          ),
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </ContextMenuTrigger>

                <ContextMenuContent className="w-48">
                  {actions.map((action, i) =>
                    action === "separator" ? (
                      <ContextMenuSeparator key={`sep-${i}`} />
                    ) : (
                      <ContextMenuItem
                        key={action.label}
                        variant={action.destructive ? "destructive" : undefined}
                        onSelect={action.run}
                      >
                        {action.icon}
                        {action.label}
                      </ContextMenuItem>
                    ),
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
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

      {/* One dialog for every question that takes a typed answer, rather than
          three nearly identical ones. They differ in their wording and in what
          they do with the string, and both of those are data. */}
      <Dialog
        open={ask !== null && ask.kind !== "delete"}
        onOpenChange={(open) => !open && setAsk(null)}
      >
        <DialogContent className="sm:max-w-sm">
          {ask && ask.kind !== "delete" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitAsk();
              }}
            >
              <DialogHeader>
                <DialogTitle>{ASK_FIELDS[ask.kind].title}</DialogTitle>
                <DialogDescription>
                  {ask.kind === "mkdir" ? cwd : join(cwd, ask.entry.name)}
                </DialogDescription>
              </DialogHeader>

              <div className="my-4 space-y-1.5">
                <Label htmlFor="file-explorer-answer">{ASK_FIELDS[ask.kind].label}</Label>
                <Input
                  id="file-explorer-answer"
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode={ask.kind === "chmod" ? "numeric" : "text"}
                  placeholder={ASK_FIELDS[ask.kind].placeholder}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
                {ASK_FIELDS[ask.kind].hint && (
                  <p className="text-muted-foreground text-[11px]">
                    {ASK_FIELDS[ask.kind].hint}
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setAsk(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!answerIsUsable}>
                  {ASK_FIELDS[ask.kind].submit}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={ask?.kind === "delete"}
        onOpenChange={(open) => !open && setAsk(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {ask?.kind === "delete" ? ask.entry.name : "this"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ask?.kind === "delete" && ask.entry.isDir
                ? "This removes the directory on the remote host. It does not go to a trash folder and cannot be undone."
                : "This removes the file on the remote host. It does not go to a trash folder and cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault();
                submitAsk();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
