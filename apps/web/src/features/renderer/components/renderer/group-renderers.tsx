// SPDX-License-Identifier: BUSL-1.1
/**
 * Group renderer public facade.
 *
 * The implementation lives in `group-renderers/` so this stable import path
 * can stay small while preserving the existing public exports for renderer
 * callers and tests.
 */
export type { GroupRenderContext } from "./group-renderers/types";
export { renderCustomGroup } from "./group-renderers/custom-group";
export { renderRelationshipUsage } from "./group-renderers/relationship-usage";
export {
  renderGroup,
  renderGroupChildren,
  renderGroupFields,
  renderTabContent,
} from "./group-renderers/render-group";
