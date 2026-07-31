// SPDX-License-Identifier: BUSL-1.1
import type { SelectionOffsets } from "./types";

function isCaretAnchorNode(node: Node): boolean {
  if (node instanceof HTMLElement) {
    return node.dataset.caretAnchor === "true";
  }

  return node.parentElement?.dataset.caretAnchor === "true";
}

function serializeNode(node: Node): string {
  if (isCaretAnchorNode(node)) {
    return "";
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (!(node instanceof HTMLElement)) {
    return "";
  }

  if (node.dataset.tokenInsert) {
    return node.dataset.tokenInsert;
  }

  let text = "";
  for (const child of Array.from(node.childNodes)) {
    text += serializeNode(child);
  }

  return text;
}

export function serializeEditor(root: HTMLElement) {
  return Array.from(root.childNodes)
    .map((child) => serializeNode(child))
    .join("")
    .replace(/\u00a0/g, " ");
}

function getNodeLength(node: Node): number {
  return serializeNode(node).length;
}

function getOffsetForPosition(root: HTMLElement, targetNode: Node, targetOffset: number) {
  let offset = 0;

  const visit = (node: Node): boolean => {
    if (isCaretAnchorNode(node)) {
      if (
        node === targetNode ||
        (node instanceof HTMLElement && node.contains(targetNode))
      ) {
        return true;
      }

      return false;
    }

    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += targetOffset;
      } else if (node instanceof HTMLElement && node.dataset.tokenInsert) {
        offset += targetOffset > 0 ? node.dataset.tokenInsert.length : 0;
      } else {
        for (let index = 0; index < Math.min(targetOffset, node.childNodes.length); index += 1) {
          offset += getNodeLength(node.childNodes[index]);
        }
      }

      return true;
    }

    if (node instanceof HTMLElement && node.dataset.tokenInsert) {
      offset += node.dataset.tokenInsert.length;
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return false;
    }

    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) {
        return true;
      }
    }

    return false;
  };

  visit(root);
  return offset;
}

export function getSelectionOffsets(root: HTMLElement): SelectionOffsets | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  return {
    start: getOffsetForPosition(root, range.startContainer, range.startOffset),
    end: getOffsetForPosition(root, range.endContainer, range.endOffset),
  };
}

export function setSelectionOffsets(root: HTMLElement, offsets: SelectionOffsets) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const getCaretAnchorSelectionTarget = (
    anchorNode: Node | null,
    edge: "start" | "end",
  ): { node: Node; offset: number } | null => {
    if (!anchorNode || !isCaretAnchorNode(anchorNode)) {
      return null;
    }

    const textNode =
      anchorNode.nodeType === Node.TEXT_NODE ? anchorNode : anchorNode.firstChild;
    if (textNode?.nodeType === Node.TEXT_NODE) {
      const textLength = textNode.textContent?.length ?? 0;
      return {
        node: textNode,
        offset: edge === "start" ? 0 : textLength,
      };
    }

    const element = anchorNode instanceof HTMLElement
      ? anchorNode
      : anchorNode.parentElement;
    const parentNode = element?.parentNode ?? root;
    const childIndex = element ? Array.from(parentNode.childNodes).indexOf(element) : 0;
    return {
      node: parentNode,
      offset: edge === "start" ? childIndex : childIndex + 1,
    };
  };

  const locate = (targetOffset: number) => {
    let consumed = 0;
    let fallbackNode: Node = root;
    let fallbackOffset = root.childNodes.length;

    const visit = (node: Node): { found: boolean; node: Node; offset: number } => {
      if (isCaretAnchorNode(node)) {
        const anchorNode = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
        const parentNode = anchorNode?.parentNode ?? root;
        fallbackNode = parentNode;
        fallbackOffset = Array.from(parentNode.childNodes).indexOf(anchorNode as ChildNode);
        return { found: false, node: fallbackNode, offset: fallbackOffset };
      }

      if (node instanceof HTMLElement && node.dataset.tokenInsert) {
        const tokenLength = node.dataset.tokenInsert.length;
        if (targetOffset <= consumed) {
          const leadingAnchor = getCaretAnchorSelectionTarget(node.previousSibling, "end");
          if (leadingAnchor) {
            return {
              found: true,
              node: leadingAnchor.node,
              offset: leadingAnchor.offset,
            };
          }

          return {
            found: true,
            node: node.parentNode ?? root,
            offset: Array.from((node.parentNode ?? root).childNodes).indexOf(node),
          };
        }

        consumed += tokenLength;
        fallbackNode = node.parentNode ?? root;
        fallbackOffset = Array.from((node.parentNode ?? root).childNodes).indexOf(node) + 1;
        if (targetOffset <= consumed) {
          const trailingAnchor = getCaretAnchorSelectionTarget(node.nextSibling, "start");
          if (trailingAnchor) {
            return {
              found: true,
              node: trailingAnchor.node,
              offset: trailingAnchor.offset,
            };
          }

          return {
            found: true,
            node: node.parentNode ?? root,
            offset: fallbackOffset,
          };
        }

        return { found: false, node: fallbackNode, offset: fallbackOffset };
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (targetOffset <= consumed + textLength) {
          return {
            found: true,
            node,
            offset: Math.max(0, targetOffset - consumed),
          };
        }

        consumed += textLength;
        fallbackNode = node;
        fallbackOffset = textLength;
        return { found: false, node: fallbackNode, offset: fallbackOffset };
      }

      for (const child of Array.from(node.childNodes)) {
        const result = visit(child);
        if (result.found) {
          return result;
        }
      }

      fallbackNode = node;
      fallbackOffset = node.childNodes.length;
      return { found: false, node: fallbackNode, offset: fallbackOffset };
    };

    const result = visit(root);
    return result.found ? result : { found: true, node: fallbackNode, offset: fallbackOffset };
  };

  const start = locate(offsets.start);
  const end = locate(offsets.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}
