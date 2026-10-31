// SPDX-License-Identifier: BUSL-1.1
/**
 * The signed-identity profile and what it reads out of a verified body.
 *
 * The one property every test here serves: nothing in this module can be
 * reached with a header value, and nothing it returns depends on one. The
 * admission-level consequences — a replayed body with a fresh id, a burned id
 * against a new body — are proved in inbound-admission.test.ts, which is where
 * the delivery key is actually built.
 */
import { expect, test } from "bun:test";
import {
  DEFAULT_INBOUND_IDENTITY, normalizeInboundIdentity, parseInboundIdentityFields,
  readSignedDeliveryIdentity, serializeInboundIdentityFields, storedInboundIdentity,
} from "./inbound-identity.js";

const DIGEST = "a".repeat(64);
const jira = Buffer.from(JSON.stringify({
  timestamp: 1_762_000_000_000,
  webhookEvent: "jira:issue_updated",
  issue: { id: "10021", key: "ENG-7" },
}));

test("an absent profile is the universal body-digest default", () => {
  expect(normalizeInboundIdentity(undefined)).toEqual(DEFAULT_INBOUND_IDENTITY);
  expect(normalizeInboundIdentity(null)).toEqual(DEFAULT_INBOUND_IDENTITY);
  expect(normalizeInboundIdentity({ source: "body-digest" }))
    .toEqual({ source: "body-digest", fields: [], eventTypePath: null });
});

test("a profile is refused unless its source and its fields agree", () => {
  // A source this host does not implement, including the one a reviewer would
  // reach for first.
  for (const source of ["header", "delivery-id-header", "", "BODY-DIGEST"]) {
    expect(normalizeInboundIdentity({ source })).toBeUndefined();
  }
  // `fields` beside a digest source would read as if it were in force.
  expect(normalizeInboundIdentity({ source: "body-digest", fields: ["issue.id"] })).toBeUndefined();
  // And body-field without any is a profile that identifies nothing.
  expect(normalizeInboundIdentity({ source: "body-field" })).toBeUndefined();
  expect(normalizeInboundIdentity({ source: "body-field", fields: [] })).toBeUndefined();
  // A repeated path weights one value twice and identifies nothing more.
  expect(normalizeInboundIdentity({ source: "body-field", fields: ["issue.id", "issue.id"] }))
    .toBeUndefined();
  expect(normalizeInboundIdentity({
    source: "body-field", fields: ["a", "b", "c", "d", "e"],
  })).toBeUndefined();
});

test("a path may not walk the prototype chain, an array, or arbitrary text", () => {
  for (const field of [
    "__proto__", "issue.__proto__.id", "constructor", "a.prototype.b",
    "issue.0.id", "issue[0]", "issue id", "a,b", "", ".a", "a.", "a.b.c.d.e.f.g",
  ]) {
    expect(normalizeInboundIdentity({ source: "body-field", fields: [field] })).toBeUndefined();
    expect(normalizeInboundIdentity({ source: "body-digest", eventTypePath: field })).toBeUndefined();
  }
});

test("the column form round-trips, and a corrupted one yields no usable profile", () => {
  expect(serializeInboundIdentityFields([])).toBeNull();
  expect(serializeInboundIdentityFields(["webhookEvent", "issue.id"])).toBe("webhookEvent,issue.id");
  expect(parseInboundIdentityFields("webhookEvent,issue.id")).toEqual(["webhookEvent", "issue.id"]);
  expect(parseInboundIdentityFields(null)).toEqual([]);
  // All or nothing: dropping one unusable entry would silently change which
  // values identify a delivery under the same registration. The database's own
  // check is shape only, so `__proto__` does reach here.
  expect(parseInboundIdentityFields("__proto__,issue.id")).toBeUndefined();
  expect(parseInboundIdentityFields("issue.id,not a path")).toBeUndefined();
  // A row whose stored profile no longer normalises answers undefined rather
  // than a weaker profile: admission refuses it instead of guessing.
  for (const row of [
    { identity_source: "body-field", identity_fields: null, identity_event_type_path: null },
    { identity_source: "body-field", identity_fields: "__proto__,a", identity_event_type_path: null },
    { identity_source: "header", identity_fields: null, identity_event_type_path: null },
    { identity_source: "body-digest", identity_fields: null, identity_event_type_path: "a b" },
  ]) {
    expect(storedInboundIdentity(row)).toBeUndefined();
  }
  expect(storedInboundIdentity({
    identity_source: "body-digest", identity_fields: null,
    identity_event_type_path: "webhookEvent",
  })).toEqual({ source: "body-digest", fields: [], eventTypePath: "webhookEvent" });
});

test("body-digest keys on the verified bytes and reads the event name from inside them", () => {
  const profile = normalizeInboundIdentity({
    source: "body-digest", eventTypePath: "webhookEvent",
  })!;
  const read = readSignedDeliveryIdentity(profile, jira, DIGEST);
  expect(read).toEqual({ keySource: `b:${DIGEST}`, eventType: "jira:issue_updated" });

  // An unreadable event path is NOT a refusal here: the bytes are authentic and
  // the key does not depend on it, so the plugin simply gets null and fails
  // closed on its own routing.
  const missing = normalizeInboundIdentity({ source: "body-digest", eventTypePath: "absent" })!;
  expect(readSignedDeliveryIdentity(missing, jira, DIGEST)).toEqual({
    keySource: `b:${DIGEST}`, eventType: null,
  });
  // Including when the body is not JSON at all.
  expect(readSignedDeliveryIdentity(missing, Buffer.from("not json"), DIGEST)).toEqual({
    keySource: `b:${DIGEST}`, eventType: null,
  });
});

test("body-field keys on declared signed values, in declared order", () => {
  const profile = normalizeInboundIdentity({
    source: "body-field", fields: ["webhookEvent", "timestamp", "issue.id"],
    eventTypePath: "webhookEvent",
  })!;
  const read = readSignedDeliveryIdentity(profile, jira, DIGEST)!;
  expect(read.eventType).toBe("jira:issue_updated");
  // The digest is NOT part of a field identity: a retry whose bytes differ only
  // in field order is the same event, which is the whole reason to declare one.
  expect(read.keySource).not.toContain(DIGEST);
  expect(read.keySource.startsWith("f:")).toBe(true);
  const reordered = Buffer.from(JSON.stringify({
    issue: { key: "ENG-7", id: "10021" }, webhookEvent: "jira:issue_updated",
    timestamp: 1_762_000_000_000, extra: "added by the provider",
  }));
  expect(readSignedDeliveryIdentity(profile, reordered, "b".repeat(64))?.keySource)
    .toBe(read.keySource);

  // A genuinely different event differs, even by one identity value.
  const later = Buffer.from(JSON.stringify({
    timestamp: 1_762_000_000_001, webhookEvent: "jira:issue_updated", issue: { id: "10021" },
  }));
  expect(readSignedDeliveryIdentity(profile, later, DIGEST)?.keySource).not.toBe(read.keySource);
  const otherIssue = Buffer.from(JSON.stringify({
    timestamp: 1_762_000_000_000, webhookEvent: "jira:issue_updated", issue: { id: "10022" },
  }));
  expect(readSignedDeliveryIdentity(profile, otherIssue, DIGEST)?.keySource).not.toBe(read.keySource);
});

test("a digest identity and a field identity can never collide", () => {
  const digest = normalizeInboundIdentity({ source: "body-digest" })!;
  // The adversarial case: a body whose declared field IS the digest string.
  const crafted = Buffer.from(JSON.stringify({ id: DIGEST }));
  const field = normalizeInboundIdentity({ source: "body-field", fields: ["id"] })!;
  expect(readSignedDeliveryIdentity(field, crafted, DIGEST)?.keySource)
    .not.toBe(readSignedDeliveryIdentity(digest, crafted, DIGEST)?.keySource);
});

test("a field identity the authentic body does not carry is refused, never stood in for", () => {
  const profile = normalizeInboundIdentity({ source: "body-field", fields: ["issue.id"] })!;
  for (const body of [
    "{}", '{ "issue": {} }', '{ "issue": null }', '{ "issue": { "id": {} } }',
    '{ "issue": { "id": [1] } }', '{ "issue": { "id": null } }', "[]", "not json", "",
  ]) {
    expect(readSignedDeliveryIdentity(profile, Buffer.from(body), DIGEST)).toBeUndefined();
  }
  // A value too long to be an identifier is refused rather than truncated: two
  // long values sharing a prefix must not become one event.
  const long = Buffer.from(JSON.stringify({ issue: { id: "x".repeat(201) } }));
  expect(readSignedDeliveryIdentity(profile, long, DIGEST)).toBeUndefined();
  // Numbers are identifiers a provider legitimately sends. The canonical form
  // is the value, so a provider that switches an id between 10021 and "10021"
  // across retries of one event still keys to one receipt — which is the
  // conservative direction: it suppresses a repeat rather than inventing one.
  const numeric = readSignedDeliveryIdentity(
    profile, Buffer.from('{ "issue": { "id": 10021 } }'), DIGEST,
  );
  expect(numeric?.keySource).toContain("10021");
  expect(readSignedDeliveryIdentity(
    profile, Buffer.from('{ "issue": { "id": "10021" } }'), DIGEST,
  )?.keySource).toBe(numeric!.keySource);
  // NaN/Infinity cannot appear in JSON, so an unusable number is only reachable
  // as a non-finite literal, which JSON.parse itself refuses.
  expect(readSignedDeliveryIdentity(
    profile, Buffer.from('{ "issue": { "id": NaN } }'), DIGEST,
  )).toBeUndefined();
});

test("a signed event name carrying control characters is dropped, not forwarded", () => {
  const profile = normalizeInboundIdentity({
    source: "body-digest", eventTypePath: "webhookEvent",
  })!;
  const injected = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated\nx-injected: 1" }));
  expect(readSignedDeliveryIdentity(profile, injected, DIGEST)?.eventType).toBeNull();
  const huge = Buffer.from(JSON.stringify({ webhookEvent: "e".repeat(201) }));
  expect(readSignedDeliveryIdentity(profile, huge, DIGEST)?.eventType).toBeNull();
});
