// SPDX-License-Identifier: BUSL-1.1
import { resolveElkSourceHandleId } from "./graph.ts";
import type {
  WorkflowLayoutEdge,
  WorkflowLayoutNode,
  WorkflowLayoutRuntime,
} from "./types.ts";

type ElkBendPoint = {
  x: number;
  y: number;
};

type ElkEdgeSection = {
  startPoint?: ElkBendPoint;
  endPoint?: ElkBendPoint;
  bendPoints?: ElkBendPoint[];
};

type ElkLayoutGraph = {
  id: string;
  layoutOptions?: Record<string, string>;
  children?: Array<{
    id: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    ports?: Array<{
      id: string;
      properties?: Record<string, string>;
    }>;
  }>;
  edges?: Array<{
    id: string;
    sources: string[];
    targets: string[];
    sections?: ElkEdgeSection[];
    properties?: Record<string, string>;
  }>;
};

type ElkConstructor = new (options?: { workerUrl?: string }) => {
  layout: (graph: ElkLayoutGraph) => Promise<ElkLayoutGraph>;
};

let elkPromise: Promise<InstanceType<ElkConstructor>> | null = null;

export async function getElk(runtime: WorkflowLayoutRuntime) {
  if (runtime === "browser" && typeof Worker === "undefined") {
    return null;
  }

  if (!elkPromise) {
    elkPromise = (runtime === "server"
      ? Promise.resolve(require("elkjs/lib/main.js"))
      : import("elkjs/lib/elk.bundled.js"))
      .then((module: unknown) => {
        const record = module as { default?: unknown };
        const Elk = (record.default ?? module) as ElkConstructor;
        return runtime === "server"
          ? new Elk({ workerUrl: resolveServerElkWorkerUrl() })
          : new Elk();
      })
      .catch((error) => {
        elkPromise = null;
        throw error;
      });
  }

  return elkPromise;
}

function resolveServerElkWorkerUrl() {
  const bun = (globalThis as {
    Bun?: {
      resolveSync?: (specifier: string, from: string) => string;
    };
  }).Bun;
  const resolved = bun?.resolveSync?.(
    "elkjs/lib/elk-worker.min.js",
    import.meta.dir,
  );
  if (!resolved) {
    throw new Error(
      "Server workflow layout requires Bun.resolveSync to locate the ELK worker.",
    );
  }
  return resolved;
}

export function buildElkLayoutGraph(input: {
  nodes: WorkflowLayoutNode[];
  sortedEdges: WorkflowLayoutEdge[];
  backEdgeIds: Set<string>;
  isTriggerNodeType: (node: WorkflowLayoutNode) => boolean;
}): ElkLayoutGraph {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node] as const));

  return {
    id: "workflow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
      "elk.spacing.nodeNode": "100",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.layered.spacing.edgeNodeBetweenLayers": "12",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "8",
      "elk.portConstraints": "FIXED_ORDER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
    },
    children: input.nodes.map((node) => ({
      id: node.id,
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
      ports: [
        ...(!input.isTriggerNodeType(node)
          ? [
              {
                id: `${node.id}__in`,
                properties: { side: "NORTH" },
              },
            ]
          : []),
        ...(node.outputHandles ?? []).map((handle, index) => ({
          id: `${node.id}__${handle.id}`,
          properties: {
            side: "SOUTH",
            "port.index": String((node.outputHandles ?? []).length - 1 - index),
          },
        })),
      ],
    })),
    edges: input.sortedEdges.map((edge) => ({
      id: edge.id,
      sources: [
        `${edge.source}__${resolveElkSourceHandleId(
          nodeById.get(edge.source),
          edge.sourceHandle,
        )}`,
      ],
      targets: [`${edge.target}__in`],
      ...(input.backEdgeIds.has(edge.id)
        ? { properties: { "elk.layered.priority.direction": "-1" } }
        : {}),
    })),
  };
}

export function extractElkRoutePoints(
  elkEdge: { sections?: ElkEdgeSection[] },
  offset: { x: number; y: number },
): { x: number; y: number }[] | undefined {
  const section = elkEdge.sections?.[0];
  if (!section) {
    return undefined;
  }

  const points: { x: number; y: number }[] = [];

  if (section.startPoint) {
    points.push({
      x: section.startPoint.x + offset.x,
      y: section.startPoint.y + offset.y,
    });
  }

  for (const bend of section.bendPoints ?? []) {
    points.push({ x: bend.x + offset.x, y: bend.y + offset.y });
  }

  if (section.endPoint) {
    points.push({
      x: section.endPoint.x + offset.x,
      y: section.endPoint.y + offset.y,
    });
  }

  return points.length >= 2 ? points : undefined;
}
