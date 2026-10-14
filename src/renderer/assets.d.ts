// Ambient declarations for static assets imported by the renderer. Kept as a
// SCRIPT (no top-level import/export) so the wildcard module declarations are
// truly global — required under `moduleResolution: "Bundler"`, where a wildcard
// `declare module` inside a module file may not be picked up. Vite turns these
// imports into emitted file: URL strings (never inlined data: for the strict
// CSP; images are additionally allowed by `img-src 'self' data:`).
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
