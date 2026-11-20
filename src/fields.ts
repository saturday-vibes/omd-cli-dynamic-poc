import type { JsonSchema } from './registry';

export type Field = {
  path: string;
  type: string;
  required: boolean;
  enum?: unknown[];
};

/** Every property in a schema, depth first, with dotted paths (`omd_component.name`). */
export function listFields(schema: JsonSchema, prefix = ''): Field[] {
  const fields: Field[] = [];
  const required = new Set(schema.required ?? []);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    fields.push({
      path,
      type: [property.type ?? 'any'].flat().join('|'),
      required: required.has(name),
      ...(property.enum ? { enum: property.enum } : {}),
    });
    fields.push(...listFields(property, path));
    if (property.items) {
      fields.push(...listFields(property.items, `${path}[]`));
    }
  }
  return fields;
}
