# TODO

Work that is understood and deliberately not done yet. Each entry says what the
current state is, what should replace it, and what triggers the change — an
entry with no trigger is a wish, not a task.

Kept short on purpose. A list of everything that could ever be improved is a
list nobody reads; what belongs here is work that will bite.

---

## Rotate the command signing key

**Now:** `AGENT_COMMAND_SECRET` signs every instruction the dashboard sends a
machine, and each identity holds its public half in `commandKeys` — a list,
already, so that this is not a config migration when it arrives. There is no way
to change it. Rotating today means re-enrolling every machine.

**What to do instead:** a `rotate-key` command, signed by a *current* key, that
appends a new one to `commandKeys`. Signed by the old key is what makes it safe:
the agent already knows how to check that, and the relay still cannot invent one.

**Trigger:** the first time a key has to change — a leak, or a deployment
splitting in two. "You cannot" is an unpleasant answer to give on that day.
