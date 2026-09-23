// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The agent's requested schema → the card's fields. ACP carries a JSON
// Schema (primitive properties only); the card renders controls, so the
// shape is normalized once here — the same division knobs.ts draws for the
// config surface: the host reads the wire, the webview renders what it is
// given.
//
// Refusal is part of the contract. A property this cannot present (an
// unknown type, a choice with no options) makes the whole form null: the
// caller then declines the request, which is a legal answer. Dropping the
// field instead would send the agent content the user never gave, and
// guessing a control for an unknown type would be worse.
import type { ElicitationField } from "../shared/protocol";

interface Option {
  value: string;
  label: string;
  description?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `oneOf`/`anyOf` entries (value + label, the wire's `const`/`title`), or a
 * bare `enum` of values that are their own labels. Null when neither is a
 * usable option list. */
function optionsOf(schema: Record<string, unknown>): Option[] | null {
  const titled = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(titled)) {
    const options: Option[] = [];
    for (const entry of titled) {
      const e = record(entry);
      const value = str(e?.const);
      if (value === undefined) return null;
      options.push({
        value,
        label: str(e?.title) ?? value,
        ...(str(e?.description) !== undefined ? { description: str(e?.description)! } : {}),
      });
    }
    return options.length > 0 ? options : null;
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v): v is string => typeof v === "string");
    return values.length === schema.enum.length && values.length > 0
      ? values.map((value) => ({ value, label: value }))
      : null;
  }
  return null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

/** Only the keys that are present — the card treats absent as "no limit". */
function present<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function fieldOf(name: string, schema: Record<string, unknown>, required: boolean): ElicitationField | null {
  const common = {
    name,
    ...present({ title: str(schema.title), description: str(schema.description) }),
    required,
  };
  // Defaults and limits are the agent's data too: each is kept only when
  // it has the shape its field needs, so a malformed one reads as absent
  // rather than pre-filling or blocking with nonsense.
  switch (schema.type) {
    case "string": {
      const options = optionsOf(schema);
      if (options !== null) {
        const def = str(schema.default);
        return {
          ...common,
          type: "select",
          options,
          ...(def !== undefined && options.some((o) => o.value === def) ? { default: def } : {}),
        };
      }
      return {
        ...common,
        type: "string",
        ...present({
          default: typeof schema.default === "string" ? schema.default : undefined,
          minLength: num(schema.minLength),
          maxLength: num(schema.maxLength),
          pattern: str(schema.pattern),
          format:
            typeof schema.format === "string" && FORMATS.has(schema.format)
              ? (schema.format as ElicitationField["format"])
              : undefined,
        }),
      };
    }
    case "number":
    case "integer":
      return {
        ...common,
        type: schema.type,
        ...present({ default: num(schema.default), minimum: num(schema.minimum), maximum: num(schema.maximum) }),
      };
    case "boolean":
      return {
        ...common,
        type: "boolean",
        ...(typeof schema.default === "boolean" ? { default: schema.default } : {}),
      };
    case "array": {
      // Multi-select only: the wire's array form is a list of choices, and
      // an array of anything else has no control here.
      const items = record(schema.items);
      const options = items === null ? null : optionsOf(items);
      if (options === null) return null;
      const offered = new Set(options.map((o) => o.value));
      const def = schema.default;
      const validDefault =
        Array.isArray(def) && def.every((v) => typeof v === "string" && offered.has(v))
          ? (def as string[])
          : undefined;
      return {
        ...common,
        type: "multiselect",
        options,
        ...present({ default: validDefault, minItems: num(schema.minItems), maxItems: num(schema.maxItems) }),
      };
    }
    default:
      return null;
  }
}

/** Every property as a field, in the schema's own order, or null when the
 * form cannot be presented honestly. */
export function formFieldsOf(requestedSchema: unknown): ElicitationField[] | null {
  const schema = record(requestedSchema);
  const properties = record(schema?.properties);
  if (properties === null) return null;
  const required = new Set(
    (Array.isArray(schema?.required) ? schema.required : []).filter((r): r is string => typeof r === "string"),
  );
  const fields: ElicitationField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const propertySchema = record(raw);
    if (propertySchema === null) return null;
    const field = fieldOf(name, propertySchema, required.has(name));
    if (field === null) return null;
    fields.push(field);
  }
  return fields.length > 0 ? fields : null;
}
