// SPDX-License-Identifier: Apache-2.0
//
// Minimal Zod → JSON Schema converter for the MCP `tools/list` payload.
// We only need the subset of JSON Schema that MCP hosts actually consume
// (object shapes, primitives, enums, optional/default, descriptions), so
// we hand-roll this rather than pull in a full converter dep.

import { z } from "zod";
import {
  ZodObject,
  ZodString,
  ZodNumber,
  ZodBoolean,
  ZodEnum,
  ZodArray,
  ZodOptional,
  ZodDefault,
  ZodNullable,
  ZodLiteral,
  ZodEffects,
  ZodUnion,
} from "zod";

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
}

export type JsonSchemaNode =
  | { type: "string"; description?: string; enum?: string[]; format?: string; pattern?: string; minLength?: number; maxLength?: number }
  | { type: "number"; description?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number }
  | { type: "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchemaNode; description?: string }
  | JsonSchemaObject
  | { description?: string; anyOf: JsonSchemaNode[] }
  | { type: "null" };

export function zodToJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const node = nodeFor(schema);
  if (node && "type" in node && node.type === "object") return node;
  // Top-level non-object inputs are unusual for MCP tools; wrap to keep
  // the contract consistent (`tools/list` MUST return an object schema).
  return {
    type: "object",
    properties: { value: node ?? { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
}

function nodeFor(schema: z.ZodType): JsonSchemaNode {
  if (schema instanceof ZodOptional) {
    return nodeFor(schema._def.innerType as z.ZodType);
  }
  if (schema instanceof ZodDefault) {
    return nodeFor(schema._def.innerType as z.ZodType);
  }
  if (schema instanceof ZodNullable) {
    return { anyOf: [nodeFor(schema._def.innerType as z.ZodType), { type: "null" }] };
  }
  if (schema instanceof ZodEffects) {
    return nodeFor(schema._def.schema as z.ZodType);
  }
  if (schema instanceof ZodObject) {
    const props: Record<string, JsonSchemaNode> = {};
    const required: string[] = [];
    const shape = schema.shape as Record<string, z.ZodType>;
    for (const [k, v] of Object.entries(shape)) {
      props[k] = nodeFor(v);
      if (
        !(v instanceof ZodOptional) &&
        !(v instanceof ZodDefault) &&
        !(v instanceof ZodNullable)
      ) {
        required.push(k);
      }
    }
    const out: JsonSchemaObject = {
      type: "object",
      properties: props,
      additionalProperties: false,
    };
    if (required.length) out.required = required;
    if (schema.description) (out as JsonSchemaObject & { description?: string }).description = schema.description;
    return out;
  }
  if (schema instanceof ZodString) {
    const node: JsonSchemaNode = { type: "string" };
    if (schema.description) node.description = schema.description;
    if (schema.isEmail) node.format = "email";
    if (schema.isURL) node.format = "uri";
    if (schema.isDatetime) node.format = "date-time";
    if (schema.minLength !== null) (node as { minLength?: number }).minLength = schema.minLength;
    if (schema.maxLength !== null) (node as { maxLength?: number }).maxLength = schema.maxLength;
    return node;
  }
  if (schema instanceof ZodNumber) {
    const node: JsonSchemaNode = schema.isInt ? { type: "integer" } : { type: "number" };
    if (schema.description) node.description = schema.description;
    const min = schema.minValue;
    const max = schema.maxValue;
    if (min !== null) (node as { minimum?: number }).minimum = min;
    if (max !== null) (node as { maximum?: number }).maximum = max;
    return node;
  }
  if (schema instanceof ZodBoolean) {
    const node: JsonSchemaNode = { type: "boolean" };
    if (schema.description) node.description = schema.description;
    return node;
  }
  if (schema instanceof ZodEnum) {
    const node: JsonSchemaNode = {
      type: "string",
      enum: [...(schema.options as readonly string[])],
    };
    if (schema.description) node.description = schema.description;
    return node;
  }
  if (schema instanceof ZodLiteral) {
    const v = (schema._def as { value: unknown }).value;
    if (typeof v === "string") return { type: "string", enum: [v] };
    if (typeof v === "number") return { type: "number" };
    if (typeof v === "boolean") return { type: "boolean" };
  }
  if (schema instanceof ZodArray) {
    const inner = (schema._def as { type: z.ZodType }).type;
    return { type: "array", items: nodeFor(inner) };
  }
  if (schema instanceof ZodUnion) {
    const opts = (schema._def as { options: z.ZodType[] }).options;
    return { anyOf: opts.map((o) => nodeFor(o)) };
  }
  // Fallback: permissive string. MCP hosts will still call the tool;
  // server-side `inputSchema.parse` is the source of truth.
  return { type: "string" };
}
