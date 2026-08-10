# weirdvault

**SSH from any browser tab.** A terminal, a file browser and an editor for your
servers — with nothing to install, on your machine or theirs.

Open a page. Make a key. You're in.

---

## Your keys never leave your browser

Every other web SSH tool connects to your server *for* you. Their gateway holds
your private key and can read everything you type.

weirdvault doesn't work that way. The connection is built inside your own
browser tab, and your key is created in a form the page itself cannot read. What
passes through our servers is sealed traffic we have no way to open.

Your servers, keys and saved commands are locked the same way, with your
password. We keep the result and cannot read it — which is also the deal: forget
the password and nobody, us included, can get it back. That's what the recovery
codes are for.

---

## What you get

**A real terminal.** Tabs, split panes, full colour, and a key bar that makes a
phone keyboard usable at 2am.

**Your files, right there.** Browse them beside the terminal on the same
connection. Drag a folder in to upload it. Open anything in a proper editor and
save straight back.

**Keys that follow you — or don't.** Keep one in your vault and every new
browser is ready to go. Or pin a key to a single device and leave it there.
Already have a key? Bring it.

**Your servers, everywhere.** Import the list you already have, and it tells you
plainly what it understood. Every reconnect checks the server is still the one
you trusted, and stops if it isn't.

**Even the machine with no address.** The box in your cupboard, the server on
hotel wifi, anything behind a router you can't open a port on. It reaches out to
you instead.

**Session recordings.** Capture what you did, play it back, or send someone a
link — one that expires, can be limited to a few views, and can be cut off. The
key that opens it never touches our servers.

**A record of what happened.** Every connection, key and device, in one place,
readable only by you.

---

## Honest about the limits

**Close the tab and the session ends.** The client *is* the tab — that's the
same property that stops us reading your work. Long jobs belong in tmux.

**No port forwarding, ever.** Doing it would mean asking you to install
something on your own machine. That's the one promise we won't trade.

**One account is one person.** No teams, no seats, no invitations to manage.

---

## Pricing

**Free** — everyday use. 1 GB of transfer a month, 30 days of history.

**Pro — $5 a month, flat.** 5 GB, a year of history, and session recording.

No per-seat pricing. No quantity to pick. Cancel whenever.

---

<sub>Prefer to run it on your own hardware? You can — and then even we can't see
which servers you connect to. See [`docs/`](docs/).</sub>
