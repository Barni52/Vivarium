# Spec — the `chat` session type

**Status:** build-ready. Assembled from wayfinder map
[#1](https://github.com/Barni52/vivarium/issues/1) and its fifteen resolved tickets; this document
is the destination artifact and supersedes the tickets as the thing you build from. Each section
names the ticket that decided it, so a disagreement resolves by opening that ticket, not by
re-arguing here.

**What it is.** A custom chat surface for talking to Claude Code, replacing the xterm for a new
session type. It **drives Claude Code** — hooks, skills, `CLAUDE.md`, `--resume` and the whole
harness stay intact; this is not a bespoke agent loop against the Anthropic API. The chat is a
**fourth session type alongside `agent`**, not a replacement, but designed so it can swallow `agent`
later: nothing here may assume the terminal agent is gone.

**Day-one floor** (all four required): plan mode + bypass permissions only, rich collapsible
tool-call rendering, file/image attach, interrupt + conversation history on reopen. A plan awaiting
approval and an `AskUserQuestion` render as **native cards with buttons** — that is the payoff for
leaving the terminal.

**Read first:** `CLAUDE.md`, architecture and "Invariants — do not break". §15 of this spec is the
patch to that file and is part of the deliverable, not a follow-up.

---

## Contents

1. [The transport](#1-the-transport)
2. [Permission modes and the header toggle](#2-permission-modes-and-the-header-toggle)
3. [The window](#3-the-window)
4. [History and the transcript-as-model](#4-history-and-the-transcript-as-model)
5. [Attachments](#5-attachments)
6. [Session, activity and IPC integration](#6-session-activity-and-ipc-integration)
7. [The interrupted turn](#7-the-interrupted-turn)
8. [Slash commands and skills](#8-slash-commands-and-skills)
9. [Subagents and todos](#9-subagents-and-todos)
10. [Context, model and cost chrome](#10-context-model-and-cost-chrome)
11. [Transcript lifecycle on delete](#11-transcript-lifecycle-on-delete)
12. [Failure surfaces](#12-failure-surfaces)
13. [The complete mapper](#13-the-complete-mapper)
14. [Types and IPC surface](#14-types-and-ipc-surface)
15. [`CLAUDE.md` edits and the invariant ledger](#15-claudemd-edits-and-the-invariant-ledger)
16. [Stated costs and known gaps](#16-stated-costs-and-known-gaps)
17. [Corrections later tickets made to earlier ones](#17-corrections-later-tickets-made-to-earlier-ones)
18. [What is unverified](#18-what-is-unverified)
19. [Build order](#19-build-order)

---

## 1. The transport

*(#2 research, #4 research, #10 host verification. Everything in this section was observed on the
Windows host against a live Vivarium container running Claude Code **2.1.211** unless marked
otherwise.)*

**There is one transport, not three.** `claude -p --input-format stream-json --output-format
stream-json` *is* the protocol. The Agent SDK spawns that same CLI and speaks it over stdio; the
VS Code chat panel bundles its own CLI copy and does the same — so the extension this effort is
modelled on is an existence proof that the protocol carries the whole UI, built by the people who
own it. Remote Control and Channels were ruled out (#2): the first is an Anthropic-hosted relay with
no third-party protocol, the second is text-in/text-out with no tool_use blocks or plan payload.

### 1.1 Launch

Spawned from `src/main`, one live CLI process per chat session, keyed by session id — the same
shape as `PtyManager`. Build the argv in `DockerService.execArgs` (`src/main/docker.ts:710`) as a
third `kind`:

```
docker exec -i -w /workspace <container> claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --permission-prompt-tool stdio \
  --include-partial-messages \
  --forward-subagent-text \
  --permission-mode <plan|bypassPermissions> \
  --model <model> \
  (--session-id <uuid> | --resume <uuid>)
```

- **`-i`, never `-it`.** No TTY anywhere in the path — that is the whole point.
- **`--permission-prompt-tool stdio` is load-bearing and undocumented.** It is a sentinel, not a
  real MCP server. Without it a raw `-p` run **auto-denies every prompt**, *and*
  `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` are not in the session's tool list at all
  (verified by diffing `init.tools` with and without). It is not in `claude --help`. Every turn
  needs it, including a slash-command turn that calls tools.
- **`--session-id` vs `--resume`** branches exactly as the pty path does today
  (`docker.ts:739` → `claudeConversationExists`): `--session-id` starts a fresh conversation with
  that id and errors if it exists, `--resume` re-attaches and errors if it does not. Reuse that
  helper unchanged.
- **`--model`** is new — `execArgs` passes none today (§10.3).
- **`--forward-subagent-text`** is required for the sub-log to match the sibling file block for
  block (§9.2). Verified through `docker exec -i` (#16).
- **`--include-partial-messages`** works over `docker exec -i`, giving `stream_event` token deltas.
  Chunky (~16 events in 5s of generation), but real.
- **Never** point a chat session at `/vivarium/hooks.json` and never set
  `VIVARIUM_SESSION_ID`. The bridge stays for pty `agent` sessions only; double-emitting would give
  the store two producers for one session (§6.1).
- **`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is never set** — see §6.1 for why.

### 1.2 Two gotchas that will otherwise cost a day

**Nothing is emitted until the first user message is written.** `system/init` is the *answer to turn
one*, not a greeting — a client that waits for `init` before sending **deadlocks** (verified: 15s of
silence, zero bytes). The chat cannot show "connected" from the message stream; it is connected when
the first turn comes back. The **control channel is a separate matter and is live from spawn** —
`get_context_usage` and `list_models` both answer with no user message ever written (#16 probe 4),
which is what makes §10's open-time meter possible.

**Git Bash mangles `-w /workspace`** into `C:/Program Files/Git/workspace`. Irrelevant to the app
(`spawn` passes argv straight through, as `docker.ts` already does) but it bites anyone probing by
hand from the wrong shell.

### 1.3 What is on the wire

`SDKMessage` is a 38-member union. The load-bearing members:

| frame | carries |
| --- | --- |
| `system/init` | `session_id`, `model`, `tools`, `slash_commands[]`, `skills[]`, `agents`, `capabilities[]`, `permissionMode`, `memory_paths`. **Re-emitted at the start of every turn.** |
| `assistant` | full Anthropic `BetaMessage` — `text` / `thinking` / `tool_use` blocks, usage, `stop_reason`, plus `parent_tool_use_id`, `subagent_type`, and `aborted: true` on a truncated message |
| `user` | tool results, plus `tool_use_result` — the tool's **structured** Output object, not the string sent to the model. That is what rich tool rendering reads. |
| `stream_event` | raw token deltas (needs `--include-partial-messages`) |
| `result` | turn boundary: `subtype`, `terminal_reason`, `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `duration_ms`, `permission_denials[]` |
| `control_request` / `control_response` | the bidirectional channel — `can_use_tool`, `interrupt`, `set_permission_mode`, `get_context_usage`, `list_models` |
| `system/task_started` · `task_progress` · `task_updated` · `task_notification` | subagent lifecycle (§9) |
| `system/compact_boundary` | `preTokens` / `postTokens` / `trigger` |
| `rate_limit_event` | five_hour / seven_day utilisation + `resetsAt` (§10.4) |
| `conversation_reset` | `/clear` landed; carries `new_conversation_id` (§8.5) |

`num_turns` is **per turn** (1, 1, …), not cumulative — do not read it as a conversation length.

### 1.4 Interrupt

```jsonc
{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}
```

Acked in **under 100 ms**. Clean in both places a turn can be cut:

| interrupted during | `result.subtype` | `terminal_reason` | on the stream |
| --- | --- | --- | --- |
| text generation | `error_during_execution` | `aborted_streaming` | streaming stops dead; `result` has no `result` field and gains `errors` |
| a running tool | `error_during_execution` | `aborted_tools` | a **real synthetic `tool_result`** with `is_error: true` for the killed call |

In both cases the process **stays alive** and the next turn works — the agent even knows what it was
doing. The transcript records the cut as a synthetic user message `[Request interrupted by user]`
with the partial assistant text preserved above it.

**`is_error` cannot discriminate a user interrupt from a failure** — #16 probe 3 saw
`is_error: true` on a clean deny-then-interrupt. Only `terminal_reason` can. Every row in this spec
that distinguishes cancelled from crashed keys off `terminal_reason`; there is no second test.

### 1.5 Where the transcript lives, and why move-between-projects stays free

`/home/node/.claude/projects/-workspace/<uuid>.jsonl`, on the `claude-box-creds` volume.

Agents always exec with `-w /workspace` and `/home/node/.claude` is the same `claude-box-creds`
volume in **every** container, so the slug `-workspace` is identical everywhere. Consequences,
all verified:

- Chat and pty write **the same file**. A conversation started in an xterm agent session opens in
  chat with its full history, and a chat conversation resumes in a terminal — no sync path.
- A chat-created session resumes from a plain non-stream `claude --resume <uuid>` with the
  `session_id` unchanged (no fork).
- The `CLAUDE.md` move-between-projects invariant is untouched, and chat is strictly better than
  the terminal case (§6.4).
- A session created in one project's container is listed by another project's container. That is
  the same fact that makes §11's delete rule need care.

---

## 2. Permission modes and the header toggle

*(#4 research, #11 decision, #10 amended check 4.)*

**Bypass wins; plan mode is advisory.** A session that can reach `bypassPermissions` has plan mode's
blocks unenforced — Claude is still *instructed* to plan without editing, but an edit it attempts
during planning runs without prompting.

This is **not a regression**: today's terminal agents launch with `--dangerously-skip-permissions`
(`docker.ts:725`), so plan mode in Vivarium is already only a suggestion. The chat keeps that
bargain rather than changing it.

| mode | enforces | kept for |
| --- | --- | --- |
| `plan` | nothing | the agent reliably reaches for `ExitPlanMode`, and **that call is the plan card** |
| `bypassPermissions` | nothing, honestly | what `--dangerously-skip-permissions` gives the terminal today |

**Exactly two modes exist and nothing else.** The day-one floor stands as written, with the
degradation accepted rather than designed around.

### 2.1 One mechanism, not three

Tool permission, `ExitPlanMode` and `AskUserQuestion` all arrive as the **same** `can_use_tool`
control request and are answered with the same `PermissionResult`. One handler, not three.

```jsonc
{"type":"control_request","request_id":"…","request":{
  "subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode",
  "input":{"plan":"# Add --dry-run flag\n\n## Context\n…","planFilePath":"…"},
  "tool_use_id":"toolu_…","requires_user_interaction":true}}
```

`requires_user_interaction: true` is the CLI asserting the native-card requirement the map had
decided on preference alone: one-tap Approve/Deny must not be offered, the tool's card *is* the
user-interaction surface. It reaches the host even when an allow rule matches.

**`bypassPermissions` does not suppress either blocking tool** (#10 addendum, run in bypass
specifically): both still raise `can_use_tool` with `requires_user_interaction: true`. The native
cards work in the mode the chat actually lives in.

Ordinary tool prompts carry richer fields than the blocking ones — `description`,
`permission_suggestions`, `decision_reason`, `decision_reason_type` — free material for an
"always allow" affordance later.

### 2.2 Answering

**Approve a plan:**

```jsonc
{"behavior":"allow",
 "updatedInput":{"plan":"…"},
 "updatedPermissions":[{"type":"setMode","mode":"bypassPermissions","destination":"session"}]}
```

Approving a plan does **not** by itself leave plan mode; the host chooses the next mode. With two
modes there is nothing else approval could mean. **The header toggle visibly moves to bypass** —
verified that `setMode` genuinely takes (a later tool ran unprompted). The model then sees
`User has approved your plan…` plus the plan path (`/home/node/.claude/plans/<slug>.md`, on
`claude-box-home`).

**Keep planning:** `{"behavior":"deny","message":"<revision notes>"}` — a plain deny. The agent
takes the note and re-calls `ExitPlanMode` **within the same turn**, and it lands in
`result.permission_denials`. There is **no `PostToolUse` asymmetry here**; the host writes the
response that ends the wait, so approve and deny are one line of our own code either way. The
`TerminalView` Esc/Enter heuristics have no equivalent and must not be reproduced.

**Answer a question — and this is the trap that would silently break the card.** `allow` alone is
**not** an answer: it yields the tool_result *"The user did not answer the questions."* with no
error raised anywhere. The choice travels in `updatedInput` as an **`answers` map keyed by question
text**:

```jsonc
{"behavior":"allow","updatedInput":{ ...input,
  "answers": {"Do you prefer tabs or spaces for indentation?": "Tabs"} }}
```

Also available on that builder: a free-text `response` string (renders as *"The user responded: …"*
— the home for an "Other / type your own" option), per-question `annotations` carrying
`notes`/`preview`, and an AFK timeout path. Multi-select answers as an array of labels.

`AskUserQuestion` is **not available inside subagents** — the chat must not read that as a hang
(§9.8).

**Unknown `request_user_dialog` kinds:** answer `{"behavior":"cancelled"}` from day one. A host that
ignores an unknown `dialog_kind` parks a future tool forever, and **asks never time out** — a card
dropped by the UI is a permanently stuck agent.

### 2.3 The toggle

- **Live, in the header, not fixed per session.** `set_permission_mode` is accepted mid-conversation
  and even **mid-turn**. The fixed-per-session reading existed only to make plan mode a real
  guarantee; that requirement is dropped, so it costs the toggle and buys nothing.
- **Labels read plain "Plan" / "Bypass"** — no warning chrome, no explanatory tooltip. The advisory
  nature is a known accepted property of this tool, not something the UI argues with the user about
  every time they look at it.
- **A new chat starts in bypass**, matching today's terminal agent. Nothing in daily use gets
  slower and no habit needs retraining.
- **`mode` is a persisted field on `Session`** — restored at reopen as launch `--permission-mode`
  (or `set_permission_mode` after `--resume`). This is a deliberate exception to the never-persist
  rule; see §15.

---

## 3. The window

*(#5 prototype → variant D. Prototype branch:
[`prototype/chat-window`](https://github.com/Barni52/vivarium/tree/prototype/chat-window),
throwaway, dev-only, nothing folded into main.)*

Four variants were built into the running app and flipped through. The answer merges two: **C's log
body inside A's chrome**, plus three changes made in reaction.

### 3.1 The log

**The transcript is a gutter log, not a bubble stream.** Full bleed, a fixed left gutter carrying
`hh:mm` + who is speaking, content running to the window edge. Every row shares a left edge — that
is what makes a long turn scannable. Prose renders as markdown at 14px on a 940px measure; the
user's own turn is the one tinted block, with an accent edge.

Gutter roles: `you` · `claude` · `think` · `read` · `edit` · `bash` · `run` · `ask` · `plan` ·
`cmd` · `task` · `todo` · `stop`.

**Tool calls are open by default and truncated — inverted from the obvious default.** An edit shows
its diff and a command shows the tail of its output (6 lines); a read and a search collapse to their
gutter line with a `▸ show`. A read changed nothing; a diff is what you scrolled back for. Variant
A's collapse-everything was rejected for making the common case a click.

**Two exceptions to open-by-default**, both from later tickets: a **cancelled** tool card collapses
(§7.3), and a **`todo`** row is always one line (§9.4).

**A separate activity lane was rejected** (variant B). It buys a wide drawer for diffs and destroys
the one thing the log is for — knowing a file was edited *between these two paragraphs*. That
argument recurs three times in this spec and settles the turn clock (§6.7), the todo strip (§9.6)
and cost (§10.1) the same way.

### 3.2 Chrome

A **40px session header**: chat glyph, session name, project, then the **mode chip**, the **model
chip**, the **72×8 context meter**. Exactly three items, and it gains no fourth — #8 put the turn
clock in the log rather than the header for this reason, and #14 kept it to three when placing cost.

**Muted colour is load-bearing chrome**, one `CHIP` object:

| element | colour |
| --- | --- |
| `plan` (a deliberate, temporary mode) | amber `#c2a15e` |
| `bypass` (the ordinary state) | session hue `#c08bb8` |
| model chip | muted indigo `#8fa0cc` |
| context meter | steel `#6f93a8` → amber `#c2a15e` at 60% → red `#c97b7b` at 85% |

**Constraint:** none of these may be the container teal `#59a8a4` or the running-indicator green. A
mode chip must never share a colour with a container state — that is the bug `theme.ts` re-picked
the session accents to fix (`ACCENT`, `theme.ts:70`).

In the **log body**, colour appears in exactly one place: the **red `stop` row** for a crash,
timeout or desync (§12). #5 reserved colour for *attend to this*; #12 correctly spent none of it on
an interrupt, because that is something the user just did.

**Everything is a notch larger than variant C**: gutter 11.5, mono 12.5, prose 14, header 40,
composer 14. C was drawn at terminal density; this is a window you read prose in.

### 3.3 The composer

**Only a box and its placeholder.** No attach button, no `⏎ send` hint, no Send or Interrupt button.
Every affordance has a home that costs no chrome:

- **Enter** sends; **Esc** interrupts; **Ctrl+V** and **drag-drop** attach (§5.4).
- Two typeaheads live inside it: **`@`** anywhere over the mounted tree (§5.4), **`/`** at position
  0 only (§8.2).
- The placeholder is the only thing that follows the stage; the border brightens when the box holds
  the keyboard.
- Discoverability for interrupt sits on the live working row: `· esc interrupts`, on screen exactly
  when it is usable and nowhere else.

### 3.4 The pinned region — a fixed three-band stack

Three bands between the log and the composer, **widest scope to narrowest, each absent entirely when
empty**. Nothing is ever hidden by something else.

```
✓ Alpha  ● Doing Beta  ○ Gamma                  ← todo strip      (session state)
  Approve plan?  [ Approve ]  [ Keep planning ] ← blocking bar    (act now)
  📎 theme.ts  📎 screenshot.png                 ← attachment chips (what you're sending)
┌──────────────────────────────────────────────┐
│ Ask Claude something…                        │
└──────────────────────────────────────────────┘
```

Letting a pending card displace the strip was rejected: it does not make the buttons more visible —
they are adjacent either way — and it costs a disappearance the user did not cause.

**Blocking keeps two surfaces, not one.** The plan body renders **in the log, in its place in
time**, so the transcript stays a complete record; its **buttons are pinned above the composer**, so
a decision cannot scroll away behind twenty tool calls. An `AskUserQuestion` renders its options as
chips on an `ask` row; once answered the chosen one keeps a tick while the rest go grey — the
options not taken are the record of what the decision was between.

### 3.5 The session type

- `chat` joins `SessionType` and gains a fourth `SESSION_TYPES` entry in `theme.ts` and a fourth
  `TypeIcon` arm.
- **Accent `#c08bb8`** — a muted pink-violet that sits beside the agent violet `#a78bdb` without
  being it.
- **Silhouette: a rounded speech outline with the agent's spark inside it** — the fourth clearly
  distinct shape after the star, the window frame and the cube. It says *the agent, spoken to*
  rather than inventing an unrelated mark.

### 3.6 Layout invariant

The chat surface **may not replace `TerminalHost`'s views, only sit beside them** — those views are
what hold the ptys. The prototype's overlay mounted *over* the terminal body for exactly this
reason.

### 3.7 Carried consequence

**Esc is the only interrupt.** Same gesture as the terminal today, so not a regression, but it is
now the sole route in a window where a mouse is the natural reach. Nothing found in #12 or #16
argues for a button. If it bites, the fix is a stop control in the **header**, beside the mode chip
— **never back in the composer**, which this design deliberately emptied.

---

## 4. History and the transcript-as-model

*(#7, grounded in a read of 20 real transcripts on the host — `~/.claude/projects/D--Vivarium/*.jsonl`,
~28 MB, versions 2.1.2xx. Every number below is from that sample.)*

### 4.1 The source

**The container-side `.jsonl`, and nothing else.** `docker exec cat
/home/node/.claude/projects/-workspace/<claudeSessionId>.jsonl`, parsed in `main`. **No host-side
mirror**, no copy under `%APPDATA%`.

The deciding argument is not storage. A mirror only knows turns *the app streamed*, and it can drift
from the file `--resume` actually feeds the model — the UI could show something other than what the
agent remembers. Reading the container's own file makes cross-type resume free (§1.5).

**Accepted cost: history is unreadable while the container is stopped.** Consistent with `ipc.ts`
`openSession` already refusing a stopped container, so it introduces no new asymmetry — and §12.1
makes it the one screen where the cost is visible, on a placeholder that already explains it.

### 4.2 Live vs settled — the stream paints, the transcript settles

The day-one requirement is that history the app *did not* stream looks identical to history it did.
That is met **structurally**, not by keeping two mappers in step:

1. While a turn runs, entries render **from the stream** (provisional).
2. On `result`, main reads the bytes appended since its stored **byte offset**, maps them, and
   **replaces that turn's entries** with the transcript-derived ones.
3. On reopen, the whole file goes through the same mapper.

So anything more than a few seconds old is always transcript-derived — the same bytes a restart
would render. If the two envelope mappers ever disagree, the disagreement appears as a **visible
twitch at turn end during development**, instead of as a bug report after a restart weeks later.

Two things make this cheap. Both envelopes carry the **same Anthropic content-block array** under
`message`, with the same `message.id` and `tool_use.id`, so the block-level mapper is literally one
function and only the envelope differs. And the settle-read is incremental from an offset, not a
re-read — which also picks up lines written by *another* client on the same conversation for free.

**The one thing the transcript can never carry is a *pending* blocking card.** `can_use_tool` exists
only on the wire; the transcript records outcomes. A plan awaiting approval is by definition
stream-state, so the pinned bar is fed from the stream and its log row settles like everything else
once answered.

### 4.3 Volume — read all, truncate what crosses IPC, mount the tail

The file is always read **whole**: 10.6 MB is the largest session in the sample and parses in well
under a second, and pairing `tool_use` to `tool_result` wants the full sweep anyway. Two cuts after
that:

1. **Main keeps parsed entries with full bodies** (it already holds the byte offset). The renderer
   receives **truncated** ones — a read's body dropped entirely, a bash tail of ~40 lines, a diff
   capped at ~200. Expanding a truncated card asks main for the full body over `chat:body`. This is
   what keeps a 10 MB transcript from becoming a 10 MB structured clone and a 10 MB resident store.
2. **The renderer mounts the last ~300 entries**, with a `load earlier` control above them
   (`chat:earlier`).

The shape of the data justifies both: across the sample, **728 assistant text blocks weigh 1.2 MB
while 2 074 `tool_result` blocks weigh 14.6 MB.** Prose is a rounding error; tool output is the
entire weight, and variant D keeps most of it collapsed by design.

### 4.4 Mounting — keep-alive, and eager

**Chat views stay mounted and hidden on deselect, like terminals** — but for a different reason.
Nothing in a chat is unrecoverable, so the `TerminalHost` invariant **narrows: terminals *must* stay
mounted, chat merely *may*.** The reason to is that scroll position, which cards are expanded and
the composer draft come free; unmounting would mean lifting all three into the store.

**They open eagerly, at container start**, alongside terminal sessions — Claude process *and*
transcript read included. Decided against the recommendation (an inert mount: read on first select,
spawn on first send) because it keeps *"a session is live whenever it can be, not when it was last
clicked"* true for chat, and the first message is answered with no cold-start wait.

That loads the burst consequence onto §6.3.

---

## 5. Attachments

*(#6, with two host probes against a live container, 2.1.211.)*

### 5.1 What the probes reframed

- **A native `image` block works over the transport with no file, no mount and no path.** The model
  described a test PNG correctly. It lands in the transcript **inline as base64**, so it survives
  `--resume` and history replay. `document` works the same way for PDFs.
- **A `Read` of a path outside `/workspace` raises *no* `can_use_tool` in bypass**, and a PNG read
  returns `type:"image"` content. So the path route also gets native vision, and #10's
  working-directory-guard note does not bite for `Read`.

So the host↔container boundary is **optional, not forced**.

### 5.2 The rule: routing by reachability

A file **under one of the project's mounts becomes a container path**; anything else becomes
**inline content**. Nothing is copied, `/clip` is never written to, and **no mount is ever changed**
— which matters, because mounts may only change while the container is stopped, so "just add a
mount" was never a cheap answer.

```
D:\proj\src\api.ts    → /workspace/proj/src/api.ts   (path)
D:\proj\ui\shot.png   → /workspace/proj/ui/shot.png  (path)
C:\Users\…\note.pdf   → inline document block
Ctrl+V screenshot     → inline image block
```

**Path translation reverses the leaf naming already in `docker.ts`** — `sanitize(basename(abs))`
with a `-<shortHash>` suffix on collision (`docker.ts:409-411`), plus `/workspace/output` for the
shared output folder.

**The path rides in a `<vivarium-attached>` trailer**, not a bare interpolated sentence, because #7
made the `.jsonl` the history model: a delimited trailer parses back into chips on reopen, while a
path you typed by hand and a path you attached would otherwise be indistinguishable. Images and PDFs
need no marker — they are real content blocks and replay as themselves.

```
content: [{ type:'text', text:
  "why is this reflowing on resize?\n\n" +
  "<vivarium-attached>\n/workspace/viv/src/TerminalView.tsx\n</vivarium-attached>" }]
```

**The chip shows the container path**, so the translation is never hidden. That also disarms the
`SHADOW_KINDS` trap (`docker.ts:47`): `<mount>/node_modules`, `.angular`, `extensions/node_modules`
and Maven `target` are shadowed by volumes, so a file dragged from `D:\proj\node_modules\…`
translates to a path served by the **container's** install rather than the copy you dragged. That is
usually the copy the agent should reason about — and showing the container path means you can see
what you actually got.

### 5.3 The inline side

| kind | block | chip |
| --- | --- | --- |
| image | `image` | verbatim |
| PDF | `document` | verbatim |
| UTF-8 text under **64 KB** (~16k tokens) | `text` wrapped with its filename | `· copy` — the agent can read it, never edit it |
| binaries, oversize files | — | **refused** |

**Images pass through verbatim: no downscale, no size cap.** The cap protects the *context window,
not the disk*, and by that test an image needs none — it costs ~1600 tokens whatever the file
weighs, while a 3 MB log inlined is ~750k tokens and breaks the turn. The disk cost of keeping every
image forever is answered by lifecycle (§11), not by degrading what the user attached.

### 5.4 Affordances

- **Ctrl+V** — clipboard image, inline.
- **Drag-drop** from Explorer — routed by reachability. Electron 31 still gives `File.path` on the
  drop event; past Electron 32 this becomes `webUtils.getPathForFile` in the preload.
- **`@` typeahead over the mounted tree** — the one that actually dissolves this friction: you pick
  from the tree and never see either kind of path. Costs a new IPC to walk the project's mounts.

No attach button and no file dialog — dragging *is* the picker.

### 5.5 One surface for pending chips and refusals

A chip strip along the composer's top edge, present only when non-empty (the bottom band of §3.4).
**A refusal is the same chip in a failed state**, carrying its reason, and cannot be sent — the
error attaches to the thing that caused it, rather than to a toast that disappears while you are
reading it or a log row that never went to the model and would vanish on reopen.

```
┌──────────────────────────────────────┐
│ ▣ shot.png · 2560×1440            ×  │
│ ≡ api.ts · /workspace/viv/src/…   ×  │
│ ⚠ budget.xlsx · not readable, and    │
│   outside this project's mounts   ×  │
│──────────────────────────────────────│
│ ask, or paste an image…              │
└──────────────────────────────────────┘
```

### 5.6 Derived, not separately decided

- A **folder** is a path chip under a mount and refused outside one — nothing inlines a tree.
- **`/clip` stays exactly as it is**, serving pty `agent` sessions only (`TerminalView.tsx:353` →
  `clipboard.ts`). The chat never writes to it; it retires whenever the `agent` type does.
- **A file under `basePath` but not under any mounted subfolder is unreachable.** This is the common
  case, not an edge one.

**The refusal copy is load-bearing.** It is the only place the app ever explains the mount model, in
a window with no terminal to print an explanation into, so it must name the rule *and* the fix in
one line: *outside this project's mounts* — move it under a mounted folder, or add a mount with the
container stopped.

### 5.7 Inline chips force a split-send

An inline attachment makes `content` a **block array**, and in an array the CLI never expands a
slash command (§8.6). The fix, verified: send a `shouldQuery: false` message carrying the blocks
(no turn, no cost), then the command as a plain string. Path chips need no split — they are text.

---

## 6. Session, activity and IPC integration

*(#8. This section carries the ledger the spec has to reproduce; the full table is in §15.)*

**One new `SessionType`, one reshaped event, one departure from IPC precedent — and nothing breaks.**

### 6.1 Activity is derived from the ordinary stream

`system/session_state_changed` is **not used**, and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is never
set — even though #10 verified it exists, and that `running` / `requires_action` / `idle` is a **1:1
match** for Vivarium's `working` / `waiting` / `idle`.

Exactness was its only advantage, and it loses to the failure mode. Claude Code is **user-updated by
hand** in this app (`claude.ts`, and the never-auto-update invariant), so a version that drops an
undocumented env-gated flag would take the sidebar `?` with it, silently, in a release nobody would
connect to the symptom. That is the same class of breakage hooks were introduced to end —
`bridge.ts` records that they replaced scraping the xterm for the "esc to interrupt" spinner
precisely because scraping *"broke silently whenever the TUI changed"*.

The derivation, computed in `main`, costs no extra parsing because main is already reading every
message to render the log:

| stream | activity |
| --- | --- |
| `assistant` (and we wrote the user message) | `working` |
| any pending `can_use_tool` | `waiting` |
| `result` | `idle` |

**One correction the derivation buys for free: `waiting` is *any* pending `can_use_tool`, not just
the two `requires_user_interaction` tools.** Bypass does not dissolve the working-directory guard,
so a `Read` outside the mounts still prompts — and that blocks the turn on a human just as much as a
plan does. The hook bridge cannot see this case at all (terminal agents run
`--dangerously-skip-permissions`, so it never arises there), which makes chat's reading **strictly
more correct** than the pty's rather than an approximation of it.

### 6.2 The two sources unify at the event, not at the channel

#4 recommended an adapter emitting the existing `AgentHookEvent` shape. §6.1 makes that the wrong
direction: main would have to emit `'ExitPlanMode'` to mean "waiting", and the working-directory
prompt has **no hook kind to lie with at all**. So the seam moves one layer down.

```ts
export interface AgentActivityEvent {
  sessionId: string
  activity: AgentActivity
  /** host-stamped, unchanged — see the note on AgentHookEvent.at */
  at: number
  turnStart?: true
}
```

- `AgentHookEvent` → `AgentActivityEvent`; the channel `agent:hook` → `agent:activity`;
  `handleAgentHook` → `handleAgentActivity`.
- **`bridge.ts` gains the hook→state mapping** that today lives in `store.handleAgentHook`
  (`store.ts:739`). Hook vocabulary stops crossing IPC, and the attention rules (`waiting` →
  `'question'`, `idle` → `'finished'`) exist in exactly one place instead of once per source.

The mapping survives the collapse almost intact, which is what makes it safe:

| today | as a state |
| --- | --- |
| `AskUserQuestion` / `ExitPlanMode` → waiting + `'question'` | `waiting` → `'question'` |
| `Stop` → idle + `'finished'` | `idle` → `'finished'` |
| `Resumed` → `resumeAgent` (guarded on waiting, preserves the clock, clears the `'question'` flag) | `working` when prior was `waiting` — `setActivity` **already** does exactly this arithmetic in its `waitedFrom !== undefined` branch (`store.ts:677`) |
| `UserPromptSubmit` → working + **unconditional** re-stamp | ✗ — `working` while already `working` no-ops by design (`store.ts:659`), so the queued-prompt restart is lost |

**`turnStart` is that one missing bit and nothing more.** It is also *more honest on the chat side*:
main knows exactly when it wrote a user message into the process, where the hook only knows a prompt
was submitted.

`resumeAgent` keeps its guard but loses its keystroke callers (§6.9).

### 6.3 One `OPEN_LIMIT` slot for the whole chat open

Probe + transcript read + spawn, under a **single slot**, exactly like a terminal agent today,
sharing the existing `openGate` closure (`ipc.ts:496`).

**The accepted cost is real and should be stated rather than discovered.** `OPEN_LIMIT`'s comment
(`ipc.ts:488`) sizes a slot as "up to three docker.exe launches" and promises that "an interactive
open waits at worst for a couple of probes". A chat open still costs three launches, but the middle
one is no longer a probe — §4.3 reads the file whole, and `tool_result` blocks in the sample weigh
14.6 MB. **The slot is now held for a bulk transfer**, so with `OPEN_LIMIT = 3` an interactive open
can queue behind up to three of those. **That comment must be rewritten when this lands:** the gate
now meters two different sizes of thing.

Whether 3 remains the right number is a tuning question for the build, answered by running it.

The retry-on-`container-stopped`/`spawn-failed` path applies unchanged.

### 6.4 A move drops everything transient

The process is a `docker exec -i` client bound to the old container, so it dies exactly as a pty
does, and for the same reason. Everything else transfers for free and **better than the terminal
case**: the transcript slug is identical in every container and §4 made that transcript the model,
so the remounted chat re-reads it and shows an **identical log**, where a terminal agent's move
drops its scrollback and leans on `claude --resume` to redraw. `claudeSessionId`, `mode`, `model`
and `previousClaudeSessionIds` all ride the `Session` object.

What dies with `TerminalHost`'s `project.id:session.id` remount is the composer: **the draft text
and every pending chip.** §5's routing rule would have permitted a subtler answer — inline chips are
bytes and would survive untouched, path chips could re-resolve — but a move is already a deliberate
destructive act, and buying a half-written message the right to outlive it is not worth state that
has to survive a remount. The confirm dialog says so, alongside what it already says about paths.

*If this is ever revisited:* chips would have to re-resolve from the **host** path, never the
container path. Two projects mounting folders with the same leaf name would otherwise make
`/workspace/src/x.ts` resolve to a valid-but-different file.

### 6.5 IPC — granular out, one union in

**Outbound follows house style exactly**, one channel per operation with a typed preload method, via
the four-place path in `CLAUDE.md`:

`chat:open` · `chat:send` · `chat:interrupt` · `chat:answer` · `chat:set-mode` · `chat:close` ·
`chat:body` (fetch-on-expand) · `chat:earlier` (`load earlier`) · `chat:subagent` (fetch by
`agentId`) · `chat:mount-tree` (the `@` typeahead)

`chat:open` is its own handler rather than a fourth branch of `openSession` — `cols`/`rows` are
meaningless for a chat — but it **shares the same `openGate`**, which §6.3 requires anyway.

**Inbound departs from precedent: one `chat:event` channel carrying a discriminated `ChatEvent`
union.** `ptyData`/`ptyExit` can be separate channels safely because exit is terminal and data is
opaque bytes. Chat's inbound is neither — a turn emits appended entries, then §4.2's turn-end
*replacement* of those same entries, plus blocking cards, plus `task`/`todo`, plus reset, plus exit,
and these are **strictly ordered**. Electron guarantees ordering **within** a channel, not across
channels, and a blocking card that overtakes the text it refers to renders a question above the
sentence asking it. The alternative is a sequence number and a reorder buffer in the renderer — the
same guarantee bought back at a higher price.

**The union's declaration must carry that reason**, since it is the one place in `CH` that breaks
the pattern.

### 6.6 `toRender` gains no chat arm

One filter, three clauses (`TerminalHost.tsx:99`), reading the same for every session type.

The third clause (`live[session.id]`) is genuinely **optional** for chat, and it is worth recording
why it was kept. §4.4 narrowed the invariant to "terminals *must* stay mounted, chat *may*". §6.3
briefly made the clause look mandatory again — a `docker inspect` blip unmounting every chat view
would queue a burst of 15 MB reads through the very gate that exists to prevent docker.exe storms.
But §4.3 keeps full bodies **in main**, fetched on expand, and main re-reads incrementally at every
turn end, so a remount re-hydrates over IPC from a cache that is already current and **never touches
docker**. The storm is not real.

So the clause is kept **for cheapness, not survival** — and the filter needs no type branch, staying
correct by default if main's cache is ever dropped.

### 6.7 The turn clock is a row in the log, not a header chip

The map requires the `Elapsed` turn clock to keep working for chat, and #5 enumerated the header's
contents precisely without it. It resolves in the log's favour, because §4 already kept "real
per-turn durations from `system/turn_duration`" as one of only three extras.

**The in-flight turn's row carries a live `Elapsed`; at `result` it freezes in place into that
duration row.** One row, live then static, where the eye already is — the same instinct that made #5
reject a separate activity lane.

What this costs is the header's idle reading, today `idle · 12m` (`TerminalHost.tsx:37`). #5's
gutter stamps every row `hh:mm`, so that fact is already on screen. Scrolling up also takes the live
reading out of the viewport — acceptable, because the sidebar indicator and taskbar badge are
untouched and are what you rely on when you are not looking.

`AgentStatus` therefore **stays agent-only**; the chat does not reuse it. `Elapsed` itself is reused
verbatim, including its `until` prop for the stopped clock, which is what renders `waiting`.

### 6.8 The frozen number is `turn_duration`

At `result` the row adopts Claude Code's own measured duration, so a turn reads **identically
whether you watched it happen or reopened the session a week later**. The cost is a visible jump at
freeze when the two clocks disagree — in practice a turn that spanned a host sleep, which is exactly
the WSL2-drift scenario the host-clock invariant was written for.

**This looks like it violates that invariant and does not.** The rule governs *timestamps*
subtracted across two clocks. `turn_duration` is pre-computed inside the container and never
subtracted from anything, so it **sidesteps** the rule rather than breaking it. Live readings remain
host-stamped, unchanged.

An interrupted or crashed turn has no `turn_duration` and gets **no number at all** — see §7.4.

### 6.9 Verified, not decided

- **Attention clearing works unchanged.** `notifyAgentAttention`'s `if (sess?.type !== 'agent')
  return` (`store.ts:711`) is the **only** edit in the whole path. `select`, `acknowledgeSelected`,
  `windowFocused` and `pushBadge` are keyed on `selectedSessionId` / `notifications` and never look
  at a session type. The rule that makes it work — decline to flag only when focused *and* selected
  (`store.ts:714`) — stays true for chat, because §3.4 pins blocking buttons above the composer so a
  decision cannot scroll out of a visible session.
- **The chat needs no Esc or Enter heuristics at all.** Both gotchas in `CLAUDE.md`'s hook paragraph
  are TUI artifacts: "keep planning" arrives as a plain `deny` observed identically to approve, and
  interrupt reports cleanly as `aborted_streaming` / `aborted_tools`. `TerminalView`'s
  Esc-resets-the-indicator and Enter-answers-a-prompt paths (`TerminalView.tsx:371`, `:382`) are
  **pty-agent-only** and must not be reproduced.
- **`claudeSessionId`'s doc comment** ("For `agent` sessions only") widens to both agent kinds.
  `mode` and `model` are chat-only — terminal agents launch with `--dangerously-skip-permissions`
  and have no toggle.

---

## 7. The interrupted turn

*(#12, with its one unobserved bet confirmed by #16 probe 3.)*

**An interrupt is a row, not a state.** A cut turn is an ordinary turn with one extra row in it.
Nothing is dimmed, nothing collapses, nothing is manufactured to fill the gap the missing `result`
leaves.

### 7.1 The `stop` row

```
14:18  you      write the migration
14:19  edit     src/main/config.ts       +18 −11
14:21  bash     npm run typecheck        cancelled

14:22  stop     interrupted

14:23  you      actually, do it the other way round
```

**Muted, no hue** — deliberately not amber and not the chat accent. Colour in this chrome means
*attend to this*; an interrupt is something the user just did, so it earns a role word and nothing
more. (A crash reuses this row **in red** — §12.2.)

**A race disappears for free.** The row is driven by `terminal_reason`, **not by the gesture**, so
an Esc that lands after the turn already finished (`still_queued: []`, a plain `success` result)
leaves no trace. Pressing Esc does not put a `stop` row on screen; *being interrupted* does.

### 7.2 The partial assistant text stays plain

No dimming, no truncation glyph, no collapse. It renders exactly like any `claude` row.

Dimming makes the wrong claim. The partial prose is usually the most useful thing on screen — it is
what the agent was about to do, and #10 watched the agent carry precisely that into its next turn.
Greying it says *this counts for less*; it is as real as any other prose, just shorter. The cut-off
sentence plus the `stop` row immediately beneath it is already unambiguous.

The counter-argument was weighed and accepted as a cost: a cut-off "I'll update the three call sites
in `ipc.ts`" describes work that never happened. A completed turn's prose has the same hazard, so
the interrupted case does not earn chrome the ordinary case lacks.

### 7.3 A cancelled tool card reads `cancelled`, muted, and collapses

Distinct from a failure's red error treatment: **cancelling is something you did, failing is
something that happened.** It collapses to its one title line — the **first exception** to §3.1's
open-by-default — because the synthetic `tool_result` carries no output, only the refusal sentence
*"The user doesn't want to proceed with this tool use…"*, and an open card showing that sentence is
a card showing nothing.

**Detection is structural, not prose-matching.** Live it is free (we sent the interrupt;
`terminal_reason: aborted_tools` names it). Reopened, both a cancelled and a genuinely failed call
are `is_error: true`, and the rule is:

> the error `tool_result`s with nothing after them in the turn but the interrupt marker are the
> cancelled ones.

A genuinely failed tool earlier in the same turn always has assistant blocks after it, because the
agent kept going. **Position, not wording** — which matters because §4 already accepted one
prose-parsing fragility (§13.4). One of those is a known cost; two would be a pattern.

### 7.4 No duration — the `stop` row *is* the frozen clock row

An interrupted turn has nothing to freeze to. `system/turn_duration` is a **transcript** line type;
#10's stream probes never saw one, and #16 confirmed a killed turn writes no assistant line at all.

Manufacturing one was rejected on both available routes:

- **Freezing the live host stopwatch** subtracts a host `Date.now()` stamp from a container-side
  reading — exactly the two-clock subtraction the `CLAUDE.md` invariant exists to prevent.
- **Computing from two transcript timestamps** is same-clock and therefore *safe* — it sidesteps the
  invariant the same way §6.8 does — but it invents a figure Claude Code never reported, in the one
  case where the reading has no meaning. You killed it; how long it ran before you killed it is not
  a number anyone acts on.

So the live `working · 4m` row is **replaced by** the `stop` row and the reading is gone. The gutter
already stamps `hh:mm` on the `you` row and the `stop` row, so the span is on screen at minute
granularity for anyone who wants it. Identical live and reopened by construction.

### 7.5 Esc on an outstanding card: `deny`, then `interrupt`

Esc keeps the single meaning it has in every other state — **stop this turn**. A card is a *mid-turn*
state (the turn ends at `result`, not at the card), so treating Esc as a dialog-dismiss would give
one key two behaviours depending on state, and would leave no fast exit from a replanning loop —
`deny` alone never ends anything, since the agent re-calls `ExitPlanMode` within the same turn.

Order matters and the chosen one is the defensive one: the process asked a question, we answer it,
then we cut. **Confirmed on the host** (#16 probe 3): the interrupt was acked `success`, the turn
ended `aborted_streaming`, the process survived and the next turn returned normally — no deadlock,
and the `deny` was not rejected as answering a dead request.

**It composes with §7.3 with no special case.** The denied `ExitPlanMode` produces an error
`tool_result` sitting immediately above the interrupt marker, so the structural rule classes the plan
card `cancelled` rather than `denied` — which is what actually happened to it.

```
14:20  plan     │ ## Add --dry-run flag
                │ 1. Parse the flag in cli.ts
                │ 2. Thread it through…        cancelled

14:20  stop     interrupted
```

The pinned decision bar clears; the plan body stays in the log in its place in time.

### 7.6 No confirm, and Esc keeps a narrow scope

**No confirm.** The process survives, the context is intact, nothing rolls back, and a modal that
appears *while text is streaming* is the worst possible moment for one. A confirm gated on "the turn
made edits" would protect nothing, since cancelling rolls nothing back.

Three consequences, derived rather than debated:

- **Esc with nothing running is a no-op, and must never clear the composer draft.** A stray Esc
  destroying a half-written prompt is the only genuinely unrecoverable outcome anywhere in this
  area.
- **The handler is on the chat container, not the composer input** — so it fires with focus on a
  tool card's expand button too, and never while a dialog is open.
- **Discoverability** stays on the live working row: `· esc interrupts`.

### 7.7 An interrupted turn never raises the attention flag

`result` → `idle` → `notifyAgentAttention(id, 'finished')` is normally harmless here, since Esc
requires the chat focused and selected and `notifyAgentAttention` declines exactly that case. But
there is a **~100 ms window**: press Esc, click another session before `result` lands, and the turn
you killed flags itself `!` as *finished*.

Suppressed at the same branch that already reads `terminal_reason` to decide the `stop` row. You
ended it; being told it ended is noise.

---

## 8. Slash commands and skills

*(#9, probed live against the host CLI 2.1.220 — the mechanism is the stream, not the container.)*

**The composer never parses a slash command; the CLI does.** Every `/…` is forwarded verbatim and
whatever happens next is Claude Code's business. Native controls exist alongside typing and send the
same text; none of them intercept it. That rule holds for `/clear`, `/model`, `/compact`, plugin
skills and unknown names alike, and it is what keeps the chat from rotting as the CLI ships new
commands.

### 8.1 What the probes established

- **A leading `/` in a stream-json user message is expanded by the CLI**, `$ARGUMENTS` intact.
- **`system/init` carries `slash_commands[]` *and* `skills[]`** — project commands, plugin skills,
  built-ins. Re-emitted every turn, plus a `system/commands_changed` event.
- **Local commands work headlessly at zero cost.** `/context` returned its usage table, `/model` its
  current value and setter syntax, `/config` `/agents` `/color` `/usage` `/effort` `/mcp` all
  answered instantly, `Unknown command: /x` came back as ordinary assistant text — every one an
  `assistant` frame at `total_cost_usd: 0`, no model call.
- **There is no inert set.** `/doctor` is a normal model turn; `/insights` is merely slow. A denylist
  was chosen and then **dropped once probing killed its premise** — a hand-maintained list would hide
  working commands and still go stale.
- **The transcript splits the two kinds.** A prompt command records a plain `user` row
  `<command-name>/x</command-name><command-args>…</command-args>` (the expanded prompt is a separate
  `isMeta` row); a local command's output records as `system` / `subtype: local_command` wrapping
  `<local-command-stdout>…</local-command-stdout>`.

### 8.2 Discovery — the `/` menu

Opens **only when `/` is the composer's first character** — the sole position the CLI expands one —
so it can never offer a completion that would be sent as prose. Picking inserts `/name ` and
dismisses; everything after is free text, including the second `/foo` in `/loop 5m /foo`.

Rows show **name + source only**, because `init` carries names and nothing else: no descriptions, no
`argument-hint`, **no argument fields, no chips, no per-command forms**. #5's bare box survives,
carrying two typeaheads — `@` anywhere, `/` at position 0.

The list is `slash_commands[]` + `skills[]`, **unfiltered**, ordered **project → plugin → built-in**,
refreshed on every turn's `init` and on `system/commands_changed`.

**Cold start:** §1.2 means a freshly opened chat has no `init` and therefore no list. The last known
list is **cached per project in `config.json`**. This is runtime-derived data in config, next to
`mode` — admissible because **the cache is a hint, never authority**: the CLI always decides, so a
stale entry can only mis-suggest, never mis-execute. (Contrast §10.3, where that pattern
deliberately does *not* stretch.)

### 8.3 Rendering

- A typed command is a **`you` row** showing the command text; the `isMeta` expanded prompt stays
  dropped.
- Local output is its own **`cmd` gutter row**: `system`/`local_command` joins the whitelist,
  `<local-command-stdout>` stripped, rendered as markdown, **open and truncated** like an edit body —
  a context table is exactly what you asked to see.
- **Live it arrives labelled `claude`, and §4.2's turn-end replacement re-labels it to `cmd`.**
  Without whitelisting the bug is structural: `/context` would render and then *vanish* a second
  later at `result`, when the turn's entries are replaced with transcript-derived ones.
- `Unknown command: /x` is the same `cmd` row — a reply, not an error, so it stays out of §12.
- **A `Skill` tool_use renders as that same `cmd` row**, so a skill reads identically whether you
  typed it or Claude reached for it.

### 8.4 Grouping is turn-shaped, not command-shaped

There is nothing in the stream to group *by* — a command has no marker and its run simply *is* the
turn. So no skill-only construct and no boxes. The fold affordance belongs to **every** turn,
triggered from its opening row and collapsing to one line:

```
▸ /release · 40 calls · 3m 12s
```

A forty-call `/release` folds away; so does a long ordinary turn, which is the same problem. **This
can ship after the day-one floor** without changing the model.

### 8.5 `/clear`

Forwarded like anything else, and handled. On `conversation_reset`:

1. persist `new_conversation_id` as the session's `claudeSessionId`,
2. push the outgoing id onto `Session.previousClaudeSessionIds` (§11.6),
3. **drop every entry from the log**, and wipe the todo fold (§9.5).

Live and reopened views stay identical the instant the reset lands. A **New conversation** control
in the header sends the same text — a chat whose only route to a fresh start is a remembered
terminal command is the bloat this effort exists to cut.

**Consequence: `claudeSessionId` is no longer write-once.** `chat:event` gains a reset kind, the
store must rewrite it, and anything caching the id per session must re-read it.

### 8.6 The mechanism trap, and the fix

**String content and block-array content are different mechanisms.** With `content` as a string the
*CLI* expands the command. With `content` as a **block array** — which any inline attachment forces
— expansion never happens: the *model* sees the text and reaches for the `Skill` tool. That works
for skills, is a **wasted turn** for a local command (`/context` in an array drew an apology
suggesting the terminal), and is a **silent failure** for `/clear`.

Fixed by **split-send**, verified: a `shouldQuery: false` message carrying the blocks — zero-cost
`result`, no model call, and the *following string turn saw it* — then the command as a plain
string. Path chips need no split: they are text and land in `$ARGUMENTS`, which is arguably what you
meant by attaching them to a command.

**The one non-free cost, and the builder owns closing it:** split-send writes **two user rows in the
transcript for one send**, so the log shows one row live and risks two after a restart — precisely
the drift §4.2 exists to prevent. The stitch is to **fold the appended blocks into the following
command row on the way through the mapper** (they share a promptId-adjacent position, and the
`<vivarium-attached>` trailer already marks intent).

---

## 9. Subagents and todos

*(#13, forced by two live probes plus a read of the tool schemas; two of its five premises did not
survive. #16 probes 6 and 7 confirmed the mechanism through `docker exec -i`.)*

### 9.1 What the probes changed

**Subagent inner work arrives on the stream but is *not* in the parent transcript:**

| | stream | parent `.jsonl` |
| --- | --- | --- |
| the subagent tool call + its final report | ✅ | ✅ |
| the subagent's Grep/Bash/Read calls and results | ✅ inline, tagged `parent_tool_use_id` | ❌ **absent** |
| the subagent's prose and thinking | ❌ without `--forward-subagent-text` | ✅ |

The subagent's turns live in a **sibling file**: `<session>/subagents/agent-<id>.jsonl` plus an
`agent-<id>.meta.json` of `{agentType, description, toolUseId, spawnDepth}`. So "does one subagent
flood the parent transcript" had it backwards — **flooding is the default on the wire**, and under
§4.2's turn-end replacement everything the stream painted would silently vanish when the turn
settled: §8.3's `/context` bug, one size up.

**`TodoWrite` does not exist.** The container's `init` lists `TaskCreate` / `TaskGet` / `TaskList` /
`TaskOutput` / `TaskStop` / `TaskUpdate`, and no `tool_use` named `TodoWrite` appears in ~28 MB of
real transcripts. (The inventory read it out of `sdk-tools.d.ts`, which still declares the retired
tool.) The live tools are **incremental, not a snapshot**: `TaskCreate {subject, description,
activeForm?}` one call per item; `TaskUpdate {taskId, status}` → `{success, taskId, updatedFields,
statusChange:{from,to}}`. There is no `{oldTodos, newTodos}` and no full list in any single result,
so **current state exists only as an accumulator**. Status is `pending | in_progress | completed`
**plus `deleted`, which permanently removes a task**; tasks carry an `owner` (a subagent can own
one), `metadata`, and real `addBlocks` / `addBlockedBy` dependencies.

**No `task_*` event fires for todos** — that family is subagent/background-task only
(`task_type: "local_agent"`). And **`tool_progress` fired in neither probe**, nor in #16's, not even
behind a deliberate 6-second `Bash`.

**The subagent tool's name is not stable:** the container's `init` lists it as `Task`, the host probe
emitted `tool_use` named `Agent`. Both are it. **Key off `system/task_started.tool_use_id` live and
`toolUseResult.agentId` / `agentType` in the transcript — never off the tool name.**

### 9.2 One `task` row that expands into its own sub-log

The stream's `parent_tool_use_id` frames are **suppressed from the main log** and never appended to
it. Indenting them under the spawning row was rejected — it makes one subagent's bookkeeping
outweigh the conversation, and §3.1's whole argument for the log is a single shared left edge.

```
14:22  task   Explore · Find SESSION_TYPES definition
              completed · 36s · 4 tools · 20.9k tok
              ▾ hide 14 steps
       ┆ 14:22  claude  I'll search for the symbol first.
       ┆ 14:22  grep    SESSION_TYPES in D:/vivarium
       ┆ 14:22  read    theme.ts:80-140
       ┆ 14:22  claude  Confirmed — theme.ts:98
              **Definition file:** `theme.ts` line 98 …
```

The filesystem hands us exactly this shape, which is the reason to trust it: **the parent file
already *is* the collapsed view, and the sibling file already *is* the expansion.**

**The settled row costs no extra read at all.** The parent transcript's `toolUseResult` carries
`agentId`, `agentType`, `status`, `resolvedModel`, `totalDurationMs`, `totalTokens`,
`totalToolUseCount`, `toolStats`. Only *expanding* touches the sibling file, on demand, keyed by
`agentId` (`chat:subagent`). Live, the row can be built straight off `system/task_started`.

**The sub-log nests.** `spawnDepth` is in the meta and the renderer is the same one, so a subagent's
own subagent is another `task` row that expands the same way. **No depth cap.**

### 9.3 Live sub-log — §4.2's pattern one level down

Chat sessions launch with **`--forward-subagent-text`** (confirmed through `docker exec -i`: 8 frames
carrying `parent_tool_use_id`, all keyed to the spawning `Task`'s `tool_use_id`). Main buffers those
frames by `task_id` and serves them as the sub-log while the turn runs; at `result` the buffer is
dropped and any later expand reads the sibling file.

**The flag is what makes the two sources match block-for-block.** Without it the stream withholds the
subagent's prose and thinking, so the sub-log would *grow paragraphs* at completion — a systematic
twitch, which is not what §4.2 wants twitches to mean. Its cost is roughly double the subagent frames
on a wire whose subagent frames are being filtered out of the main log anyway.

Reading the sibling file for the *live* view was rejected: it needs a `docker exec` per expand and
per poll, and §6.3 is precisely about treating that round-trip as the expensive operation.

### 9.4 Todos: collapsed rows in the log, a live strip above the composer

Every `TaskCreate`/`TaskUpdate` is a **one-line `todo` row**, collapsed the way §3.1 collapses reads
— it changed nothing on disk — so the log stays a complete record in order and nothing the agent did
is omitted.

```
14:22  todo   + Alpha step
14:22  todo   + Beta step
14:23  claude  Starting on the first one.
14:23  todo   Alpha step · pending → in_progress
14:25  todo   Alpha step · in_progress → completed
```

Strip item = status glyph + `activeForm` when `in_progress`, else `subject`.

### 9.5 The fold lives in main

Per session, folded over the whole conversation and rebuilt from the transcript on reopen; the
renderer receives the current list. **That is what keeps §4.3's 300-entry mount window from
truncating a todo created 400 entries ago** — a renderer-side fold would have lost it — and it
mirrors the existing split where main holds the full bodies and the renderer holds less.

The fold is a small entity store, not a snapshot swap:
`id → {subject, description, activeForm?, status, owner?, blockedBy[], blocks[], metadata}`, with
`deleted` **removing** the entry. `/clear`'s `conversation_reset` wipes it along with the log.

### 9.6 The strip mirrors the list exactly

Present whenever the list is non-empty, gone only when every task has been deleted, and **an
all-completed list keeps showing its ticks** — those tasks really are still on the agent's list and
it may reopen one. The strip cannot disagree with what the agent believes, which is the same
argument §4.1 used to reject a host-side mirror.

Hiding it at all-completed was rejected as motion the user did not cause; filtering to the unfinished
tail was rejected because it makes the strip a *filtered* view with a rule to remember, rather than a
view.

It lands in the **top band** of §3.4 — which also settles it **out of the header**, already full.

### 9.7 Both clocks: `Elapsed` on a host-read stamp

- **Subagent row.** Live: `Date.now()` stamped as the host reads `task_started` — the
  `AgentHookEvent.at` pattern `CLAUDE.md` sanctions — rendered with `Elapsed`, frozen via `until` at
  `task_updated`. Settled and on reopen: the reported **`totalDurationMs`**.
- **A tool row running past ~2s** (so a fast `Read` never flickers a number) shows `Elapsed` from
  the host read of its `tool_use` block, frozen when the `tool_result` lands.

**`tool_progress` is not ridden**, on §6.1's exact reasoning: an undocumented event a *user-initiated*
Claude Code update could remove is the silent breakage hooks were introduced to end — and it fired in
neither of #13's probes nor in #16's. Stepping the number off `task_progress.usage.duration_ms` was
also rejected: it only advances once per subagent tool call, so a subagent inside one slow call shows
a frozen reading that looks stalled.

This does **not** add a fourth home to #5's three clock homes — it is a different quantity (this
subagent) from the turn clock (this turn), and it reuses the one component in the app allowed to tick.

### 9.8 A blocking card raised inside a subagent — unattributed by default

**Build the unattributed card. It is the default, not the fallback.**

#13 designed an attributed card (`Explore is asking:`) with the spawning `task` row switching to
`waiting`. #16 probe 5 could not raise a blocking card inside a subagent **by either route**:
`AskUserQuestion` is **not in a subagent's tool list** (those tools are what
`--permission-prompt-tool stdio` adds to the *parent*), and an out-of-workspace `Read` raised no card
from the subagent *or* the parent. So the attributed form is designing for a state that may be
unreachable.

**Build the attributed form only if a card is ever actually observed carrying a `parent_tool_use_id`.**

### 9.9 What this changes in the mapper

Folded into §13. In summary: `isSidechain` is dropped **in the main mapper only** (the sub-log mapper
must keep it), the subagent `tool_use`+`tool_result` pair becomes one `task` row built from
`toolUseResult`, `TaskCreate`/`TaskUpdate` become `todo` rows that also feed the fold, and the
`subagents/` directory is **not** part of the main mapper — it is read on demand by `agentId`.

---

## 10. Context, model and cost chrome

*(#14, with its one probe answered by #16 probe 4.)*

**Two of the three readings survive, and both survivors become controls.** The header keeps exactly
#5's three items and gains no fourth — mode chip and model chip are things you *press*, and the
context meter is the only pure reading left, which is what makes the other two read as controls at
all.

### 10.1 Cost: nowhere

Not per turn, not per session, not behind a chip. `usage` and `modelUsage` go **unread** even though
they arrive free every turn.

This is a personal tool on a plan, so the dollar figure bills nobody, and the reading that *does*
bite — the 5h/7d plan windows — is already permanently on screen one row up in the title bar. A
session-total chip would spend header width restating a fiction; a per-turn number would ride §6.7's
turn-foot row, which was the strongest case, and it still lost to *you would never act on it*.

**One unknown dissolves rather than being answered:** whether `result.total_cost_usd` is this turn's
cost or a running total. Nothing now depends on it.

### 10.2 Context: `get_context_usage`, at open and at every `result`

Decided **against the recommendation** to derive the meter from `result.usage`. The argument for
deriving was that §6.1 had just refused an undocumented extra on silent-breakage grounds and this is
the same shape. Overruled on two differences that hold up: this is a **documented SDK method**, not
an env-var-gated event, and **the blast radius is cosmetic** — a blank activity state breaks the
sidebar `?`, the taskbar badge and the turn clock; a blank meter loses a bar.

The risk is bought off rather than ignored: **on failure the meter derives from `result.usage`**
(`input_tokens + cache_read + cache_creation`). The mechanism that lost the vote survives as the
degradation path, so the meter goes **approximate rather than absent**.

**Cadence: at open, and at every `result`.** The open-time call is the load-bearing half — §1.2 means
a chat reopened onto 80k of history has a live process that has said nothing about itself, so
refreshing only at turn end would show an empty meter at exactly the moment you look at it.

**Confirmed on the host** (#16 probe 4) with no user message ever written: `get_context_usage` and
`list_models` both returned `control_response/success` immediately, and again after a turn. Neither
errored, neither deadlocked. **The cadence stands.** Two corrections that came with it:

- The wire subtype is **`get_context_usage`**, not the SDK's `getContextUsage()` spelling.
- The pre-turn reading is already real — **10 529 tokens** of system prompt / tools / skills on an
  empty session. The response carries `totalTokens`, `maxTokens`, a rounded integer `percentage` and
  a `categories[]` breakdown, so **the meter renders from `percentage` alone** and the tooltip from
  `categories`. `maxTokens` came back as **1 000 000** on this model, so **the 85% threshold must
  stay a percentage, never a token count.**

**Form:** the bare 72×8 bar, steel → amber at 60% → red at 85%, hover tooltip carrying
`142k / 200k · 71%`. **No inline percentage** (that idiom belongs to the title-bar chips and costs
~30px here), and **not clickable** — a click sending `/context` was genuinely cheap, since it answers
headlessly at zero cost and renders as a `cmd` row, but it would make a header click **write to the
transcript**, which nothing else in the header does.

**Red at 85% is the entire warning.** No pre-compact row, no notice beside the meter, no
notification. Colour is already load-bearing chrome and red already means *attend to this*; saying it
twice in a 40px header is the one thing the header cannot afford. A compaction is also **not a
failure** — it is the tool working — so warning about it would alarm the user about routine behaviour
they can only act on by starting a new conversation, which `/clear` already offers. §13's
`compacted · 144k → 11k` divider remains the only mark a compaction leaves.

### 10.3 Model: a picker, and Vivarium owns the value

**`model` joins `mode` as a persisted field on `Session`** — the second departure from the
never-persist rule, argued exactly as §2.3 argued the first: mode and model are the same kind of
thing, a per-session user preference about how the agent runs, not runtime state. Making one an
exception and not the other would leave the invariant ledger arbitrary.

**Applied as `--model` at spawn**, in `execArgs` (`docker.ts:710`), which passes no `--model` today
and is a plain array — a two-line change, cheaper than a post-spawn control request.

**This is what settles ownership rather than dodging it.** §8.2's cache-as-hint pattern does *not*
stretch here: a stale slash-command suggestion can mis-suggest and never mis-execute, but a chip
reading `Opus` at reopen while the process actually spawned on the CLI's configured default is a
**reading that lies about a live fact**, in a header made entirely of readings, until turn one
corrects it.

- `setModel()` changes it mid-session.
- A typed `/model` — forwarded verbatim, intercepted in nothing — updates the field from the next
  `init`. So the chip has **two inputs and one truth**.
- **The menu's list comes from `list_models` on first open, cached in main for the app run.** Lazy,
  so no round trip until the menu is used; **in memory, never in `config.json`** — the list is global
  to the account and CLI version, so sharding it per project the way §8.2 shards commands would
  fragment a global fact, and persisting it would be a third dent in a rule this already dents twice.
  A stale entry can only mis-suggest: a `setModel()` that errors surfaces as a failed pick, not a
  wrong turn.

**A mid-session change shows as a derived divider**, `model · sonnet → opus`, in the same muted,
hueless treatment as the compacted divider. **Derived is the whole point:** every assistant message
carries its model in the stream *and* in the `.jsonl`, so the mapper emits the row when consecutive
assistant messages disagree, and §4.2's live-equals-reopened identity is satisfied structurally
rather than by care. It also gets the semantics right for free — switching and then not taking a turn
leaves **no** divider, because nothing ran differently. **The row marks where the model actually
changed, not where you clicked.**

### 10.4 `rate_limit_event` tops up the existing title-bar chips

The event carries the same five_hour / seven_day utilisation + `resetsAt` the title-bar chips poll
for every 3 minutes, and **the mapping is already written**: `parseSnapshot`'s
synthesize-from-two-windows branch (`src/main/usage.ts:57-73`) exists for exactly that shape. Main
merges the event into the last good `UsageSnapshot` and **re-stamps `fetchedAt`**, keeping the
staleness dimming truthful.

**The poll is unchanged and the stream cannot replace it:** a stream event is only as fresh as your
last turn, so an hour without talking to an agent tells you nothing while the poll has told you
twenty times. Backing the poll off while a chat streams was considered and dropped — more state to
get wrong against an endpoint the app already handles a 429 backoff for.

**Nothing rate-limit-shaped enters the chat header.** It is a global fact about the account, already
permanently on screen. Accepted cost: a stream-sourced top-up carries no `severity` and no per-model
limits, so the tooltip's detail stays whatever the last real poll said — invisible in practice, since
the chips render only the two windows and filter per-model limits out.

---

## 11. Transcript lifecycle on delete

*(#15, plus its own amendment after #13 landed.)*

**Delete means delete — for chat sessions, through a throwaway container, guaranteed by a debt list
rather than a sweep.**

### 11.1 The driver, corrected

The inherited premise was that attachments go in verbatim (§5.3) so growth must be bounded at the
deletion end. **That premise does not survive the numbers.** Twenty real transcripts weigh **15.8 MB**
— noise beside the multi-gigabyte shadow caches the Volumes dialog exists to reclaim — and the
sessions that actually grow are the live ones nobody deletes. **Disk is a rounding error and we stop
citing it as the reason.**

The real defect is that §4 made the transcript the **model** of the conversation, not a log of it.
Leaving the `.jsonl` after the UI says the session is gone leaves the conversation itself behind —
and it is not even unreachable: `claude --resume` with no id opens a picker over every conversation
in the `/workspace` slug, from any project's container shell.

### 11.2 Scope: chat only

Terminal `agent` sessions are **out of scope**. They keep stranding transcripts exactly as they do
today, consistent with the map already ruling migration and retirement of that type out. Shell
sessions are unaffected for free — `ipc.ts` only ever hands a `claudeSessionId` to sessions that own
a conversation.

### 11.3 What deletes what

- Deleting a **chat session** deletes its conversation.
- Deleting a **project** cascades to every chat session it holds. Without this the larger, more
  destructive gesture would be the leakier one — the way to *keep* a conversation would be to delete
  the whole project.
- Both take **the whole chain**: `claudeSessionId` plus every id `/clear` has retired (§11.6).

### 11.4 How: a throwaway container, uniformly

```
docker run --rm -v claude-box-creds:/home/node/.claude vivarium:slim \
  sh -c 'rm -rf /home/node/.claude/projects/*/<uuid>.jsonl /home/node/.claude/projects/*/<uuid>/ …'
```

- **Same glob as `claudeConversationExists`** (`docker.ts:757`), for the reason already written down
  there: globbing across the projects dir rather than hardcoding the escaped cwd keeps a change in
  Claude's path-escaping from silently breaking it.
- **`SLIM_IMAGE` is guaranteed present** wherever a transcript can exist, because `FULL_IMAGE` is
  built on top of it (`dockerfiles.ts`).
- **`-v` rather than `--mount` is legitimate here.** That invariant is about a Windows source path's
  drive-letter colon breaking the parser; a **named volume has no drive letter**.
- **A transcript is a directory, not a file** (#13's amendment): `<uuid>.jsonl` **plus**
  `<uuid>/subagents/*.jsonl` and `*.meta.json`. The original `rm -f …/<uuid>.jsonl` would have
  deleted the parent and orphaned every subagent file — and since §9.2 suppresses subagent frames
  from the main log and has them doing the bulk of the tool calls, that is most of the bytes *and*
  most of the conversation.
- **This escalates `rm -f` to `rm -rf` with an interpolated variable, and that argument must be
  written beside the command in the code, not left to be inferred.** The safety rests entirely on the
  uuid coming from `randomUUID()` — hex and hyphens, never user input. The blast radius of getting it
  wrong is no longer one file.

**`docker exec` was rejected, and this is the load-bearing choice.** Exec would need the project's
container alive, but `deleteProject` force-removes it in the same handler (`ipc.ts:149`) — so an
exec-based rule races a `rm -f` it shares a handler with — and a project sitting stopped, the normal
state for one you are deleting because you are done with it, has nothing to exec into at all. The
transcript was never really *in* the container; it is on a named volume any container can mount. So
running, stopped and already-destroyed collapse into **one path with no branch and no ordering
constraint.** The cost is a container start (a few hundred ms) per delete, behind a confirm dialog.

### 11.5 Scoping is structural, not a guard

**Naming one uuid *is* the scoping.** The glob can only ever match one conversation, so claude-box's
transcripts and other projects' transcripts are untouchable **by construction**. There is no
per-project directory to prune (every project writes to the one `-workspace` slug) and no exclusion
rule that could be got wrong. The subagent directory is *named after the uuid*, so the amendment
extends the glob without giving that up.

### 11.6 `/clear` retires an id; it does not delete

The cascade is **not** extended to `/clear`. §8's decision is that slash commands are forwarded
verbatim, nothing intercepted; bolting a file deletion onto `/clear` is interception in everything
but syntax, giving a Claude Code command a destructive side effect Claude Code does not have. And
`/clear` is one keystroke, unconfirmed, frequent and frequently a mistake — the worst
friction-to-consequence ratio in the design.

Instead the outgoing id is pushed onto **`Session.previousClaudeSessionIds: string[]`**, and the
delete cascade takes the whole chain. This **composes** rather than adding machinery: `/clear`
destroys nothing so an accidental one stays recoverable via the `--resume` picker; stranding is
bounded by the session's own lifetime instead of accruing forever; the cascade already loops, it just
loops over `[claudeSessionId, ...previousClaudeSessionIds]`; and the debt list already holds bare
uuids, so N of them is the same code.

Delete-means-delete gets **stronger**: deleting a chat takes everything it ever said, not only its
latest incarnation.

### 11.7 The debt list is the mechanism, not an error handler

Every delete records its uuids in the **same atomic `ConfigStore.mutate`** that removes the session,
then kicks a drain. There is no success path and no failure path — just *the debt is recorded*
followed by *the debt is paid*, where the fast case is a drain that runs immediately and succeeds.

Chosen over try-then-enqueue-on-failure because in that shape "the session is gone" and "we owe its
transcript" are two separate durable facts with a window between them: the config write lands, the
app dies or Docker hangs before the `docker run` returns, and the transcript is stranded with **no
record that anyone ever meant to delete it** — precisely the state the list exists to make
impossible. It also collapses the call sites: `removeSession` (`ipc.ts:189`) and `deleteProject`
(`ipc.ts:145`) both just enqueue inside the mutate they are already doing, neither branches on a
result, and the project handler's ordering problem against `docker rm -f` disappears, because enqueue
is a config write and cannot race a container removal.

- **Lives at `Config` top level**, not on `Project` — the project may be gone.
- **Not a never-persist exception.** That invariant forbids persisting what can be queried live; a
  deletion you owe is exactly a fact that cannot be, since Docker being down is *why* you owe it.
- **Drains on app launch and after each successful container start** — the two moments the daemon is
  proven up, with no new timer. Piggybacking the 3s container poll was rejected: `CLAUDE.md` already
  documents `isRunning` as reporting false for any non-zero exit, and hanging file deletion off a
  signal the codebase calls unreliable is asking for it — besides firing housekeeping twenty times a
  minute to service a list that is empty almost always.
- **One container for the whole drain** (`rm -rf` takes N paths), uuids dropped **only on exit 0**,
  so a failed drain leaves the debt intact. `rm -rf` exits 0 on a missing path, so a debt whose files
  are already gone self-clears.
- **Guarded by a volume-exists check**, or `docker run -v` would *create* `claude-box-creds` on a
  machine that has never run a container — housekeeping manufacturing the very thing the housekeeping
  dialog reports.

### 11.8 The delete always proceeds

Docker being unreachable never blocks it. **The precedent is already in the handler:**
`deleteProject` awaits `docker.remove(project)` and `remove` returns `void`, discarding the exit
code — with Docker down today the project vanishes from config and its **container survives**, along
with every shadow volume it created. That is a far larger stranded object than an 800 KB `.jsonl`,
and the app's answer has never been to refuse the delete. Giving the transcript veto power would make
the smallest thing on that list the only one that can block a delete, and *"you can't delete this
project because Docker Desktop isn't running"* is worse than the mess — especially since tidying up
is exactly what people do with Docker off.

No per-delete error is raised either: there is no action available at that moment, and the drain is
where the fact becomes actionable.

### 11.9 No sweep, ever — and the past is written off

`/home/node/.claude/projects/-workspace/` holds three populations that are **identical on disk** —
all `<uuid>.jsonl`, all cwd `/workspace`, uuids in the same format:

1. transcripts a live Vivarium session claims,
2. transcripts Vivarium created and orphaned,
3. **transcripts belonging to the user's claude-box setup**, which shares this volume on purpose.

A shadow volume can be swept because its name carries a hash of the host path, so `isOrphan`
(`Volumes.tsx:42`) can *prove* nothing claims it. Transcripts have no such handle.
**Sweep-by-exclusion cannot distinguish (2) from (3)**, and getting it wrong silently destroys real
conversations on the one volume `CLAUDE.md` singles out as never removable because "the Claude
sign-in and every agent's memory live there." That is an unacceptable bet for reclaiming megabytes,
and the only place in this area where a wrong answer does damage rather than leaving mess.

The debt list inverts it: instead of scanning a directory and inferring ownership, record the debt
when it is incurred. It can only ever name a uuid the user explicitly deleted, so **safety is
structural rather than heuristic**, and it needs no UI at all.

**The price, paid deliberately: everything stranded before today stays.** Those deletes left no debt
record, and the only way to find their files is the inference just ruled out. They remain reachable
through the `--resume` picker in a container shell, and Vivarium never mentions them.

### 11.10 The confirm states it, and costs nothing extra

Silence is incompatible with the driver: if delete means delete, the delete has to say so. The
current copy is already too quiet — `ConfirmKill` says *"This stops X and closes its terminal. The
container keeps running"* and never mentions the session leaves config at all. For a chat that title
and sentence are doubly wrong: nothing is killed, there is no terminal, and the thing actually
destroyed goes unnamed.

`ConfirmDeleteProject` has the right shape to extend — *"…force-removes its container. Your folders
on the host are not touched"* draws a boundary, this goes and that does not. **The conversation
belongs on the "this goes" side of that sentence.**

**The word is "conversation", never "transcript."** Nobody deleting a session is thinking about a
`.jsonl` on a named volume. It is honest in both directions — it also warns that a `--resume` they
might have counted on will not work afterwards.

**No added friction.** The Volumes dialog removes multi-gigabyte volumes on a single unconfirmed
trash click (`Volumes.tsx:157`); making one conversation the heaviest destructive gesture in the app
would be wildly out of proportion. Same danger-button confirm, better words. Since `confirmKill` now
serves terminals and chats both, **its title and body vary on whether the session owns a
conversation** ("Delete chat?" / "Kill session?") rather than one sentence straining to cover both.

### 11.11 Falls out for free

- **Moving a session between projects is untouched.** The chain rides on the `Session` object, so it
  transfers exactly as `claudeSessionId` does today — no deletion, no debt.
- **A debt list cannot grow meaningfully.** Each entry is a uuid, and `rm -rf` clears entries whose
  files have already gone.

---

## 12. Failure surfaces

*(#16, all seven handed-over probes run on the host against a live container, 2.1.211.)*

**The spine is what the client can actually detect, not what broke.** Detection turned out far
thinner than the map assumed.

| Failure | Detected by |
| --- | --- |
| Container stopped | the existing container poll |
| Process dies mid-turn | **the process exit code, and nothing else** |
| Transcript read fails | the read's own rejection |
| Auth / whole-CLI failure | **nothing — needs a silence timeout** |
| Transport desync | a line that will not parse |

### 12.1 Container stopped — `StoppedPlaceholder`, verbatim

The same component the `agent` and `container-shell` types already get
(`TerminalHost.tsx:197,208`), the same "Start container" button, the same explicit-user-action rule.
**No chat-specific variant:** it is the same physical fact, and §4.1's container-side `docker exec
cat` makes a greyed-out log impossible anyway.

This is the one screen where §4.1's accepted cost becomes visible, and the placeholder is exactly the
right place for it to land — **it already says the container is stopped, which *is* the reason there
is no history.**

### 12.2 Process dies mid-turn — §7.1's row, in red

**Probe 1: killing the in-container `claude` mid-stream is completely silent.** No `result`, no error
line, no `terminal_reason`, and **no torn line** (`badLines = 0`). The stream simply stops and
`docker exec` exits **137**. *The exit code is the only signal.*

```
14:31  stop     claude exited (code 137) · 3 malformed lines
```

Same gutter position as `interrupted`, reusing §7's vocabulary rather than inventing a second one,
but **red — the one place colour appears in the log body**. #5 reserved colour for *attend to this*,
and §7.1 correctly spent none of it on an interrupt because that is something the user just did; a
crash is not. Everything else follows §7 unchanged: **the partial assistant text stays plain**, and
there is **no duration** — now confirmed as no `turn_duration` rather than merely declined.

The exit code is shown because it is genuinely all there is, and **137 vs 1 is the difference between
"the container was OOM-killed" and "the CLI fell over"** — the only diagnostic the user gets.

**The reopen asymmetry, and the mapper rule that closes it.** The transcript holds the `user` line
plus its attachments and **no assistant line at all**, so **the partial text the user watched stream
is not recoverable on reopen** — where an interrupt's is. This is the one place in the whole design
where §4.2's live-equals-reopened identity **structurally cannot hold**.

A reopened chat would otherwise show a user message followed by nothing, which reads as a lost
message. So the mapper gains a rule exactly parallel to §7.1's:

> a transcript whose **final** entry is a `user` message with no assistant reply renders the same red
> `stop` row.

Live and reopened then agree on the row from two sources, and differ only in the partial text —
which reopened cannot have, because none was ever written. **That difference is stated here rather
than papered over**; the alternative was writing our own marker into the transcript, which §4.1
forbids.

### 12.3 Transcript read fails — a banner above the log, with Retry

**Not a gutter row:** the gutter is a timeline and a failed read is not an event in time. The log
body stays as it is and the chat **stays usable** — the process spawns fine, only the history is
missing — so this is a banner, not a `StoppedPlaceholder`-style takeover.

It **clears on a successful read, never on a dismiss**, because the condition it reports is still
true until then.

One consequence to state: while it is up, the context meter (§10.2) reads against history the log is
not showing, so **a short log with a full meter is correct rather than a bug.**

### 12.4 Auth / whole-CLI failure — a 60s silence timeout, because there is no error

**Probe 2 forced this design.** Run against a throwaway `HOME` so `claude-box-creds` was never
touched, both with **no credentials** and with a **structurally-valid but invalid OAuth credential**,
the CLI emitted a **normal-looking `system/init`** (full tool list, model, `permissionMode`) and then
produced **nothing at all** — no error, no result, no exit, still alive at 45s, stderr silent. Both
variants identical.

*(Caveat: an induced-absent credential is not provably the same code path as a genuinely expired
token, which cannot be induced without breaking the real sign-in. The observed **shape** — init then
indefinite silence — is what the surface is designed against, and it was the same for both variants
tested.)*

So a turn is failed when the stream has produced **no frame of any kind for 60s** after the user's
message. **The threshold is on *any* frame, not on `result`** — a working turn emits `assistant` and
`system` frames continuously (thinking, tool calls, `task_progress`) while the broken CLI emitted
precisely zero after `init`, so 60s is safe against a genuinely long turn in a way a result-based
timeout never could be.

Surface: the same red `stop` row — `stop  no response for 60s` — plus Retry.

**`UsageSnapshot.error === 'auth-expired'` is *not* the detector** (it is the usage endpoint, a
different fact, and can be healthy while the CLI is broken or vice versa) **but it *is* consulted for
the copy:** when it is set at the moment the chat times out, the row names the likely cause and
points at the existing remedy. That reuses the app's auth surface without letting a cosmetic poll
gate a chat.

### 12.5 Transport desync — drop, count, surface on exit

The line is **dropped**, following `BridgeWatcher`'s precedent that a half-written line must never
reach the store as an event. A dropped chat line is content the user wanted to read, but a *visible*
marker per fragmented write would turn one bad write into garbage across a healthy turn.

So main keeps a **per-turn counter** and the count appears **only on a row that was already going to
be shown** — the red `stop` row, as `· 3 malformed lines`. Silent in the normal case, diagnosable
when it matters. Probe 1 makes this cheap to trust: **not one torn line appeared even under SIGKILL
mid-stream**, so a nonzero count is a real signal rather than expected noise.

### 12.6 The recoverable-vs-terminal rule

**The chat has no terminal states.** Every failure above is recoverable in place by the same single
act — **respawn the process and re-read the transcript** — because §4 already put the conversation in
the transcript rather than in the process. Nothing is lost by respawning that was not already lost.

That collapses to one rule and one code path:

- **Container stopped is not a chat failure at all.** It is recovered by starting the container, on
  the existing placeholder, and is the **only** state the chat cannot recover from on its own.
- **Everything else gets one `Retry`**, in one of two places — the banner (read failure) or the red
  `stop` row (crash, timeout, desync) — and all of them run the same recovery.

**Recovery is never automatic**, following the precedent `ipc.ts` already sets by refusing to
auto-start a container on `openSession`: a respawn costs a process and a 14.6 MB-class transcript
read, and a crash loop that retried itself would be invisible. **One deliberate emphasis: the 60s
timeout row must not be retried automatically either**, since a genuinely wedged CLI would otherwise
be respawned every minute for as long as the app is open.

---

## 13. The complete mapper

*(§4.2 decided the shape; #9, #12, #13, #14 and #16 each added a rule. This is the assembled
whitelist — build from this section, not from #7 alone.)*

**Why a whitelist and not a blacklist.** `attachment` alone is 2 313 lines in the 20-transcript
sample, of which 1 877 are `total_tokens_reminder` and 242 `task_reminder` — injected context, not
conversation. New line types keep appearing as Claude Code ships; **a whitelist degrades by missing
something, a blacklist degrades by rendering garbage.**

### 13.1 Mapped line types

| line | renders as |
| --- | --- |
| `assistant` → `text` block | prose row, markdown, `claude` gutter |
| `assistant` → `thinking` block | a `think` row **collapsed to its first line** with `▸ show` |
| `assistant` → `tool_use` + its matching `tool_result` | **one** tool card, paired by `tool_use.id` |
| `user` → `text` block / string | the tinted `you` row |
| `user` → `image` block | attachment chip (§5) |
| `user` wrapped in `<command-name>` tags | a `you` row showing `/model` (§8.3) |
| `system` / `subtype: local_command` | a **`cmd`** row, `<local-command-stdout>` stripped, markdown, open-and-truncated (§8.3) |
| `tool_use` named `Skill` | the same `cmd` row (§8.3) |
| the subagent tool's `tool_use` + `tool_result` | one **`task`** row built from `toolUseResult` (§9.2) — keyed off `toolUseResult.agentId`, **never the tool name** |
| `TaskCreate` / `TaskUpdate` | a one-line **`todo`** row, which also feeds main's fold (§9.5) |
| `system/compact_boundary` | a full-width divider, `compacted · 144k → 11k tokens` (`preTokens`/`postTokens`/`trigger`) |
| `system/turn_duration` | the real duration on each past turn (§6.8) |
| **derived:** consecutive assistant messages disagreeing on model | a `model · sonnet → opus` divider (§10.3) |
| **`user` whose sole `text` block is exactly `[Request interrupted by user]`** | the muted **`stop  interrupted`** row (§7.1) |
| **a `user` message that is the final entry with no assistant reply** | the **red `stop`** row (§12.2) |

The `compact_boundary` row is not decoration: without it the log reads as continuous when it is not,
and the user is left wondering why the agent re-reads a file it already read. `turn_duration` makes
reloaded history *richer* than what the stream painted — the one direction in which asymmetry is
welcome.

### 13.2 Dropped

`mode`, `permission-mode`, `last-prompt` (a duplicate of the prompt itself), `ai-title`,
`agent-name`, `file-history-snapshot` / `-delta`, `queue-operation`, every `attachment` line,
`isMeta` user messages (including `/x`'s expanded prompt), `system/away_summary`.
`<system-reminder>` and `<local-command-caveat>` text is stripped out of user turns before they
render.

**`isSidechain` is dropped in the main mapper only.** Every line in a subagent file carries it and
the sub-log mapper **must keep them**. #7's drop rule was right for a reason it did not know: this
version writes *no* sidechain lines into the parent file at all — there is nothing there to inline.

**`system/local_command` is no longer dropped** — #7 listed it among the drops, #9 promoted it. See
§17.

### 13.3 Not part of the main mapper

The `subagents/` directory. It is read **on demand, by `agentId`**, through `chat:subagent` (§9.2).

### 13.4 The one accepted prose-parsing fragility

An answered `AskUserQuestion`'s ticked chip is recovered by **parsing the `tool_result` prose** back
against the `options` in the `tool_use` input — the transcript stores it as
`Your questions have been answered: "<question>"="<label>", …`. An approved plan is likewise
`User has approved your plan…` plus the plan markdown; "keep planning" is a `deny` and reads
differently.

**The mapper owns that string-matching and needs a graceful fallback** — render the options un-ticked
— when the format changes under us.

This is the *only* prose-parsing rule in the design, deliberately. §7.3 detects a cancelled tool
**structurally** rather than by wording precisely so this stays one and does not become a pattern.

---

## 14. Types and IPC surface

### 14.1 `src/shared/types.ts`

```ts
export type SessionType = 'agent' | 'chat' | 'container-shell' | 'host-shell'

export type ChatMode = 'plan' | 'bypassPermissions'

export interface Session {
  id: string
  name: string
  type: SessionType
  /** For `agent` and `chat` sessions: Claude Code's own conversation id. NOT
   *  write-once for chat — /clear mints a new one (§8.5). */
  claudeSessionId?: string
  /** chat only. Ids retired by /clear; the delete cascade takes the whole chain (§11.6). */
  previousClaudeSessionIds?: string[]
  /** chat only. Persisted user preference, not runtime state — see the ledger (§15). */
  mode?: ChatMode
  /** chat only. Same exception; applied as `--model` at spawn (§10.3). */
  model?: string
}

export interface Config {
  version: 1
  projects: Project[]
  sharedOutputFolder?: string
  diffBase?: string
  /** Conversations owed a delete, enqueued in the same mutate that removed the
   *  session. Not a never-persist exception: a deletion you owe is exactly a fact
   *  that cannot be queried live (§11.7). */
  pendingTranscriptDeletes?: string[]
}

/** Replaces AgentHookEvent. Both producers — bridge.ts for pty agents, the chat
 *  stream reader for chat — emit this; the store cannot tell them apart (§6.2). */
export interface AgentActivityEvent {
  sessionId: string
  activity: AgentActivity
  /** host-stamped; see the note that was on AgentHookEvent.at */
  at: number
  /** the one bit a state cannot carry: a queued prompt restarts the turn (§6.2) */
  turnStart?: true
}
```

`AgentActivity` is unchanged. `AgentHookKind` stays — it is `bridge.ts`'s internal vocabulary now and
no longer crosses IPC.

### 14.2 `src/shared/ipc.ts` — `CH` additions

```ts
  // chat sessions — granular out, ONE union in. `chat:event` is the only channel
  // in this object that carries a discriminated union rather than one kind of
  // payload, and it is deliberate: entry-append, turn-end replacement, blocking
  // cards, task/todo, reset and exit are strictly ordered, and Electron guarantees
  // ordering only *within* a channel. Split them and a blocking card can overtake
  // the text it refers to (§6.5).
  chatOpen: 'chat:open',
  chatSend: 'chat:send',
  chatInterrupt: 'chat:interrupt',
  chatAnswer: 'chat:answer',
  chatSetMode: 'chat:set-mode',
  chatClose: 'chat:close',
  chatBody: 'chat:body',
  chatEarlier: 'chat:earlier',
  chatSubagent: 'chat:subagent',
  chatMountTree: 'chat:mount-tree',
  chatEvent: 'chat:event',

  agentActivity: 'agent:activity',   // was agentHook: 'agent:hook'
```

### 14.3 `ChatEvent` kinds

`entries-appended` · `turn-settled` (§4.2's replacement) · `blocking` (a pending card) ·
`blocking-cleared` · `task` · `todo` · `activity` · `context` · `reset` (§8.5) · `error` (§12) ·
`exit`.

### 14.4 Adding this feature touches the four places in order

Per `CLAUDE.md`: channel name in `src/shared/ipc.ts` → handler in `src/main/ipc.ts` → typed method in
`src/preload/index.ts` → renderer call via `window.vivarium.*`, usually from a store action. The
renderer never touches `ipcRenderer` directly. **No exceptions for chat.**

New main-process module: `src/main/chat.ts` (`ChatService`), next to `pty.ts` and shaped like
`PtyManager` — one live process per session id, plus the transcript reader, the byte offset, the full
bodies cache, the todo fold and the subagent buffer.

---

## 15. `CLAUDE.md` edits and the invariant ledger

**This section is part of the deliverable.** The map's destination includes updating `CLAUDE.md`, and
four separate tickets each left an edit here.

### 15.1 The narrowings

1. **The no-reattach invariant narrows to terminal sessions.** Current wording: *"Agent sessions die
   with the app and cannot be reattached across restarts — accepted model, don't add tmux/reattach
   logic."* This effort reopened it deliberately, and both research tickets landed on the same answer
   from opposite directions. **A chat session genuinely does recover its conversation across a
   restart** — chat and pty share one transcript, so history costs nothing — but **a live turn still
   dies with the app**, and no detached process is built. Rewrite it to say exactly that; detachment
   itself is Out of scope (§15.5).

2. **The `TerminalHost` mount rule narrows: terminals *must* stay mounted, chat *may*.** Nothing in a
   chat is unrecoverable (§4.4). `toRender` still gains **no chat arm** — the `live[]` clause is kept
   for cheapness, not survival (§6.6), and that reason should be written into the comment so nobody
   later "fixes" it by adding a type branch.

3. **The hook gotchas narrow to pty agents.** `Stop` not firing on Esc and `PostToolUse` not firing
   on reject are **TUI artifacts**; neither exists over stream-json. `TerminalView`'s
   Esc-resets-the-indicator and Enter-answers-a-prompt paths (`TerminalView.tsx:371`, `:382`) are
   pty-agent-only and **must not be reproduced in the chat**. Scope that paragraph explicitly.

4. **The agent-detection paragraph bends.** Hooks remain the mechanism for pty `agent` sessions; chat
   **derives the triple from the ordinary stream** (§6.1), and both producers now emit
   `AgentActivityEvent` over `agent:activity`.

### 15.2 The never-persist exceptions

`CLAUDE.md` says runtime state is *"queried live, never persisted"*. That rule now has **three**
deliberate exceptions on `Session` / `Config`, and the reason is the same each time: these are
**per-session user preferences, not runtime state observed from Docker** — which is exactly what
`config.json` is for.

| field | ticket | argument |
| --- | --- | --- |
| `Session.mode` | #11 | a per-session preference about how the agent runs |
| `Session.model` | #14 | the same kind of thing; making one an exception and not the other would leave this ledger arbitrary |
| `Session.previousClaudeSessionIds` + `Config.pendingTranscriptDeletes` | #15 | **not** an exception at all — a deletion you owe cannot be queried live, since Docker being down is *why* you owe it |

Two things deliberately **not** persisted, for contrast: the `list_models` result (global to the
account, cached in main for the app run only — §10.3) and the composer draft + pending chips (§6.4).
The **per-project slash-command list *is* cached in `config.json`** (§8.2) and is admissible on a
different argument — it is a **hint, never authority**.

### 15.3 The invariant ledger

Every existing invariant the chat type touches, and whether it holds, bends or breaks.

| Invariant | Verdict | Why |
| --- | --- | --- |
| A terminal's lifetime follows its pty, not the container probe | **holds** | the `live[]` clause is kept for chat too (§6.6) — for cheapness rather than survival |
| A session is live whenever it can be, not when it was last clicked | **holds** | eager open at container start (§4.4) |
| `OPEN_LIMIT` caps the burst / hands slots straight to waiters | **holds** | same gate, one slot per chat open — **but a slot now covers a bulk transfer, and the comment must say so** (§6.3) |
| Moving a session transfers the conversation for free — and only that | **holds** | and chat is strictly better: an identical log after the move, not a dropped scrollback (§6.4) |
| An attention flag is cleared by viewing; focusing the window is viewing | **holds** | one type guard widens (`store.ts:711`); nothing else in the path is type-aware |
| A turn duration is a stopwatch on the host clock | **holds** | live readings stay host-stamped; `turn_duration` is pre-computed and never subtracted, so it **sidesteps** the rule (§6.8) |
| Bind mounts use `--mount`, never `-v` | **holds** | §5 changes no mounts at all; §11.4's `-v` is a **named volume**, which has no drive letter — the parser bug the rule exists for cannot arise |
| Volumes are only ever removed from the Volumes dialog | **holds** | §11 removes *files on* `claude-box-creds`, never the volume |
| Runtime state is queried live, never persisted | **bends** | three fields, §15.2 |
| Agent idle/working detection is driven by Claude Code hooks | **bends** | chat derives from the stream (§6.1); the bridge stays for pty `agent` sessions, and both now emit states (§6.2) |
| Hook gotchas: `Stop` not firing on Esc, `PostToolUse` not firing on reject | **narrows to pty agents** | neither exists over stream-json; the chat must not carry the workarounds |
| `TerminalHost` keeps one long-lived view per session | **narrows** | terminals *must*, chat *may* (§4.4) |
| No multiplexer; sessions die with the app | **narrows** | chat recovers its **conversation**; a live turn still dies (§15.1) |
| `ptyData` / `ptyExit` as separate channels | **departs** | one `chat:event` union channel, for an ordering guarantee separate channels do not give (§6.5) |
| Claude Code is never auto-updated | **holds, and is load-bearing** | it is *why* §6.1 refuses the gated event and §9.7 refuses `tool_progress` |
| Mounts may only change while the container is stopped | **holds** | §5.2 never changes a mount — which is why "just add a mount" was never a cheap answer for attachments |

### 15.4 New paragraphs `CLAUDE.md` needs

- `chat` in the architecture blurb and in the `theme.ts` / `SESSION_TYPES` note (§3.5).
- `src/main/chat.ts` in the `src/main/` file list.
- The `chat:event` union as a documented, deliberate departure (§6.5).
- Delete-means-delete for chat conversations, with the `rm -rf`/`randomUUID()` safety argument
  (§11.4).
- The 60s silence timeout and the no-auto-retry rule (§12.4, §12.6).

### 15.5 Out of scope — recorded so it is not re-litigated

- **Detaching the Claude process so a live turn survives the app.** Mechanically possible
  (`docker exec -d` + FIFO + NDJSON spool), but it buys only an *in-flight* turn — history recovers
  without it — at the price of an agent-lifecycle burden the app does not carry today (idle reaper,
  deliberately-stopped bit, respawn). Returns as its own effort if losing an in-flight turn actually
  bites. *(Claude Code now ships its own `claude --bg` supervisor, which validates the shape but is
  the wrong door here: TUI data plane, in-memory output, self-isolating worktrees.)*
- **Migrating existing agent sessions, and retiring the `agent` type.** Explicitly later.
- **Transcript lifecycle for terminal `agent` sessions** (§11.2). The rule keys on the session owning
  a conversation, so it extends to `agent` unchanged if that effort ever happens.
- **Chat for container-shell and host-shell sessions.** Those are terminals on purpose.
- **A bespoke agent loop against the Anthropic API.**

---

## 16. Stated costs and known gaps

Every one of these was accepted deliberately by the ticket that found it. They are listed together so
the build does not rediscover them as bugs.

1. **No history while the container is stopped** (§4.1). The transcript is container-side by design;
   §12.1 lands it on the placeholder that already explains it.
2. **An `OPEN_LIMIT` slot now covers a 14.6 MB transfer**, not a probe (§6.3). An interactive open
   can queue behind up to three of those. `ipc.ts:488`'s comment must be rewritten.
3. **Split-send writes two user rows for one send** (§8.6) — precisely the drift §4.2 exists to
   prevent. The stitch is in the mapper and **whoever builds it owns closing that gap.**
4. **`tasks/<task_id>.output` is unreachable by any uuid-shaped handle** (§11). Keyed by `task_id`,
   which has no relationship to `claudeSessionId`, and those files land outside `~/.claude/projects`
   entirely. A path ledger was rejected: it trades a bare uuid chain for a growing list of absolute
   paths on `Session`, motivated only by disk reclamation, which §11.1 demoted to a rounding error.
   Tool scratch output is also the weakest possible claim on "the conversation".
5. **A crashed turn's partial text is unrecoverable on reopen** (§12.2) — the one place
   live-equals-reopened structurally cannot hold. Stated, not papered over.
6. **Everything stranded before today stays** (§11.9). No sweep, ever.
7. **A stream-sourced usage top-up carries no `severity` and no per-model limits** (§10.4) —
   invisible in practice.
8. **A move drops the draft and every pending chip** (§6.4). The confirm dialog says so.
9. **A typed `/model` may write through to the shared `claude-box-creds` config** and leak into pty
   `agent` sessions and claude-box (§10.3). Chat sessions are immune — `--model` at spawn wins — and
   this is pre-existing behaviour today. Worth stating, not worth gating on.
10. **The turn clock's frozen number can visibly jump** when the host stopwatch and `turn_duration`
    disagree (§6.8) — in practice, a turn that spanned a host sleep.
11. **The Anthropic SDK note.** The SDK overview states Anthropic *"does not allow third party
    developers to offer claude.ai login or rate limits for their products, including agents built on
    the Claude Agent SDK"* without prior approval. Vivarium is personal/internal with no external
    users, so this does not obviously bind — but it is a statement about **the SDK specifically**,
    and the plain-CLI path this spec builds on carries no such note. Framing the NDJSON by hand and
    keeping `sdk.d.ts` / `sdk-tools.d.ts` purely as types stays available and is the recommended
    fallback if the SDK's argv proves coupled to its own version.

---

## 17. Corrections later tickets made to earlier ones

Where two tickets disagree, **the later one wins** and this is the list.

| Earlier | Later | The correction |
| --- | --- | --- |
| **#4** recommended an adapter in main emitting the existing `AgentHookEvent` shape, "so the store cannot tell the two apart" | **#8** (§6.2) | **Reversed.** The two sources unify **at the event, not the channel**: `AgentHookEvent` → `AgentActivityEvent`, `agent:hook` → `agent:activity`, and the hook→state mapping moves into `bridge.ts`. Main would otherwise have to emit `'ExitPlanMode'` to mean "waiting", and the working-directory prompt has no hook kind to lie with at all. |
| **#7** recommended deriving the context meter from `result.usage` | **#14** (§10.2) | **Decided against.** A documented SDK method with a *cosmetic* blast radius is a different bet than an env-gated event that would blank the sidebar and the badge. The derive-it mechanism survives as the **degradation path**. |
| **#7** recommended an inert mount (read on first select, spawn on first send) | **#7's own resolution** (§4.4) | Decided against by the same ticket: eager open keeps *"a session is live whenever it can be"* true for chat. |
| **#13** designed an **attributed** subagent blocking card (`Explore is asking:`) as the primary form | **#16** probe 5 (§9.8) | **Demoted to the fallback — build unattributed as the default.** Neither route could raise a card inside a subagent at all. Build the attributed form only if one is ever observed carrying a parent id. |
| **#7** listed `system/local_command` among the dropped line types | **#9** (§8.3, §13.2) | **Promoted to the whitelist** as the `cmd` row. Without it `/context` renders and then *vanishes* at `result` when the turn is replaced by transcript-derived entries. |
| **#7**'s whitelist would render `[Request interrupted by user]` as a tinted `you` row | **#12** (§7.1) | **One rule added.** It is a `user` message with a plain `text` block, so the default was a lie — "as though you had typed the words." |
| **#15**'s `rm -f …/<uuid>.jsonl` | **#13**, landing mid-ticket (§11.4) | A transcript is a **directory**. `rm -f` → `rm -rf` with the uuid glob extended to `<uuid>/`, and the `randomUUID()` safety argument now has to be written beside the command. |
| **#5**'s open-by-default for `bash`/`edit` | **#12** (§7.3) | **First exception:** a cancelled card collapses, because its synthetic result carries only a refusal sentence. |
| **#2**/**#4** treated `system/session_state_changed` as promising-but-absent | **#10** found it, **#8** refused it (§6.1) | It exists and is a 1:1 match — and is **not used**, because an undocumented env-gated signal in a hand-updated CLI is silent-breakage-shaped. |
| **#12** left the `is_error` vs `terminal_reason` question implicit | **#16** probe 3 (§1.4) | **`is_error` cannot discriminate a user interrupt from a failure.** Only `terminal_reason` can. #12 already keyed on it; #16 inherits the discipline rather than adding a second test. |
| **#9** proposed a **denylist** of commands to block | **#9's own probing** (§8.1) | **Dropped once probing killed its premise:** nothing is inert, so a hand-maintained list would hide working commands and still go stale. |
| **#15** inherited from **#6** that disk growth was the driver | **#15** (§11.1) | **Premise dead.** Twenty transcripts weigh 15.8 MB. The driver is that §4 made the transcript the *model* of the conversation. |
| **#13** assumed `TodoWrite` with `{oldTodos, newTodos}` (read out of `sdk-tools.d.ts`) | **#13's probes** (§9.1) | **The tool does not exist.** The live tools are `TaskCreate`/`TaskUpdate`, **incremental, not a snapshot** — so a strip must accumulate rather than read a latest value. |

---

## 18. What is unverified

Stated rather than assumed. Nothing in this list blocks the build; each names what would change if it
turns out otherwise.

**Version skew**

- Everything host-verified ran against **Claude Code 2.1.211** in a live container. The research
  probes ran against **2.1.220** on the Windows host. Behaviour on other versions is untested, and
  this app hands the user a manual update button — `system/init.capabilities[]` is the intended
  feature-detection surface rather than version comparison.

**Transport**

- **`spawnClaudeCodeProcess` against a container** — documented and typed, never exercised.
- **Long-session behaviour**: compaction mid-stream, hour-long turns, large `.jsonl` replay. All
  probes were seconds long.
- **The control-protocol frames** are typed in `sdk.d.ts` but several request subtypes are
  non-exported internals. Speaking them by hand is speaking a semi-private protocol; the two that
  matter (`interrupt`, `can_use_tool`) are `capabilities`-flagged.
- **`updatedInput.plan` on approval** — the CLI clearly intends host-edited plans, but the downstream
  effect on the model's approved-plan text was not established.
- **Interrupt arriving while a `can_use_tool` request is outstanding** was probed as
  deny-then-interrupt (confirmed, §7.5); a **bare** interrupt against an outstanding request was not.
  The chosen order is the defensive one for exactly this reason.
- **`multiSelect: true` questions**, and the `response` / `annotations` fields end-to-end — read from
  the CLI's result builder, not exercised.

**Subagents**

- **Whether a subagent's `can_use_tool` carries `parent_tool_use_id`** — inconclusive, because
  neither route could raise a card inside a subagent at all (§9.8). Build unattributed.
- **The one thing #16 could not reconcile with #10:** #10 found bypass leaves a **working-directory
  guard** standing (a `Write` to `/tmp` prompted with `decision_reason_type: "workingDir"`), but
  #16's out-of-workspace `Read` of `/etc/hostname` raised **no** `can_use_tool` from the subagent
  *or* the parent, and #6's `Read /tmp/probe.png` raised none either. #10 tested a path outside the
  **mounts**; #16 tested a path inside the container filesystem but outside `/workspace` —
  **plausibly a different guard.** Recorded as **unreconciled**, not as a correction to #10.
  **What depends on it:** §6.1's "`waiting` is any pending `can_use_tool`" is *more* correct if the
  guard fires and merely unexercised if it does not, so the derivation is safe either way. §5.1's
  routing is likewise safe — it observed the permissive behaviour directly.

**Transcript lifecycle**

- Docker was down on the host during #15, so **the real `-workspace/` directory was never measured
  and the throwaway `docker run` was never executed end-to-end.** Both are mechanical and the
  transport facts they rest on were verified by #10.
- **The subagent directory's on-disk size** was never measured.

**Failure surfaces**

- **An induced-absent credential is not provably the same code path as a genuinely expired token**
  (§12.4). The observed *shape* — init then indefinite silence — is what the surface is designed
  against, and it was identical for both variants tested.

---

## 19. Build order

Dependencies, not a schedule. Each step should leave the app running.

1. **Types and plumbing.** `SessionType` gains `chat`; `theme.ts` gains a fourth `SESSION_TYPES`
   entry and `TypeIcon` arm; `CH` gains the chat channels; `AgentHookEvent` → `AgentActivityEvent`
   and the hook→state mapping moves into `bridge.ts` (§6.2, §14). **Do this first** — it touches
   the existing agent path, and doing it later means doing it twice.
2. **`src/main/chat.ts`: transport only.** Spawn, NDJSON framing, `chat:open`/`chat:send`/`chat:close`,
   `chat:event` with `entries-appended`. Verify a turn round-trips.
3. **The mapper and the transcript read** (§4, §13). Byte offset, turn-end replacement, truncation,
   `chat:body` / `chat:earlier`. This is the piece the rest leans on.
4. **The window** (§3): log, gutter, header, composer, the three-band pinned region.
5. **Activity derivation** (§6.1) and the turn clock row (§6.7). At this point the sidebar `?`, the
   taskbar badge and `Elapsed` all work for chat.
6. **Blocking cards** (§2.2) — plan and question, with `deny`, `allow` + `setMode`, and the `answers`
   map. The mode toggle (§2.3) falls out of the same handler.
7. **Interrupt** (§7). Esc, the `stop` row, deny-then-interrupt, the notification suppression.
8. **Failure surfaces** (§12) — the crash row, the 60s timeout, the read banner, the desync counter,
   one Retry path. Do this before attachments: it is where the crash-loop discipline gets set.
9. **Attachments** (§5), including split-send and its mapper stitch (§8.6, cost 3).
10. **Slash commands** (§8) — forwarding is free; the `/` menu, the `cmd` row and `/clear` are the
    work.
11. **Context meter and model picker** (§10).
12. **Subagents and todos** (§9). Last of the floor-adjacent work, and the only part that adds a
    second read path.
13. **Delete lifecycle** (§11) — the debt list, the drain, the confirm copy.
14. **`CLAUDE.md`** (§15). Not optional and not a follow-up: four tickets each left an edit here, and
    the invariant ledger is the thing that keeps the next change honest.

**Ships after the floor, without changing the model:** turn folding (§8.4), the attributed subagent
card (§9.8, only if ever observed), and a header stop control (§3.7, only if Esc-only bites).

---

*Assembled 2026-08-01 from map [#1](https://github.com/Barni52/vivarium/issues/1), tickets #2–#16.
Where this document and a ticket disagree, this document is later and wins; where it is silent, the
ticket is the record.*
