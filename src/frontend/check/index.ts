/**
 * The Norn type checker (docs/types.md).
 *
 * ```ts
 * const host = loadInterface(hostProgram, "hosts/reference.norn");
 * const std = loadLibrary(stdProgram, "std/std.norn", host);
 * const result = checkProgram(program, { host, std });
 * ```
 *
 * `readInterface`, `readLibrary` and `checkSource` do the same from source
 * text. Nothing this module exports reads a file or needs Node, so it runs in
 * a browser. `node.ts` reads the reference host and the standard library from
 * this repository's files.
 */
export { FAMILIES, builtinModuleExports, type Family } from "./builtins.ts";
export { CODES, type CheckDiagnostic, type Code, type DiagnosticFix, type DiagnosticSecondary, type Severity } from "./diagnostics.ts";
export type { EffectSummary } from "./effects.ts";
export { elaborate, type FormEvidencePlan } from "./elaborate.ts";
export {
  ACTIONS_INTERFACE_SOURCE, EVENTS_INTERFACE_SOURCE, manifestActionForm, manifestEventForm, validateActionAgainstManifests,
  validateEventKindAgainstManifests,
  type ConnectorActionSpec, type ConnectorEventSpec, type ConnectorFieldSpec, type ConnectorManifest,
} from "./events.ts";
export type { Form, FormDefinition, FormRefusal, ReportForm } from "./forms.ts";
export { checkProgram, loadLibrary, type CheckOptions, type CheckResult, type Library, type LoadLibraryOptions } from "./infer.ts";
export { builtinInterface, hostSources, loadInterface, type HostInterface, type ValueBinding } from "./interface.ts";
export {
  deriveInterface, diffEffectLocks, diffInterfaces, diffProgramUpgrade, formatInterfaceSummary, pinProgramDefinitions,
  type DerivedInterface, type DerivedTypeExport, type DerivedValueExport, type EffectLockDiff, type InterfaceChangeKind, type InterfaceDiff, type ProgramPin, type UpgradeDiff,
} from "./modules.ts";
export { checkSource, readInterface, readLibrary, type SourceCheck } from "./source.ts";
