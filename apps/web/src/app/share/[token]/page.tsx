"use client"

/**
 * Watching a recording somebody shared.
 *
 * The one page in the product that works with no account. It has to: a share
 * link is meant to be readable by a colleague who has never heard of us, and a
 * sign-in wall in front of it would make the whole construction pointless. That
 * is not enforced anywhere in particular, it is simply true — src/proxy.ts sets
 * security headers and does not redirect, and nothing else gates a route — so
 * this file says it out loud, because "works signed out" is a property somebody
 * could remove by accident while adding an auth check elsewhere.
 *
 * The key is in the fragment, and the fragment stays here. Browsers never send
 * it in a request, `fetchShared` builds the API URL from the token alone, and
 * nothing on this page puts it in an error message, a toast, or a log. That is
 * the whole reason a link can carry a decryption key at all.
 *
 * Client-rendered from top to bottom, and for the same reason the recordings
 * page is: the server holds a blob it cannot open. There is nothing here for it
 * to render.
 *
 * Four ways this can go wrong and they are told apart on purpose, because they
 * are four different things for the person holding the link:
 *
 *  - the link arrived without its fragment, which is a paste that stopped at
 *    the `#` or a chat client that "cleaned" the URL,
 *  - the key is there but is not a key, which is a link that got truncated,
 *  - the key opens nothing, which is a key from a different share, and
 *  - the server will not serve it, which is expiry, revocation, a spent view
 *    limit or a link that never existed — and which of those it is, we do not
 *    say, because the endpoint answers all four identically so it cannot be
 *    used to find out which tokens are real.
 */

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  ArrowRightIcon,
  EyeIcon,
  KeyIcon,
  LinkBreakIcon,
  ShieldWarningIcon,
  WarningOctagonIcon,
} from "@phosphor-icons/react/dist/ssr"

import { RecordingPlayer } from "@/components/recording-player"
import { PageHeader, PageShell } from "@/components/shell/page-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ShareError,
  fetchShared,
  parseShareFragment,
  type ShareFailure,
  type SharedRecording,
} from "@/lib/recording/share"

type View =
  | { phase: "loading" }
  | { phase: "ready"; shared: SharedRecording }
  | { phase: "failed"; kind: ShareFailure; detail: string }

export default function SharedRecordingPage() {
  const params = useParams<{ token: string }>()
  const token = typeof params.token === "string" ? params.token : ""

  const [view, setView] = useState<View>({ phase: "loading" })

  /**
   * Which link has already been fetched.
   *
   * A ref rather than a state flag because it must survive React re-running the
   * effect — in development it runs twice by design — and every run of this
   * effect spends a view. On a link the owner limited to one, a second fetch is
   * the difference between the recipient seeing the recording and seeing a 404.
   */
  const fetched = useRef<string | null>(null)

  useEffect(() => {
    if (token === "" || fetched.current === token) return
    fetched.current = token

    let cancelled = false
    void (async () => {
      // Read once, here. The fragment is not put in state, not in a dependency
      // array, and not in anything that could end up serialised.
      const material = parseShareFragment(window.location.hash)
      if (material === null) {
        // Deliberately no fetch. The recording could not be opened even if it
        // arrived, and asking would burn a view off somebody else's limit.
        if (!cancelled) setView({ phase: "failed", kind: "missing-key", detail: "" })
        return
      }

      try {
        const shared = await fetchShared(token, material)
        if (!cancelled) setView({ phase: "ready", shared })
      } catch (error) {
        if (cancelled) return
        const kind = error instanceof ShareError ? error.kind : "server"
        const detail = error instanceof Error ? error.message : String(error)
        setView({ phase: "failed", kind, detail })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <PageShell>
      {/*
        React hoists this into the head. A share link is not something a search
        engine should be holding a copy of — and while a crawler could never
        decrypt one, since the key is in a fragment it does not follow, an
        indexed URL is still a URL somebody can find.
      */}
      <meta name="robots" content="noindex, nofollow" />

      <PageHeader
        eyebrow="Shared recording"
        title={
          view.phase === "ready"
            ? (view.shared.cast.header.label ?? "A shared recording")
            : "A shared recording"
        }
        description="A recorded terminal session. It was encrypted in the browser of the person who shared it, under a key that travels in the fragment of this link and is never sent to our server — so this page decrypts it here, and we have never seen what is in it."
      />

      {view.phase === "loading" && <LoadingState />}
      {view.phase === "failed" && <FailureState kind={view.kind} detail={view.detail} />}
      {view.phase === "ready" && <ReadyState shared={view.shared} />}

      <Card className="my-8">
        <CardContent className="flex flex-col gap-2">
          <p className="flex items-center gap-2 font-heading text-sm font-medium">
            <KeyIcon className="size-4 shrink-0 text-primary" />
            What this link is
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The link is the key. The part after the <code className="text-foreground">#</code> is
            the only thing that can decrypt this recording, browsers never send it to a server, and
            we do not have a copy. That also means anyone who has this link can watch this recording
            without an account and without signing in — forwarding it forwards the access. The
            person who shared it can revoke it or let it expire, and neither of those reaches a copy
            somebody has already watched or saved.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A recording is the terminal&rsquo;s output stream, which includes the shell echoing back
            what was typed. If it was on the screen it is in here.
          </p>
        </CardContent>
      </Card>
    </PageShell>
  )
}

/* ------------------------------------------------------------------ ready */

function ReadyState({ shared }: { shared: SharedRecording }) {
  const remaining = shared.maxViews === null ? null : Math.max(0, shared.maxViews - shared.views)

  return (
    <div className="mt-6 flex flex-col gap-4">
      <Card>
        <CardContent>
          {/*
            Keyed on nothing, because this component mounts once per page load
            with one transcript. The player is the same one the owner uses; it
            takes a cast that has already been decrypted, which is the only way
            it could work here — there is no vault in this tab.
          */}
          <RecordingPlayer cast={shared.cast} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <EyeIcon className="size-3.5 shrink-0" />
            <span className="text-foreground">
              {shared.views === 1 ? "First view" : `View ${shared.views}`}
            </span>
            {remaining !== null && (
              <span>
                {remaining === 0
                  ? "— this was the last one the link allows, and it will not open again."
                  : `— the link allows ${remaining} more, then it stops opening.`}
              </span>
            )}
            {Number.isNaN(shared.expiresAt) ? null : (
              <span>
                Expires {new Date(shared.expiresAt).toLocaleString()}
                {remaining === null ? ", and there is no view limit on it." : "."}
              </span>
            )}
          </p>
          <p>
            Reloading this page counts as another view. The recording is held in this tab only —
            closing it is enough to be rid of it, and nothing was written to this browser&rsquo;s
            storage.
          </p>
          {shared.cast.header.host && (
            <p>
              Recorded against <code className="text-foreground">{shared.cast.header.host}</code>,
              which is a name that was inside the ciphertext. Our server holds a blinded reference
              to it and has never held the name.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function LoadingState() {
  return (
    <Card className="mt-6" aria-busy="true" aria-label="Opening the shared recording">
      <CardContent className="flex flex-col gap-3 py-6">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-3 w-40" />
      </CardContent>
    </Card>
  )
}

/* --------------------------------------------------------------- failures */

/**
 * One block of copy per way this can fail, because the ways are not
 * interchangeable. "This link is missing its key" tells somebody to go back and
 * copy the whole thing; "this key does not open this recording" tells them the
 * link is for something else. Collapsing the two into "could not open" would
 * leave both of them with nothing to try.
 *
 * Each block also says what it cost, because these failures differ in that too:
 * a key that never decoded was caught before the fetch and spent nothing, while
 * a key that decoded and then did not open the blob was tried after the server
 * had already served — and served means counted. Saying nothing there would let
 * silence read as "nothing was spent", which the two neighbouring blocks say
 * outright.
 */
const FAILURES: Record<ShareFailure, { title: string; body: React.ReactNode }> = {
  "missing-key": {
    title: "This link is missing its key",
    body: (
      <>
        <p>
          There is nothing after the <code className="text-foreground">#</code> in the address bar,
          and that fragment is where the decryption key lives. Without it this recording cannot be
          opened by anyone — including us, which is the point of storing it this way.
        </p>
        <p>
          The usual cause is a paste that stopped early, or a chat client or ticket system that
          rewrote the URL and dropped the fragment. Ask whoever sent it for the whole link, and
          check that the copy you have ends with <code className="text-foreground">#k=</code>{" "}
          followed by a long string.
        </p>
      </>
    ),
  },
  "unreadable-key": {
    title: "The key in this link is incomplete",
    body: (
      <>
        <p>
          There is a key in the fragment, but it is not the right length to be one — which almost
          always means the link was cut short somewhere between being sent and being opened.
        </p>
        <p>
          Ask for it again, and paste it rather than retyping it. Nothing was requested from the
          server: a truncated key could not have opened the recording, so asking for it would only
          have spent one of the views the link allows.
        </p>
      </>
    ),
  },
  "wrong-key": {
    title: "This key does not open this recording",
    body: (
      <>
        <p>
          The link is intact and the server did serve the recording, but the key in the fragment
          does not decrypt it. That is what happens when two links get mixed up — the address of one
          share with the fragment of another.
        </p>
        <p>
          There is no way to recover from this end. Each share has its own key, generated for that
          share and never stored anywhere, so the only copy of the right one is in the link that was
          sent to you.
        </p>
        <p>
          The recording was served before the key was tried, so this attempt counted as one of the
          views the link allows and cannot be given back. Trying the same address again with another
          fragment spends another one, and enough attempts will use the link up — ask for the whole
          link before retrying.
        </p>
      </>
    ),
  },
  gone: {
    title: "This link does not open anything",
    body: (
      <>
        <p>
          It may have expired, it may have been revoked by the person who shared it, it may have
          been opened as many times as they allowed, or it may never have been a link at all. We do
          not say which: the endpoint answers the same way to all four so that it cannot be used to
          work out which links exist.
        </p>
        <p>
          If you were expecting this to work, ask for a new link. A share cannot be reissued — the
          key was generated in the sharer&rsquo;s browser and not kept — so what you would get is a
          fresh one.
        </p>
      </>
    ),
  },
  network: {
    title: "The recording could not be fetched",
    body: (
      <p>
        The request never reached the server, so this is a connection problem rather than anything
        about the link. Nothing was spent — a request that did not arrive did not count as a view.
        Try again.
      </p>
    ),
  },
  unauthorized: {
    title: "The recording could not be fetched",
    body: (
      <p>
        The server refused the request. A share link should not need an account, so this is
        unexpected rather than a rule being applied — try again, and if it keeps happening the link
        is worth reporting to whoever sent it.
      </p>
    ),
  },
  server: {
    title: "The recording could not be opened",
    body: (
      <p>
        The server answered, but not with something this page could use. That is a fault on our side
        rather than a problem with your link.
      </p>
    ),
  },
}

function FailureState({ kind, detail }: { kind: ShareFailure; detail: string }) {
  const copy = FAILURES[kind]
  const keyProblem = kind === "missing-key" || kind === "unreadable-key" || kind === "wrong-key"

  return (
    <>
      <Alert variant="destructive" className="mt-6">
        {keyProblem ? (
          <LinkBreakIcon />
        ) : kind === "gone" ? (
          <ShieldWarningIcon />
        ) : (
          <WarningOctagonIcon />
        )}
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>{copy.body}</AlertDescription>
      </Alert>

      {/*
        The server's own words, and only the server's. The fragment is never
        interpolated into anything on this page — an error report carrying the
        key would be a way of mailing it to us, which is exactly what putting it
        in a fragment was meant to prevent.
      */}
      {kind === "server" && detail !== "" && (
        <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
      )}

      <Card className="mt-4">
        <CardContent className="flex flex-col items-start gap-2">
          <p className="font-heading text-sm font-medium">What weirdvault is</p>
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            An SSH client that runs in a browser tab, with a vault the server cannot read. Session
            recordings are encrypted before they are stored, and a share link carries its own key so
            that sharing one does not mean handing over the account it came from.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-1">
            <Link href="/">
              Read what it does <ArrowRightIcon />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </>
  )
}
