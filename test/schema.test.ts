import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderSchema, SCHEMA_PATH } from "../scripts/generate-schema.ts";
import { fileSchema } from "../src/config.ts";
import { PLACEHOLDERS } from "../src/template.ts";

test("the committed JSON Schema matches the zod schema it comes from", () => {
  assert.equal(
    readFileSync(SCHEMA_PATH, "utf8"),
    renderSchema(),
    "mention-forwarder.config.schema.json is stale; run `npm run schema`",
  );
});

test("every documented field carries a description", () => {
  const schema = JSON.parse(renderSchema()) as {
    properties: Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
  };
  for (const [name, property] of Object.entries(schema.properties)) {
    assert.equal(typeof property.description, "string", `${name} has no description`);
    for (const [child, nested] of Object.entries(property.properties ?? {})) {
      assert.equal(typeof nested.description, "string", `${name}.${child} has no description`);
    }
  }
});

test("every field that substitutes placeholders lists all of them", () => {
  const schema = JSON.parse(renderSchema()) as { properties: Record<string, { description: string }> };
  for (const field of ["command", "env"]) {
    const description = schema.properties[field]?.description ?? "";
    for (const name of PLACEHOLDERS) {
      assert.match(description, new RegExp("`\\{\\{" + name + "\\}\\}`"), `{{${name}}} is missing from the ${field} description`);
    }
  }
});

function readExample(): Record<string, unknown> {
  const path = fileURLToPath(new URL("../mention-forwarder.config.example.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("the example config is accepted, $schema key and all", () => {
  const result = fileSchema.safeParse(readExample());
  assert.equal(result.success, true, result.success ? "" : JSON.stringify(result.error.issues, null, 2));
});

test("the example config spells out every property, nested ones included", () => {
  const schema = JSON.parse(renderSchema()) as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };
  const example = readExample();
  for (const [name, property] of Object.entries(schema.properties)) {
    assert.ok(name in example, `${name} is missing from mention-forwarder.config.example.json`);
    const block = example[name] as Record<string, unknown>;
    for (const child of Object.keys(property.properties ?? {})) {
      assert.ok(child in block, `${name}.${child} is missing from mention-forwarder.config.example.json`);
    }
  }
});
