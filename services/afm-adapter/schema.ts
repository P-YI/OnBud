// Minimal JSON Schema checker for the subset apfel's guided generation accepts
// (object / string / integer / number / boolean / array, enum, required, additionalProperties).
// Guided generation guarantees syntax; this re-checks the shape deterministically on the host.

export type JSONSchema = {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JSONSchema;
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  [k: string]: unknown;
};

export function validate(schema: JSONSchema, value: unknown, path = "$"): string[] {
  const errs: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [...errs, `${path}: expected object`];
      const obj = value as Record<string, unknown>;
      for (const k of schema.required ?? []) if (!(k in obj)) errs.push(`${path}.${k}: missing`);
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties?.[k];
        if (sub) errs.push(...validate(sub, v, `${path}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${path}.${k}: unexpected`);
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) return [...errs, `${path}: expected array`];
      if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items!, v, `${path}[${i}]`)));
      break;
    case "string":
      if (typeof value !== "string") errs.push(`${path}: expected string`);
      else if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: too long`);
      break;
    case "integer":
      if (!Number.isInteger(value)) errs.push(`${path}: expected integer`);
      break;
    case "number":
      if (typeof value !== "number") errs.push(`${path}: expected number`);
      break;
    case "boolean":
      if (typeof value !== "boolean") errs.push(`${path}: expected boolean`);
      break;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above maximum`);
  }
  return errs;
}

/** apfel rejects keywords it cannot guide; strip annotation-only keys before sending. */
export function forWire(schema: JSONSchema): JSONSchema {
  const { $schema, title, maxLength, minimum, maximum, ...rest } = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, forWire(v)]));
  if (schema.items) out.items = forWire(schema.items);
  return out as JSONSchema;
}
