import assert from 'node:assert/strict';
import { openapiDocument, type ApiSchema, type ApiOperation } from '../src/openapi.js';

// 僅用來對照本課使用的 JSON Schema 子集，不是完整 OpenAPI／JSON Schema validator。
export function assertDocumented(value: unknown, schema: ApiSchema, path = '$'): void {
  if (schema.$ref) {
    const name = String(schema.$ref).replace('#/components/schemas/', '');
    assert.ok(openapiDocument.components.schemas[name], `未解析 $ref ${schema.$ref}`);
    return assertDocumented(value, openapiDocument.components.schemas[name], path);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === type);
    assert.ok(matches, `${path} type`);
  }
  if (schema.enum) assert.ok((schema.enum as unknown[]).includes(value), `${path} enum`);
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, `${path} const`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok([...value].length >= Number(schema.minLength), `${path} minLength`);
    if (schema.maxLength !== undefined) assert.ok([...value].length <= Number(schema.maxLength), `${path} maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(String(schema.pattern)), `${path} pattern`);
    if (schema.format === 'date-time') assert.ok(Number.isFinite(Date.parse(value)), `${path} date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= Number(schema.minimum), `${path} minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= Number(schema.maximum), `${path} maximum`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const data = value as Record<string, unknown>;
    for (const name of (schema.required ?? []) as string[]) assert.ok(Object.hasOwn(data, name), `${path}.${name} required`);
    const properties = (schema.properties ?? {}) as Record<string, ApiSchema>;
    for (const [name, item] of Object.entries(data)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(properties, name), `${path}.${name} unexpected`);
      if (properties[name]) assertDocumented(item, properties[name], `${path}.${name}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => assertDocumented(item, schema.items as ApiSchema, `${path}[${i}]`));
  if (schema.anyOf) assert.ok((schema.anyOf as ApiSchema[]).some(branch => {
    try { assertDocumented(value, branch, path); return true; } catch { return false; }
  }), `${path} anyOf`);
}
export function assertApiResponse(operation: ApiOperation, status: number, value: unknown) {
  const response = operation.responses[String(status)] ?? operation.responses.default;
  assert.ok(response, `缺少 response ${status}`);
  const content = response.content as Record<string, { schema: ApiSchema }> | undefined;
  assert.ok(content?.['application/json'], '必須是 JSON response');
  assertDocumented(value, content['application/json'].schema);
}
