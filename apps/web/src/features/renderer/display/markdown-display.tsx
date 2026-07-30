// SPDX-License-Identifier: BUSL-1.1
"use client";

import Markdown from "react-markdown";

/**
 * MarkdownDisplay — read-only renderer that turns a markdown string into
 * styled prose. Used by detail surfaces (e.g. knowledge content blocks whose
 * body lives in `currentVersion.markdown`). Styling mirrors the help-article
 * content in `components/field/label.tsx` so markdown reads consistently
 * across the app.
 *
 * Renders nothing for null/empty/whitespace-only values.
 */
export function MarkdownDisplay({ value }: { value?: string | null }) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return (
    <Markdown
      components={{
        h1: ({ children }) => (
          <h2 className="mt-0 mb-2 text-base font-semibold tracking-normal text-foreground">
            {children}
          </h2>
        ),
        h2: ({ children }) => (
          <h3 className="mt-4 mb-1.5 text-sm font-semibold tracking-normal text-foreground">
            {children}
          </h3>
        ),
        h3: ({ children }) => (
          <h4 className="mt-3 mb-1.5 text-sm font-semibold tracking-normal text-foreground">
            {children}
          </h4>
        ),
        p: ({ children }) => (
          <p className="my-2 text-sm leading-6 text-muted-foreground">
            {children}
          </p>
        ),
        ul: ({ children }) => (
          <ul className="my-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
            {children}
          </ol>
        ),
        li: ({ children }) => <li className="pl-1">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-semibold text-foreground">{children}</strong>
        ),
        code: ({ children }) => (
          <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-medium text-foreground">
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md border bg-muted/60 p-3 text-xs leading-5 text-foreground">
            {children}
          </pre>
        ),
        a: ({ children, href }) => (
          <a
            className="font-medium text-action-primary underline underline-offset-2"
            href={href}
            rel="noreferrer"
            target="_blank"
          >
            {children}
          </a>
        ),
        img: ({ alt, src }) => (
          <img
            alt={alt ?? ""}
            className="my-3 max-h-80 w-full rounded-md border object-contain"
            src={src ?? ""}
          />
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-4 border-action-primary/30 pl-4 text-sm leading-6 text-muted-foreground">
            {children}
          </blockquote>
        ),
        hr: () => <hr className="my-4 border-border" />,
      }}
    >
      {value}
    </Markdown>
  );
}
