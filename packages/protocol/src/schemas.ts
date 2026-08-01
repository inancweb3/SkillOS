/**
 * Load and register Draft 2020-12 schemas for parseAndValidateSchema.
 * Schemas are checked-in hand-authored artifacts (not codegen); source of truth
 * is packages/protocol/schemas/*.json.
 */

import type { SchemaObject } from "ajv";
import type { SchemaId } from "./types.js";

import arenaDefinition from "../schemas/arena-definition.schema.json" with { type: "json" };
import benchmarkManifest from "../schemas/benchmark-manifest.schema.json" with { type: "json" };
import measurementDefinition from "../schemas/measurement-definition.schema.json" with { type: "json" };
import evidenceEnvelope from "../schemas/evidence-envelope.schema.json" with { type: "json" };
import verifierDescriptor from "../schemas/verifier-descriptor.schema.json" with { type: "json" };
import verificationResult from "../schemas/verification-result.schema.json" with { type: "json" };

export const SCHEMA_REGISTRY: Record<SchemaId, SchemaObject> = {
  ArenaDefinition: arenaDefinition as SchemaObject,
  BenchmarkManifest: benchmarkManifest as SchemaObject,
  MeasurementDefinition: measurementDefinition as SchemaObject,
  EvidenceEnvelope: evidenceEnvelope as SchemaObject,
  VerifierDescriptor: verifierDescriptor as SchemaObject,
  VerificationResult: verificationResult as SchemaObject,
};

export const SCHEMA_IDS = Object.keys(SCHEMA_REGISTRY) as SchemaId[];
