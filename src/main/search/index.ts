// Composition root for paper search.
//
// EVERY SOURCE COMES FROM A PLUGIN offering the `paper-search` capability,
// resolved at the moment a search runs. So "which indexes does this app query?"
// is a question about what the user has installed and switched on, and the app
// holds no opinion of its own that could drift from theirs.
//
// Search goes through a BROWSER, and that is why it is a plugin at all.
// Publishers and several indexes refuse a server outright: SSRN's API
// fingerprints TLS and 403s Node, Google Scholar blocks datacenter traffic. A
// plugin driving the user's own logged-in Chrome needs no impersonation because
// it IS Chrome. The cost is real and is not hidden — with no such plugin there
// is no search, and the app says so rather than producing zero hits.
//
// PULLED, NOT PUSHED. The registry asks the host for its sources on every
// search rather than being handed them when a plugin is enabled. A push would
// need the registry to exist before any plugin does, and this one is built
// lazily on first search; worse, it would leave a disabled plugin's source
// registered until something remembered to take it out, which is a search still
// reaching a plugin the user has switched off.

import { SearchSourceRegistry } from './registry'
import { pluginSearchSources } from './pluginSources'

export { SearchSourceRegistry } from './registry'
export type { SearchSource, SourceFailure } from './types'

export function createSearchRegistry(): SearchSourceRegistry {
  return new SearchSourceRegistry(pluginSearchSources)
}
