// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the declarative response transform pipeline: each
 * primitive on its own (edge cases included), the scope rules (`$parent`,
 * `shape` replacing the scope), misconfiguration failures, and one
 * end-to-end run of a Gmail-shaped `threads.get?format=full` response
 * through `mapOperationResponse` with the authored Gmail pipeline.
 */
import { describe, expect, it } from "bun:test";
import { mapOperationResponse } from "../declarative-execution.js";
import {
  applyResponseTransforms,
  decodeBase64Url,
  flattenMimeParts,
  headersByName,
  htmlToText,
  splitAddressList,
} from "../response-transforms.js";
import { HttpError } from "../../rest/http-error.js";

const b64url = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64url");

function misconfigured(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(502);
    expect(http.code).toBe("SERVICE_MISCONFIGURED");
    return http.message;
  }
  throw new Error("expected a SERVICE_MISCONFIGURED failure");
}

describe("headersByName", () => {
  it("indexes by lowercased trimmed name and joins repeats", () => {
    expect(
      headersByName([
        { name: " Subject ", value: "Hi" },
        { name: "Received", value: "a" },
        { name: "received", value: "b" },
      ]),
    ).toEqual({ subject: "Hi", received: "a, b" });
  });
  it("yields {} for non-array input", () => {
    expect(headersByName("nope")).toEqual({});
    expect(headersByName(undefined)).toEqual({});
  });
});

describe("flattenMimeParts", () => {
  it("emits leaves and attachment nodes depth-first, without parts", () => {
    const tree = {
      mimeType: "multipart/mixed",
      headers: [{ name: "X", value: "1" }],
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/alternative",
          body: { size: 0 },
          parts: [
            { mimeType: "text/plain", body: { size: 2, data: "aGk" } },
            { mimeType: "text/html", body: { size: 3, data: "PGI+" } },
          ],
        },
        {
          mimeType: "message/rfc822",
          body: { size: 9, attachmentId: "att-1" },
          parts: [{ mimeType: "text/plain", body: { size: 1, data: "eA" } }],
        },
      ],
    };
    const flat = flattenMimeParts(tree);
    expect(flat.map((part) => part.mimeType)).toEqual([
      "text/plain",
      "text/html",
      "message/rfc822",
      "text/plain",
    ]);
    expect(flat.every((part) => !("parts" in part))).toBe(true);
    expect(flat[2]).toEqual({
      mimeType: "message/rfc822",
      body: { size: 9, attachmentId: "att-1" },
      headers: {},
    });
  });
  it("replaces headers with the by-name object", () => {
    expect(
      flattenMimeParts({
        mimeType: "image/png",
        headers: [{ name: "Content-ID", value: "<img1>" }],
        body: { size: 1 },
      })[0]!.headers,
    ).toEqual({ "content-id": "<img1>" });
  });
  it("yields [] for non-object input and survives cycles", () => {
    expect(flattenMimeParts(null)).toEqual([]);
    const cyclic: Record<string, unknown> = { mimeType: "x", body: {} };
    cyclic.parts = [cyclic];
    expect(flattenMimeParts(cyclic)).toEqual([]);
  });
});

describe("decodeBase64Url", () => {
  it("decodes both alphabets with or without padding", () => {
    const text = "héllo?>~ world";
    expect(decodeBase64Url(Buffer.from(text).toString("base64"))).toBe(text);
    expect(decodeBase64Url(b64url(text))).toBe(text);
    expect(decodeBase64Url("aGk")).toBe("hi");
  });
  it("yields undefined for non-strings", () => {
    expect(decodeBase64Url(42)).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("drops script/style/head/comments, keeps block structure", () => {
    const html =
      "<html><head><title>t</title></head><body><style>p{}</style>" +
      "<!-- c --><script>x()</script><h1>Title</h1>" +
      "<p>One &amp; two &lt;3&gt; &quot;q&quot; &#39;a&#39; &#x41;&#66;&nbsp;!</p>" +
      "<ul><li>first</li><li>second</li></ul>" +
      "<table><tr><td>a</td><td>b</td></tr></table>" +
      "line<br>break\n\n\n<div>   spaced    out </div></body></html>";
    expect(htmlToText(html)).toBe(
      "Title\n\nOne & two <3> \"q\" 'a' AB !\n\n- first\n- second\n\na b\n\nline\nbreak\nspaced out",
    );
  });
  it("yields undefined for non-strings", () => {
    expect(htmlToText(null)).toBeUndefined();
  });
});

describe("splitAddressList", () => {
  it("does not split inside quotes or angle brackets", () => {
    expect(
      splitAddressList(
        '"Doe, John" <j@x.test>, a@y.test, "<b,c>" <b@z.test>,, ',
      ),
    ).toEqual(['"Doe, John" <j@x.test>', "a@y.test", '"<b,c>" <b@z.test>']);
  });
  it("yields [] for non-strings", () => {
    expect(splitAddressList(undefined)).toEqual([]);
  });
});

describe("applyResponseTransforms", () => {
  it("first returns the match or null; filter returns matches", () => {
    const outputs = {
      items: [
        { kind: "A", data: "" },
        { kind: "a", data: "x" },
        { kind: "b", data: "y" },
      ],
    };
    const result = applyResponseTransforms(outputs, [
      {
        op: "first",
        from: "items",
        to: "hit",
        where: [
          { path: "kind", equals: "A" },
          { path: "data", exists: true },
        ],
      },
      {
        op: "first",
        from: "items",
        to: "miss",
        where: { path: "kind", equals: "z" },
      },
      {
        op: "filter",
        from: "items",
        to: "some",
        where: { path: "data", exists: true },
      },
      {
        op: "filter",
        from: "nope",
        to: "none",
        where: { path: "data", exists: true },
      },
    ]);
    expect(result.hit).toEqual({ kind: "a", data: "x" });
    expect(result.miss).toBeNull();
    expect(result.some).toEqual([
      { kind: "a", data: "x" },
      { kind: "b", data: "y" },
    ]);
    expect(result.none).toEqual([]);
    expect(outputs.items[0]).toEqual({ kind: "A", data: "" });
  });

  it("replaces the value at from when to is omitted", () => {
    const result = applyResponseTransforms(
      { body: { data: b64url("plain") } },
      [{ op: "base64url", from: "body.data" }],
    );
    expect(result.body).toEqual({ data: "plain" });
  });

  it("map exposes $parent (repeatably) and passes non-objects through", () => {
    const result = applyResponseTransforms(
      {
        id: "root",
        rows: [{ id: "r1", cells: [{ v: 1 }, 7] }, "skip"],
      },
      [
        {
          op: "map",
          from: "rows",
          steps: [
            {
              op: "map",
              from: "cells",
              steps: [
                {
                  op: "shape",
                  fields: {
                    v: "v",
                    row: "$parent.id",
                    root: "$parent.$parent.id",
                    beyond: "$parent.$parent.$parent.id",
                  },
                },
              ],
            },
          ],
        },
      ],
    );
    expect(result.rows).toEqual([
      {
        id: "r1",
        cells: [{ v: 1, row: "r1", root: "root", beyond: undefined }, 7],
      },
      "skip",
    ]);
  });

  it("shape without from/to replaces the whole scope", () => {
    const result = applyResponseTransforms({ a: 1, b: { c: "x" } }, [
      {
        op: "shape",
        fields: {
          c: "b.c",
          hasA: { exists: "a" },
          hasZ: { exists: "z" },
          fixed: { literal: [1, 2] },
        },
      },
    ]);
    expect(result).toEqual({ c: "x", hasA: true, hasZ: false, fixed: [1, 2] });
  });

  it("shape with from shapes an object or each item of a list", () => {
    const result = applyResponseTransforms(
      { one: { n: 1 }, many: [{ n: 2 }, { n: 3 }] },
      [
        { op: "shape", from: "one", to: "o", fields: { m: "n" } },
        { op: "shape", from: "many", fields: { m: "n" } },
      ],
    );
    expect(result.o).toEqual({ m: 1 });
    expect(result.many).toEqual([{ m: 2 }, { m: 3 }]);
  });

  it("coalesce picks the first present value, else null", () => {
    const result = applyResponseTransforms({ a: "", b: null, c: 0, d: "x" }, [
      { op: "coalesce", from: ["a", "b", "c", "d"], to: "first" },
      { op: "coalesce", from: ["a", "b"], to: "none" },
    ]);
    expect(result.first).toBe(0);
    expect(result.none).toBeNull();
  });

  it("does not mutate its input", () => {
    const outputs = { h: [{ name: "A", value: "1" }], nested: { x: "y" } };
    const snapshot = JSON.stringify(outputs);
    applyResponseTransforms(outputs, [
      { op: "headers-by-name", from: "h" },
      { op: "coalesce", from: ["nested.x"], to: "nested.z" },
    ]);
    expect(JSON.stringify(outputs)).toBe(snapshot);
  });

  it("fails as SERVICE_MISCONFIGURED on unknown or malformed steps", () => {
    expect(
      misconfigured(() =>
        applyResponseTransforms({}, [{ op: "explode", from: "x" }]),
      ),
    ).toContain('step 0 (op "explode")');
    expect(
      misconfigured(() =>
        applyResponseTransforms({}, [
          { op: "base64url", from: "x" },
          { op: "first", from: "x", to: "y", where: "bad" },
        ]),
      ),
    ).toContain('step 1 (op "first")');
    expect(
      misconfigured(() =>
        applyResponseTransforms({}, [{ op: "map", from: "x", steps: {} }]),
      ),
    ).toContain("steps");
    expect(
      misconfigured(() =>
        applyResponseTransforms({}, [{ op: "shape", fields: [] }]),
      ),
    ).toContain("fields");
    expect(
      misconfigured(() =>
        applyResponseTransforms({}, [{ op: "coalesce", from: "a", to: "b" }]),
      ),
    ).toContain("from");
    expect(
      misconfigured(() => applyResponseTransforms({}, [{ from: "x" }])),
    ).toContain("op");
  });
});

/* ------------------------------------------------------------------------ */
/* End-to-end: Gmail threads.get?format=full through mapOperationResponse.  */
/* ------------------------------------------------------------------------ */

const GMAIL_THREAD_TRANSFORMS = [
  {
    op: "map",
    from: "messages",
    steps: [
      { op: "headers-by-name", from: "payload.headers", to: "headers" },
      { op: "mime-parts", from: "payload", to: "parts" },
      {
        op: "first",
        from: "parts",
        to: "plainPart",
        where: [
          { path: "mimeType", equals: "text/plain" },
          { path: "body.data", exists: true },
        ],
      },
      {
        op: "first",
        from: "parts",
        to: "htmlPart",
        where: [
          { path: "mimeType", equals: "text/html" },
          { path: "body.data", exists: true },
        ],
      },
      { op: "base64url", from: "plainPart.body.data", to: "plainText" },
      { op: "base64url", from: "htmlPart.body.data", to: "html" },
      { op: "html-to-text", from: "html", to: "htmlText" },
      {
        op: "coalesce",
        from: ["plainText", "htmlText", "snippet"],
        to: "text",
      },
      { op: "address-list", from: "headers.to", to: "to" },
      { op: "address-list", from: "headers.cc", to: "cc" },
      {
        op: "filter",
        from: "parts",
        to: "attachmentParts",
        where: [{ path: "body.attachmentId", exists: true }],
      },
      {
        op: "map",
        from: "attachmentParts",
        to: "attachments",
        steps: [
          {
            op: "shape",
            fields: {
              attachmentId: "body.attachmentId",
              messageId: "$parent.id",
              filename: "filename",
              mimeType: "mimeType",
              size: "body.size",
              inline: { exists: "headers.content-id" },
            },
          },
        ],
      },
      {
        op: "shape",
        fields: {
          id: "id",
          from: "headers.from",
          to: "to",
          cc: "cc",
          date: "headers.date",
          subject: "headers.subject",
          text: "text",
          attachments: "attachments",
        },
      },
    ],
  },
];

const PLAIN_TEXT = "Hi Ana,\n\nPlease find the offer attached.\n\n— Bram";
const HTML_BODY =
  "<html><body><p>Hi Ana,</p><p>Thanks &amp; see you <b>Monday</b>.</p>" +
  '<img src="cid:image001.png@01DA"><ul><li>Room 4</li></ul></body></html>';

const GMAIL_THREAD = {
  id: "18f2a7c9e1b3d4f5",
  historyId: "1234567",
  messages: [
    {
      id: "18f2a7c9e1b3d4f5",
      threadId: "18f2a7c9e1b3d4f5",
      labelIds: ["INBOX"],
      snippet: "Hi Ana, please find the offer attached.",
      payload: {
        mimeType: "multipart/mixed",
        filename: "",
        headers: [
          { name: "From", value: "Bram de Vries <bram@example.test>" },
          {
            name: "To",
            value:
              '"Jansen, Ana" <ana.jansen@example.test>, Team Ops <ops@example.test>',
          },
          { name: "Cc", value: "cc-one@example.test" },
          { name: "Date", value: "Tue, 3 Sep 2026 09:14:22 +0200" },
          { name: "Subject", value: "Offer for the Q4 assessment" },
          { name: "Received", value: "from a" },
          { name: "Received", value: "from b" },
        ],
        body: { size: 0 },
        parts: [
          {
            mimeType: "multipart/alternative",
            filename: "",
            headers: [
              {
                name: "Content-Type",
                value: 'multipart/alternative; boundary="alt"',
              },
            ],
            body: { size: 0 },
            parts: [
              {
                partId: "0.0",
                mimeType: "text/plain",
                filename: "",
                headers: [
                  {
                    name: "Content-Type",
                    value: 'text/plain; charset="UTF-8"',
                  },
                ],
                body: { size: PLAIN_TEXT.length, data: b64url(PLAIN_TEXT) },
              },
              {
                partId: "0.1",
                mimeType: "text/html",
                filename: "",
                headers: [
                  { name: "Content-Type", value: 'text/html; charset="UTF-8"' },
                ],
                body: { size: HTML_BODY.length, data: b64url(HTML_BODY) },
              },
            ],
          },
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: "offer.pdf",
            headers: [
              {
                name: "Content-Type",
                value: 'application/pdf; name="offer.pdf"',
              },
              {
                name: "Content-Disposition",
                value: 'attachment; filename="offer.pdf"',
              },
              { name: "Content-Transfer-Encoding", value: "base64" },
            ],
            body: { attachmentId: "ANGjdJ8-offer-pdf", size: 48211 },
          },
          {
            partId: "2",
            mimeType: "image/png",
            filename: "image001.png",
            headers: [
              { name: "Content-Type", value: 'image/png; name="image001.png"' },
              { name: "Content-ID", value: "<image001.png@01DA>" },
              {
                name: "Content-Disposition",
                value: 'inline; filename="image001.png"',
              },
            ],
            body: { attachmentId: "ANGjdJ8-image001-png", size: 2048 },
          },
        ],
      },
      sizeEstimate: 60000,
    },
    {
      id: "18f2a8d0f2c4e5a6",
      threadId: "18f2a7c9e1b3d4f5",
      labelIds: ["SENT"],
      snippet: "Thanks, looks good.",
      payload: {
        mimeType: "text/html",
        filename: "",
        headers: [
          { name: "From", value: '"Jansen, Ana" <ana.jansen@example.test>' },
          { name: "To", value: "Bram de Vries <bram@example.test>" },
          { name: "Date", value: "Tue, 3 Sep 2026 10:02:05 +0200" },
          { name: "Subject", value: "Re: Offer for the Q4 assessment" },
        ],
        body: {
          size: 60,
          data: b64url(
            '<div dir="ltr">Thanks, looks good.<br>We&#39;ll sign on <i>Friday</i>.</div>',
          ),
        },
      },
      sizeEstimate: 900,
    },
  ],
};

describe("Gmail threads.get end to end", () => {
  const mapped = mapOperationResponse(
    {
      outputMapping: [
        { from: "conversationId", to: "conversationId" },
        { from: "messages", to: "messages" },
      ],
    },
    {
      responseMapping: {
        fieldPaths: [
          { path: "id", field: "conversationId" },
          { path: "messages", field: "messages" },
        ],
        transforms: GMAIL_THREAD_TRANSFORMS,
      },
    },
    GMAIL_THREAD,
  );
  const messages = mapped.messages as Record<string, unknown>[];

  it("maps the conversation id and both messages", () => {
    expect(mapped.conversationId).toBe("18f2a7c9e1b3d4f5");
    expect(messages).toHaveLength(2);
  });

  it("shapes a multipart message with decoded text and attachments", () => {
    expect(messages[0]).toEqual({
      id: "18f2a7c9e1b3d4f5",
      from: "Bram de Vries <bram@example.test>",
      to: [
        '"Jansen, Ana" <ana.jansen@example.test>',
        "Team Ops <ops@example.test>",
      ],
      cc: ["cc-one@example.test"],
      date: "Tue, 3 Sep 2026 09:14:22 +0200",
      subject: "Offer for the Q4 assessment",
      text: PLAIN_TEXT,
      attachments: [
        {
          attachmentId: "ANGjdJ8-offer-pdf",
          messageId: "18f2a7c9e1b3d4f5",
          filename: "offer.pdf",
          mimeType: "application/pdf",
          size: 48211,
          inline: false,
        },
        {
          attachmentId: "ANGjdJ8-image001-png",
          messageId: "18f2a7c9e1b3d4f5",
          filename: "image001.png",
          mimeType: "image/png",
          size: 2048,
          inline: true,
        },
      ],
    });
  });

  it("falls back to html-derived text for a single-part html message", () => {
    expect(messages[1]!.text).toBe(
      "Thanks, looks good.\nWe'll sign on Friday.",
    );
    expect(messages[1]!.cc).toEqual([]);
    expect(messages[1]!.attachments).toEqual([]);
  });

  it("leaves the raw provider response untouched", () => {
    expect(GMAIL_THREAD.messages[0]!.payload.parts).toHaveLength(3);
    expect(typeof GMAIL_THREAD.messages[1]!.payload.body.data).toBe("string");
  });
});
