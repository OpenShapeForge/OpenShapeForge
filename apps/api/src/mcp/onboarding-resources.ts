// SPDX-License-Identifier: BUSL-1.1
/**
 * The detail behind `whoami`'s onboarding index: one MCP resource per step.
 *
 *   osf://onboarding/step/identity
 *   osf://onboarding/step/organization_connections
 *   osf://onboarding/step/connections
 *   osf://onboarding/step/preferences
 *   osf://onboarding/step/guide
 *
 * `whoami` answers WHAT is open (key, title, status); these answer HOW, one
 * step at a time. The split exists because two of the five how-to texts grow
 * with the deployment — the administrator step names every Adapter still to be
 * configured, the connections step writes a sentence per provider the person
 * has not signed in at — and `whoami` is the first thing every session reads.
 * Index-and-detail is exactly what `resources/list` + `resources/read` are for,
 * so no new vocabulary had to be invented: a client that already knows how to
 * follow a resource link follows these.
 *
 * The LIST is static. The five keys are a fixed union (mcp/onboarding.ts), so
 * `resources/list` names them without gathering a single fact — which matters
 * because `whoami` counts the resources this session sees, and computing the
 * checklist to answer that count would run the whole fact gather twice per
 * call. Only a `resources/read` computes anything, and it computes exactly the
 * one step it was asked for.
 *
 * Authorization is the onboarding module's, not a second one: the read is
 * handed the same per-session `OnboardingEnvironment` the tools use, built by
 * the server from the same session, so a resource read sees precisely what
 * `onboarding_status` would have shown this caller. The visibility rule is the
 * tools' as well — `onboardingToolsForSession` — so the resources appear for a
 * session that has a person to onboard and for no other.
 */
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  describeOnboarding,
  onboardingStepKeyFromUri,
  onboardingStepUri,
  onboardingToolsForSession,
  ONBOARDING_STATUS_TOOL,
  ONBOARDING_STEP_KEYS,
  ONBOARDING_STEP_TITLES,
  ONBOARDING_STEP_URI_TEMPLATE,
  type OnboardingEnvironment,
  type OnboardingStepKey,
} from "./onboarding.js";
import { JSON_MIME_TYPE } from "./session-info.js";

/**
 * What each resource says about itself in `resources/list`, before anything is
 * computed. Deliberately says what the step IS rather than what its state is:
 * the state is in the index, and a listing that changed per session would make
 * the list itself something a client has to re-read.
 */
const STEP_DESCRIPTIONS: Record<OnboardingStepKey, string> = {
  identity:
    "How to link the signed-in person's login to their Relation, for this session: whether " +
    "a candidate exists to confirm, or an administrator has to link it.",
  organization_connections:
    "How to set up the organization's provider connections, for this session: every Adapter " +
    "still missing an organization-level Connection, the tool and arguments that create it, " +
    "what its secure form asks for, and the OAuth redirect URL to register first.",
  connections:
    "How this person signs in at the providers behind the Services published to them: the " +
    "connect_service call per provider they are not yet signed in at.",
  preferences:
    "How to ask for and store this person's working preferences, and how they may skip it.",
  guide: "Which role guides this person's roles call for, and which are still unread.",
};

/** The `resources/list` entries, one per step. Static: no session, no database. */
export const ONBOARDING_STEP_RESOURCES = ONBOARDING_STEP_KEYS.map((key) => ({
  uri: onboardingStepUri(key),
  name: `onboarding-step-${key.replace(/_/g, "-")}`,
  title: `Onboarding: ${ONBOARDING_STEP_TITLES[key]}`,
  description: `${STEP_DESCRIPTIONS[key]} The step's status is in whoami's \`onboarding\` index.`,
  mimeType: JSON_MIME_TYPE,
}));

/** The `resources/templates/list` entry the five are instances of. */
export const ONBOARDING_STEP_RESOURCE_TEMPLATE = {
  uriTemplate: ONBOARDING_STEP_URI_TEMPLATE,
  name: "onboarding-step",
  title: "Onboarding step",
  description:
    "One step of the signed-in person's first-use checklist, with its howTo: `step` is the " +
    `key from whoami's \`onboarding.steps\` (${ONBOARDING_STEP_KEYS.join(", ")}). ` +
    `${ONBOARDING_STATUS_TOOL} returns all of them at once.`,
  mimeType: JSON_MIME_TYPE,
} as const;

/** Every URI this module owns, so a runtime module cannot shadow one. */
export const ONBOARDING_RESOURCE_URIS: readonly string[] = ONBOARDING_STEP_RESOURCES.map(
  (resource) => resource.uri,
);

/**
 * The resources this session is shown: the same rule the onboarding tools
 * follow, so a session that cannot call `onboarding_status` is not offered the
 * detail behind an index it does not have either.
 */
export function onboardingResourcesForSession(
  session: Pick<TrustedSessionContext, "tenantId" | "userId">,
): typeof ONBOARDING_STEP_RESOURCES {
  return onboardingToolsForSession(session).length > 0 ? ONBOARDING_STEP_RESOURCES : [];
}

export type OnboardingStepResourcePayload = {
  key: OnboardingStepKey;
  title: string;
  status: string;
  /** What to do when the step is `todo`; a short note otherwise. */
  howTo: string;
  /** The checklist's own one-line state, so one read stands on its own. */
  onboardingStatus: string;
  /** Every step at once, for a caller that wants the rest. */
  allSteps: string;
};

/** The payload for a step that this person's checklist does not contain. */
function notApplicable(key: OnboardingStepKey, reason: string): OnboardingStepResourcePayload {
  return {
    key,
    title: ONBOARDING_STEP_TITLES[key],
    status: "not_applicable",
    howTo: reason,
    onboardingStatus: reason,
    allSteps: `Call ${ONBOARDING_STATUS_TOOL} for the whole checklist.`,
  };
}

/**
 * `resources/read` for one onboarding step. `undefined` when the URI is not
 * one of ours, so the server falls through to the rest of its resources.
 *
 * A step the checklist did not produce (a session with no person to onboard)
 * answers rather than 404s: the URI is a real resource of this server, and a
 * model that followed it deserves the reason in words rather than an error it
 * has to guess at.
 */
export async function readOnboardingStepResource(
  uri: string,
  env: OnboardingEnvironment,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> } | undefined> {
  const key = onboardingStepKeyFromUri(uri);
  if (key === null) return undefined;

  let payload: OnboardingStepResourcePayload;
  if (onboardingToolsForSession(env.session).length === 0) {
    payload = notApplicable(
      key,
      "Onboarding does not apply: this session carries no person (development identity or API key).",
    );
  } else {
    const summary = await describeOnboarding(env);
    const step = summary.steps.find((entry) => entry.key === key);
    payload = step
      ? {
          key,
          title: step.title,
          status: step.status,
          howTo: step.howTo,
          onboardingStatus: summary.summary,
          allSteps: `${ONBOARDING_STATUS_TOOL} returns every step with its howTo in one answer.`,
        }
      : notApplicable(key, summary.summary);
  }

  return {
    contents: [
      { uri, mimeType: JSON_MIME_TYPE, text: JSON.stringify(payload, null, 2) },
    ],
  };
}
