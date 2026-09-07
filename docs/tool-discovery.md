# Pinned tools and on-demand discovery

Set `OPENSHAPEFORGE_MCP_PINNED_TOOLS` to a JSON array of exact tool names:

```sh
OPENSHAPEFORGE_MCP_PINNED_TOOLS='["whoami"]'
```

When configured, `tools/list` advertises only authorized pinned tools and
three generic discovery tools:

1. `osf_search_tools`: search authorized tool names, titles and descriptions;
   results contain summaries and a `nextCursor`. Pass it as `after` to continue.
2. `osf_read_tool`: read a tool's full input/output contract and annotations.
3. `osf_call_tool`: invoke it through the normal external dispatch path.

An empty array advertises only discovery. Omitting the variable preserves the
existing full catalog, so this change is opt-in for each deployment. Up to 60
names may be pinned, in addition to the three generic discovery tools. Changing
the setting requires restarting the API and reconnecting existing MCP sessions.
Pins are deployment configuration, not user permissions. They never make a
hidden, unpublished, internal-only or role-restricted tool available. A pinned
name absent from the caller's authorized catalog remains absent. Unpinned tools
remain callable and are re-authorized on every invocation; discovery is not an
access token. Wrapper invocation cannot select a privileged internal source.

The generic invocation tool has conservative mutation/destruction annotations.
Clients must inspect the target contract and obtain the user authorization
appropriate for that action. Read-only tools retain their own annotations in
search and detail results.

Definition tables are read in pages rather than truncated after 100 rows.
Discovery searches the complete session-authorized catalog; this does not
currently implement indexed database search or per-person pin preferences.
Large catalogs may therefore increase discovery and invocation latency.
