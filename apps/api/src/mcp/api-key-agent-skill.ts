// SPDX-License-Identifier: BUSL-1.1
import {
  API_KEY_MANAGE_ROLE,
  INTEGRATION_KEY_CREATE_ROLE,
  PERSONAL_KEY_CREATE_ROLE,
  PERSONAL_KEY_ROLE,
} from "../auth/api-key/ceiling.js";
import type { RuntimeModule } from "../modules/contract.js";

const skill = `---
name: implementing-api-keys
description: Implement authorized REST calls with a personal or integration API key in the caller's existing stack.
metadata:
  audience: assistant
---

# Implementing API-key access

1. Identify the deployment, organization and calls the user wants. Open Swagger at
   \`/api/rest/docs\` on that deployment. Read \`/api/rest/openapi.json\` for the
   machine-readable contract. Keep the organization path prefix when the deployment
   uses one. Use the live OpenAPI server and paths to determine the request URLs.
2. Match each requested operation to its REST method and path, parameters, body
   schema and responses. Use the canonical ID when the OpenAPI document supplies one.
   Read \`osf://session\` and the session's available operations for the signed-in
   person's access. Swagger describes the deployed contract. Confirm the credential's
   effective access separately, including allowed records and actions.
3. A personal key acts as its owner with their current organization access and any
   narrower key scope. An integration key acts as the integration, subject to its
   own grants and any further credential restrictions. Check the integration roles,
   record or workflow grants, and any network, endpoint or origin restrictions against
   the required calls. A personal session's access does not establish an integration
   key's access. Request only the scope the integration needs.
4. Use the caller's existing language, HTTP client, configuration and secret store.
   For server-side calls, read the secret at runtime and send it over HTTPS in
   \`Authorization: Bearer <key>\`. Keep the key out of source, frontend bundles,
   prompts, URLs, logs and examples. Use private credential handling when issuing
   a key. A deliberately provisioned browser key is public and can call only its
   configured endpoints from allowed origins. Keep ordinary keys on the server.
5. Verify a harmless read with the intended credential against the exact deployment
   and organization before claiming access. Treat a 401 as an authentication problem
   and a 403 as an authorization or restriction problem. Check the key, tenant,
   operation and record scope when diagnosing them. Verify write access only against
   a test fixture and with authorization. Handle errors and retries according to the
   operation's contract, especially when a write's outcome is unknown.
`;

export const API_KEY_AGENT_SKILL_MODULE: RuntimeModule = {
  name: "api-key-agent-skill",
  agentSkills: [{
    path: "osf/implementing-api-keys",
    roles: [API_KEY_MANAGE_ROLE, INTEGRATION_KEY_CREATE_ROLE, PERSONAL_KEY_ROLE, PERSONAL_KEY_CREATE_ROLE],
    files: { "SKILL.md": { text: skill, mimeType: "text/markdown" } },
  }],
};
