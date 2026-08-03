// SPDX-License-Identifier: BUSL-1.1
/**
 * The plugin's first web screen, and the worked example of the web half of the
 * plugin contract.
 *
 * A plugin now has three entry points, and this is the third:
 *
 *   `<plugin>`          the CompilerPlugin, run by `bun run generate`
 *   `<plugin>/runtime`  the RuntimeModule, loaded by the API at boot
 *   `<plugin>/web`      this — components apps/web renders behind a route the
 *                       plugin emits and a nav entry it patches in
 *
 * Like `runtime/`, it reaches into the app it extends by relative path rather
 * than through a package dependency. That is deliberate and matches the runtime
 * half exactly: the plugin is the thing that knows it is extending this app, so
 * the coupling is declared here rather than turning apps/web into something
 * that depends on its own plugins.
 *
 * What it renders is the node catalog, split by whether this deployment can
 * actually run each type. That is not a placeholder chosen for convenience —
 * `runtimeSupport` is the surface the eventual palette gates on, so putting it
 * on screen first makes the one question the designer must not get wrong
 * visible before any canvas exists to get it wrong in.
 */
import { Badge } from "../../../../apps/web/src/components/ui/display/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../apps/web/src/components/ui/display/card";

/** Mirrors the `WorkflowNodeType` GraphQL type this plugin's runtime half serves. */
export type WorkflowNodeTypeView = {
  type: string;
  catalog: string;
  category: string;
  label: Record<string, string> | null;
  description: Record<string, string> | null;
  runtimeSupport: "EXECUTABLE" | "UNIMPLEMENTED" | "UNSUPPORTED";
};

/**
 * The three states, in the order a reader cares about them, with the wording
 * they get on screen. `UNSUPPORTED` is not a stronger `UNIMPLEMENTED`: one is
 * work nobody has done, the other is work that would not help, and a user
 * deciding what to build with needs to be able to tell those apart.
 */
const SUPPORT_GROUPS = [
  {
    key: "EXECUTABLE" as const,
    title: "Runs here",
    blurb: "A bridge is registered, or the engine handles the type itself.",
    badge: "success" as const,
  },
  {
    key: "UNIMPLEMENTED" as const,
    title: "Not implemented in this deployment",
    blurb:
      "In the catalog, with no bridge behind it. A host repository closes the gap by registering one; until then a run reaching this node fails with NO_BRIDGE.",
    badge: "warning" as const,
  },
  {
    key: "UNSUPPORTED" as const,
    title: "The engine cannot run these",
    blurb:
      "Fan-out. The process runtime follows one edge at a time and keeps no branch identity, so a bridge would not make these runnable — they need an engine change, not an implementation.",
    badge: "destructive" as const,
  },
];

/** Locale maps come off the catalog whole; the client picks. English here. */
function text(value: Record<string, string> | null, fallback: string): string {
  return value?.en ?? value?.nl ?? fallback;
}

function NodeRow({ node }: { node: WorkflowNodeTypeView }) {
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{text(node.label, node.type)}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {node.type}
        </code>
        <Badge variant="outline">{node.category}</Badge>
        {/*
          Provenance, shown only when it is not the repo's own catalog. A
          `domain` badge answers "why is this here if nothing runs it" without
          the reader having to know the pack split exists.
        */}
        {node.catalog !== "standard" ? (
          <Badge variant="secondary">{node.catalog}</Badge>
        ) : null}
      </div>
      {node.description ? (
        <p className="text-sm text-muted-foreground">{text(node.description, "")}</p>
      ) : null}
    </li>
  );
}

export function WorkflowNodeCatalogView({ nodes }: { nodes: WorkflowNodeTypeView[] }) {
  const executable = nodes.filter((node) => node.runtimeSupport === "EXECUTABLE").length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The workflow node catalog this deployment compiled, grouped by whether
          the engine can execute each type. {executable} of {nodes.length} run
          today. The designer canvas is not built yet; this screen exists because
          the plugin can now contribute a route and a sidebar entry of its own.
        </p>
      </header>

      {SUPPORT_GROUPS.map((group) => {
        const groupNodes = nodes
          .filter((node) => node.runtimeSupport === group.key)
          // Sorted so the page does not reshuffle between reads; the API
          // returns catalog rows in table order, which is not a promise.
          .sort((a, b) => a.type.localeCompare(b.type));

        return (
          <Card key={group.key}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {group.title}
                <Badge variant={group.badge}>{groupNodes.length}</Badge>
              </CardTitle>
              <CardDescription>{group.blurb}</CardDescription>
            </CardHeader>
            <CardContent>
              {groupNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="flex flex-col">
                  {groupNodes.map((node) => (
                    <NodeRow key={node.type} node={node} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
