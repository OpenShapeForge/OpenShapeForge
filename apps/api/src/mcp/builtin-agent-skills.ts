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
 * Three constraints shape the text, and a change here must keep all three:
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
 *   3. The entry stays short. The one part that is longer than a line of
 *      guidance — what to do after a call whose outcome is unknown — lives in
 *      the reference file beside it rather than in the entry.
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

What this deployment can do is what this session lists, and nothing else. When
a skill is listed for the subject in front of you, read that one first; this
entry is the fallback for everything else, and it never overrides it.

## 1. Find what exists before planning around it

- The tools this session lists and ${ENTITY_CATALOG_URI} are the whole surface.
  If a search for an operation finds nothing, try once more in the person's
  language, then say what this deployment does not offer.
- What you cannot see is what this person may not reach here, not what the
  product lacks. Never tell them a kind of record or an action does not exist.
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
  record they act as. Read it when the answer depends on them, not as a warm-up.
- A call that reaches outside this deployment runs under one named source: this
  person's own authorization, or the organization's. Where both are available
  the server refuses rather than choosing for you — ask which one they mean,
  and say afterwards which one acted. Never carry one person's source into work
  for someone else.

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

## 6. After a call whose outcome you do not know, look before calling again

A write that failed may have landed in part. Read it back before retrying, and
reuse the request reference where the contract has one — a fresh one is a
second write, not a retry. See references/retrying.md.

## 7. Now, or kept

Finish in this exchange what this exchange can finish. Record something durable
only when the person wants it to outlive the conversation or to be picked up by
someone else, and then only through an operation this deployment already offers
for it. A plan nobody asked you to keep is not a record.
`;

const RETRYING_MD = `# Retrying a call whose outcome you do not know

A transport error, a timeout or an interrupted turn tells you the answer did
not arrive. It does not tell you the write did not happen.

Before calling again:

1. Read the record back by its id, or list by whatever identifies it — a code,
   a reference, a name together with its owner. One read costs less than a
   duplicate record.
2. If the write landed, report it as done. Do not call again to be sure.
3. If it did not land, repeat the same call with the same input.

Where the input contract declares a request reference — an idempotency key, by
whatever name that schema gives it — reuse exactly the value of the first
attempt. The server then answers with the result the first call produced
instead of performing a second one. A fresh value is a second write.

Where the contract declares no such field, a second call is a second write.
Read first.

A sequence of calls is not rolled back for you when it fails halfway. Re-read
what already exists, continue from there, and tell the person what now stands
recorded and what is still missing — do not start the sequence again from the
beginning, and do not repeat the steps that already succeeded.
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
