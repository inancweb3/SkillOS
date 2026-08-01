/**
 * Measurement definition + value bag validation (presence, uniqueness, valueType).
 * Uses Object.hasOwn — never `in` on potentially polluted prototypes.
 */

import {
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type MeasurementDefinition,
  type MeasurementValue,
  ProtocolError,
} from "./types.js";

/**
 * Assert measurement definition ids are unique on a manifest.
 */
export function assertUniqueMeasurementIds(
  definitions: MeasurementDefinition[],
): void {
  const seen = new Set<string>();
  for (const def of definitions) {
    if (seen.has(def.id)) {
      throw new ProtocolError(
        "DUPLICATE_MEASUREMENT_ID",
        `duplicate measurement definition id: ${def.id}`,
        { measurementId: def.id },
      );
    }
    seen.add(def.id);
  }
}

function valueMatchesType(
  value: MeasurementValue,
  valueType: MeasurementDefinition["valueType"],
): boolean {
  if (valueType === "number") return typeof value === "number";
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "string") return typeof value === "string";
  return false;
}

/**
 * Full measurement validation for evidence against manifest definitions.
 * - unique definition ids
 * - required presence via Object.hasOwn
 * - valueType alignment
 * - reject unknown measurement keys not declared on the manifest
 */
export function assertMeasurements(
  manifest: BenchmarkManifest,
  evidence: EvidenceEnvelope,
): void {
  assertUniqueMeasurementIds(manifest.measurements);

  const defsById = new Map<string, MeasurementDefinition>();
  for (const def of manifest.measurements) {
    defsById.set(def.id, def);
  }

  const bag = evidence.measurements;
  if (bag === undefined) {
    for (const def of manifest.measurements) {
      if (def.required === true) {
        throw new ProtocolError(
          "MISSING_REQUIRED_MEASUREMENT",
          `missing required measurement: ${def.id}`,
          { measurementId: def.id },
        );
      }
    }
    return;
  }

  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) {
    throw new ProtocolError(
      "INVALID_INPUT",
      "evidence.measurements must be a plain object map",
    );
  }

  for (const def of manifest.measurements) {
    if (def.required === true && !Object.hasOwn(bag, def.id)) {
      throw new ProtocolError(
        "MISSING_REQUIRED_MEASUREMENT",
        `missing required measurement: ${def.id}`,
        { measurementId: def.id },
      );
    }
    if (Object.hasOwn(bag, def.id)) {
      const v = bag[def.id] as MeasurementValue;
      if (!valueMatchesType(v, def.valueType)) {
        throw new ProtocolError(
          "MEASUREMENT_TYPE_MISMATCH",
          `measurement ${def.id}: expected valueType ${def.valueType}, got ${typeof v}`,
          { measurementId: def.id, valueType: def.valueType, actual: typeof v },
        );
      }
    }
  }

  for (const key of Object.keys(bag)) {
    if (!defsById.has(key)) {
      throw new ProtocolError(
        "UNKNOWN_MEASUREMENT",
        `unknown measurement id not declared on manifest: ${key}`,
        { measurementId: key },
      );
    }
  }
}

/** @deprecated Use assertMeasurements — kept as thin alias for presence-only call sites. */
export function assertRequiredMeasurements(
  manifest: BenchmarkManifest,
  evidence: EvidenceEnvelope,
): void {
  assertMeasurements(manifest, evidence);
}
