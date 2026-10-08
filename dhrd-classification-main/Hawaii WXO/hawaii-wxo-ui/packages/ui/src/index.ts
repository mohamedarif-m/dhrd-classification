/**
 * Public surface of wxo-custom-ui: the whole custom UI kit for a watsonx
 * Orchestrate agent, in one package.
 *
 * Two layers live side by side as folders, not packages:
 *   src/form-engine  renders one Form Contract v1 payload
 *   src/app-shell    the workspace around it (chat, threads, streaming)
 *
 * Both surfaces are re-exported flat from here. The two export sets have no
 * name collisions, and that stays true by construction: adding a name to one
 * layer that already exists in the other breaks this file's build.
 *
 * A host that wants only one layer can import "wxo-custom-ui/form-engine"
 * or "wxo-custom-ui/app-shell" instead.
 */

export * from './form-engine';
export * from './app-shell';
