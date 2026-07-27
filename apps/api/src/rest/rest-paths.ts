// SPDX-License-Identifier: BUSL-1.1
/**
 * REST path constants.
 *
 * Split out so the docs UI can name the spec's path without importing the
 * route module that registers it — which registers the docs in turn, and would
 * make the two files import each other.
 */
export const REST_MOUNT_PATH = "/api/rest/v1";
export const REST_OPENAPI_PATH = "/api/rest/openapi.json";
