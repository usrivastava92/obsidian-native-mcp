/**
 * Tiny typed argument helpers for tool handlers. We don't pull a schema
 * validator dep; each tool calls these to extract typed values from the raw
 * args object and surface clear INVALID_ARGS errors.
 */

import { ToolFailure } from "../utils/types.js";

type AnyRecord = Record<string, unknown>;

export function getString(
  args: AnyRecord,
  key: string,
  opts?: { optional?: boolean },
): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts?.optional) return undefined;
    throw new ToolFailure("INVALID_ARGS", `missing required arg: ${key}`);
  }
  if (typeof v !== "string") {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be a string`);
  }
  return v;
}

export function reqString(args: AnyRecord, key: string): string {
  return getString(args, key)!;
}

export function getNumber(
  args: AnyRecord,
  key: string,
  opts?: { optional?: boolean; min?: number; max?: number },
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts?.optional) return undefined;
    throw new ToolFailure("INVALID_ARGS", `missing required arg: ${key}`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be a finite number`);
  }
  if (opts?.min !== undefined && v < opts.min) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be >= ${opts.min}`);
  }
  if (opts?.max !== undefined && v > opts.max) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be <= ${opts.max}`);
  }
  return v;
}

export function getInt(
  args: AnyRecord,
  key: string,
  opts?: { optional?: boolean; min?: number; max?: number },
): number | undefined {
  const v = getNumber(args, key, opts);
  if (v === undefined) return undefined;
  if (!Number.isInteger(v)) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be an integer`);
  }
  return v;
}

export function getBool(
  args: AnyRecord,
  key: string,
  opts?: { optional?: boolean; default?: boolean },
): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts?.optional) return opts.default;
    throw new ToolFailure("INVALID_ARGS", `missing required arg: ${key}`);
  }
  if (typeof v !== "boolean") {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be a boolean`);
  }
  return v;
}

export function getEnum<T extends string>(
  args: AnyRecord,
  key: string,
  allowed: readonly T[],
  opts?: { optional?: boolean; default?: T },
): T | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts?.optional) return opts.default;
    throw new ToolFailure("INVALID_ARGS", `missing required arg: ${key}`);
  }
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export function getRecord(
  args: AnyRecord,
  key: string,
  opts?: { optional?: boolean },
): AnyRecord | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts?.optional) return undefined;
    throw new ToolFailure("INVALID_ARGS", `missing required arg: ${key}`);
  }
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be an object`);
  }
  return v as AnyRecord;
}

export function getArray<T = unknown>(
  args: AnyRecord,
  key: string,
  opts?: { optional?: boolean },
): T[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (opts?.optional) return undefined;
    throw new ToolFailure("INVALID_ARGS", `missing required arg: ${key}`);
  }
  if (!Array.isArray(v)) {
    throw new ToolFailure("INVALID_ARGS", `arg ${key} must be an array`);
  }
  return v as T[];
}
