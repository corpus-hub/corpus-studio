// The ONE place `@huggingface/transformers` is imported, so the offline
// settings exist in exactly one place and cannot drift between the models that
// use them.
//
// The model ROOT IS AN ARGUMENT, and that is the whole point of this module.
// `env.localModelPath` is a mutable global shared by every model in the
// process, so a caller that sets it and a caller that forgets are
// indistinguishable until one of them reads from the other's tree — and with
// `local_files_only` on, the symptom is a missing-file error naming a path
// nobody expected rather than an obvious bug. Asking for the root at the call
// makes forgetting impossible.
//
// THREE SETTINGS ARE THE WHOLE OFFLINE STORY, and none of them is optional:
//
//   env.allowRemoteModels = false   any missing file becomes a hard error
//                                   naming the path, instead of a silent fetch
//                                   from huggingface.co on a user's machine
//   env.allowLocalModels  = true    read from disk at all
//   env.localModelPath    = <dir>   the ROOT above `<org>/<model>`; the library
//                                   appends the rest itself
//
// plus `local_files_only: true` at the call site, which closes the same door
// from the other side. `getModelFile` only reaches the network after passing
// BOTH checks, so either alone is sufficient and both together is deliberate:
// deleting one is otherwise a green build that phones home in the field.
//
// This module must NEVER be imported from the renderer. `@huggingface/
// transformers` statically imports both onnxruntime-node and
// onnxruntime-web/webgpu; the package's `node` export condition resolves the
// Node build in main and in a utilityProcess, but a stray renderer import
// resolves the WEB build, which needs `wasm-unsafe-eval` and fetches its wasm
// from a CDN. `verify:offline` bans that import in renderer source.

type Transformers = typeof import('@huggingface/transformers')

/** The library, pointed at `root` as its local model tree. */
export async function transformersFor(root: string): Promise<Transformers> {
  const t = await import('@huggingface/transformers')
  t.env.allowRemoteModels = false
  t.env.allowLocalModels = true
  t.env.localModelPath = root
  return t
}
