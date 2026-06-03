/**
 * @fileoverview Re-export of the shared wiki-source URL guard. The canonical
 * implementation lives in @slackhive/shared so the web add-source route and this
 * runner build path classify sources identically. Kept as a local module so
 * existing imports (and the colocated test) stay stable.
 *
 * @module runner/wiki-source-url
 */

export { isFetchableUrl } from '@slackhive/shared';
