// SPDX-License-Identifier: BUSL-1.1
/**
 * The one Agent Skill this server ships itself.
 *
 * Every other skill on this transport is contributed by a plugin and is about
 * that plugin's subject (`RuntimeAgentSkill`, projected by `agent-skills.ts`).
 * This one is about the transport: how to get from a person's request to the
 * capabilities THIS session actually lists, which is the part no plugin can
 * state because none of them knows what else is loaded.
 *
 * It is deliberately a skill and not more server `instructions`. The
 * instructions are read unasked by every client at `initialize` and are
 * already long; this is the detail a model needs once it is actually about to
 * act, so it is fetched on demand through the same `skills/get` and
 * `resources/read` path a plugin skill uses.
 *
 * Four constraints shape the text, and a change here must keep all four:
 *
 *   1. It names no entity, operation, tool, provider, plugin or host. A
 *      deployment composes its own catalog, so anything named here could be
 *      absent — and naming a record type would describe the product to a
 *      session that cannot reach it. The two resource URIs it does name are
 *      core and listed for every session (`session-surface.ts`), and they are
 *      imported from their owners rather than spelled out, so a rename cannot
 *      leave this pointing at nothing.
 *   2. It carries no `roles`, so it is public documentation: an ordinary
 *      session, a guest and a server-to-server session see the same words.
 *      That is only safe because of (1) — role-aware filtering still decides
 *      every skill with an audience (`visibleAgentSkills`).
 *   3. The entry stays short, and every pointer it carries resolves. The one
 *      part longer than a line of guidance — what to do with a write whose
 *      outcome is unknown — lives in the reference file beside it, linked as
 *      ordinary Markdown so a reader finds it without being told the manifest
 *      exists. Nothing here points at a repository path: a client reads these
 *      files over MCP and cannot fetch this tree.
 *   4. It states no capability as universal. What this transport actually
 *      guarantees is narrower than it is tempting to write: a session's
 *      surface is a projection, several authorized sources may serve one call
 *      (`modules/invocation-sources.ts` — `all-authorized` fans a read out
 *      where `default` composes one source per binding), and only an
 *      Operation that declares a retry mechanism may be retried at all
 *      (`operations/runtime.ts` — the key is an input field on some, a
 *      request header on others). Nor may the text treat a resembling record
 *      as proof of what one call did: what settles an uncertain write is the
 *      receipt recorded against that request, which this server tracks as its
 *      own third state (`operations/execution-receipts.ts` — `completed`
 *      versus `outcome_unknown`). Guidance that overstates any of those
 *      produces a confident duplicate or a false "cannot be done".
 */
import type { RuntimeModule } from "../modules/contract.js";
import { ENTITY_CATALOG_URI } from "./server-instructions.js";
import { SESSION_RESOURCE_URI } from "./session-info.js";

/** Namespace of the built-in contribution; its last segment is the skill name. */
export const BUILTIN_AGENT_SKILL_PATH = "osf/coordinating-capabilities";

const MARKDOWN_MIME_TYPE = "text/markdown";

const SKILL_MD = `---
name: coordinating-capabilities
description: How to turn a request into work on this deployment — discover what it actually offers, read the live contract before writing, and act once.
metadata:
  audience: assistant
---

# Coordinating this deployment's capabilities

You can only act through what this session lists, so start from that rather
than from what a deployment like this usually has. When a skill is listed for
the subject in front of you, read that one first; this entry is the fallback
for everything else and never overrides it.

## 1. Find what exists before planning around it

- The tools this session lists and ${ENTITY_CATALOG_URI} are the surface you
  have. A search that finds nothing is not a negative result: try different
  words, and the person's language as well as English.
- Not finding something is an observation about this session, never a fact
  about the product. Say "I do not see a way to do that here", not "this
  cannot be done" — what you cannot see may exist and be out of this person's
  reach, or be served by a capability this session was not given.
- Never invent a name. Entity names, operation ids, role keys and allowed
  values come from a listing or a read, never from another deployment.

## 2. Read the live contract, then write

- Before a write, read the input contract the call is actually validated
  against: the advertised input schema, or the describe step the shared tools
  name in their own descriptions. Required fields, enumerated values and
  formats come from there, not from memory.
- A call that takes a version or expected-version control needs the value from
  the read you just did, not a guess, and not a value from an earlier turn.
- Honour the effects a tool states. A read is safe to repeat; a write is not.

## 3. Identity is part of the call

- ${SESSION_RESOURCE_URI} says who this person is, what they may do and which
  record they act as. Read it when the answer depends on them, not as a
  warm-up.
- A call that reaches outside this deployment acts under a named source — this
  person's own authorization, or the organization's. Do not assume there is one
  of them: a call may offer a source per authorized connection, and a read may
  be meant to cover all of them. Take the sources from what the call itself
  advertises; never infer one from the subject.
- Where a write could act under either this person's authorization or the
  organization's, the server may refuse rather than choose for you. Say which
  one you mean, and afterwards say which one acted: whether something was done
  as this person or on the organization's behalf is a different fact to them,
  and to whoever sees the result at the other end.
- Never carry a source resolved for one person into work for someone else.

## 4. Scope every read

- Filter rather than page. Ask for the records the answer needs, not the table.
- A page and its cursor are one page. Never report a total, a maximum or "there
  are none" from a single page: follow the cursor, or say the answer is partial.

## 5. Do what was asked

- The request is the scope. Do not create a record to make a read succeed, do
  not widen a filter until something matches, and do not substitute a
  neighbouring operation for the one that was asked for and is unavailable.
- When part of the request cannot be done here, do the rest and name plainly
  what you left undone and why.

## 6. An unknown outcome stays unknown

When a write times out, is interrupted or answers unclearly, you do not know
whether it landed. A read rarely settles that: a record that merely looks right
is no proof your call made it, and finding nothing is no proof it failed. And
calling again is not free — only a contract that declares a retry mechanism can
be retried safely. Read
[what to do with an unknown outcome](references/retrying.md).

## 7. Now, or kept

Finish in this exchange what this exchange can finish. Record something durable
only when the person wants it to outlive the conversation or to be picked up by
someone else, and then only through an operation this deployment already offers
for it. A plan nobody asked you to keep is not a record.
`;

const RETRYING_MD = `# What to do with an unknown outcome

A transport error, a timeout or an interrupted turn tells you the answer did
not reach you. It tells you nothing about whether the write happened. Treat
that as a third state — not success, not failure — and keep it that way until
something actually settles it.

## What actually settles it

A read is worth doing, but be careful what it proves. A record that merely
matches by name, code or title is not evidence that YOUR call produced it:
someone else may have made it, an earlier attempt may have, or it may have
been there all along. Resemblance is not causation.

Settled — report it as done, and do not call again to be sure:

- The server's own answer for that request. A keyed call replayed with the same
  key answers with the outcome the first attempt recorded; a server that has
  lost track of an effect says so and refuses to start a new request, rather
  than implying either outcome.
- An effect uniquely attributable to this invocation: the identifier the call
  itself would have returned, a reference the call stamped on the record, or a
  receipt naming this request.

Still unknown — do not convert either of these into "it failed" or "it worked":

- Finding nothing. A read can miss a write that landed: the row may not match
  what you are searching by, the work may still be in flight, the effect may be
  outside this deployment where no read of yours reaches it, or your own access
  may not cover the row that now exists.
- Finding something that only looks right. Say what you found and that you
  cannot tell whether your call is what made it.

## Only retry what the contract says may be retried

A second call to the same write is a second write unless the Operation itself
declares otherwise, so look at what it declares before calling again:

- **A declared retry key.** The contract names where the key goes — an input
  field on some Operations, a request header on others — so use the mechanism
  that contract declares rather than guessing a field name, and send exactly
  the value of the first attempt. The server then answers with the result the
  first call produced instead of performing a second one. A fresh value is a
  new write, not a retry.
- **A naturally repeatable call.** A read, or a write the contract states is
  safe to repeat, may be repeated as it stands.
- **Anything else.** Do not call again. Say plainly that you do not know
  whether it went through, say what you did check, and let the person decide —
  a duplicate they did not ask for is worse than a question.

## A sequence that fails halfway

Separately executed steps do not unwind each other. Unless the Operation you
called declares that it is atomic — one call, all of it or none — a step that
succeeded before a later one failed stays done, and nothing rolls it back for
you.

So re-read what exists, continue from there, and tell the person what now
stands recorded and what is missing. Do not restart the sequence from the
beginning, and do not repeat a step whose outcome you know. A step whose
outcome you do NOT know is the case above, not a step to redo.
`;

/**
 * The built-in contribution, shaped exactly like a plugin's so it goes through
 * the same validation, manifest, digest and visibility path. Prepended to the
 * runtime modules in `server-scope.ts`, which also makes its resource URIs
 * core-owned: a plugin claiming one of them fails at boot rather than
 * shadowing it for a session that cannot see the core surface.
 */
export const BUILTIN_AGENT_SKILL_MODULE: RuntimeModule = {
  // Only `agentSkills` is read: the value never joins the runtime module list,
  // so this name reaches no registry, handler binding or seed.
  name: "core",
  agentSkills: [
    {
      path: BUILTIN_AGENT_SKILL_PATH,
      files: {
        "SKILL.md": { text: SKILL_MD, mimeType: MARKDOWN_MIME_TYPE },
        "references/retrying.md": { text: RETRYING_MD, mimeType: MARKDOWN_MIME_TYPE },
      },
    },
  ],
};
