import { describe, expect, test } from "vitest";

import { canonicalJson, sha256Canonical } from "../src/canonical";

describe("deployment transition canonical JSON", () => {
  test("sorts object keys recursively without reordering arrays", async () => {
    const value = { z: [3, { b: true, a: null }], a: "first" };
    expect(canonicalJson(value)).toBe(
      '{"a":"first","z":[3,{"a":null,"b":true}]}',
    );
    await expect(sha256Canonical(value)).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects non-finite number %s",
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(
        "canonical JSON cannot contain non-finite numbers",
      );
    },
  );

  test("rejects undefined and unsupported values", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(
      "canonical JSON cannot contain undefined",
    );
    expect(() => canonicalJson(Symbol("unsupported"))).toThrow(
      "canonical JSON contains an unsupported value",
    );
  });
});
