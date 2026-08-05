import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES,
  JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES,
  JSON_COMPATIBILITY_RUNNER_RECEIPT_MAX_BYTES,
  JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_MAX_BYTES,
  readBoundedUtf8File,
} from "../tools/lib/bounded_json_file.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryPath(name) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-json-bounded-file-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

describe("JSON compatibility bounded file reader", () => {
  test("leaves headroom across private, operator, and phase source limits", () => {
    expect(JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_MAX_BYTES).toBe(
      1536 * 1024,
    );
    expect(JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES).toBe(
      1792 * 1024,
    );
    expect(JSON_COMPATIBILITY_RUNNER_RECEIPT_MAX_BYTES).toBe(1984 * 1024);
    expect(JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_MAX_BYTES).toBeLessThan(
      JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES,
    );
    expect(JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_MAX_BYTES).toBeLessThan(
      JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES,
    );
    expect(JSON_COMPATIBILITY_RUNNER_RECEIPT_MAX_BYTES).toBeLessThan(
      JSON_COMPATIBILITY_PHASE_SOURCE_MAX_BYTES,
    );
  });

  test("reads a stable nonempty regular UTF-8 file within its explicit limit", async () => {
    const file = await temporaryPath("plan.json");
    await writeFile(file, '{"schemaVersion":1}', "utf8");

    await expect(readBoundedUtf8File(file, 64, "plan")).resolves.toBe(
      '{"schemaVersion":1}',
    );
  });

  test("rejects oversized, BOM-prefixed, and invalid UTF-8 input before parsing", async () => {
    const oversized = await temporaryPath("oversized.json");
    const bom = await temporaryPath("bom.json");
    const invalidUtf8 = await temporaryPath("invalid.json");
    await Promise.all([
      writeFile(oversized, Buffer.alloc(65, 0x61)),
      writeFile(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
      writeFile(invalidUtf8, Buffer.from([0xc3, 0x28])),
    ]);

    await expect(readBoundedUtf8File(oversized, 64, "oversized")).rejects.toThrow(
      /no larger than 64 bytes/,
    );
    await expect(readBoundedUtf8File(bom, 64, "BOM input")).rejects.toThrow(
      /UTF-8 BOM/,
    );
    await expect(
      readBoundedUtf8File(invalidUtf8, 64, "invalid input"),
    ).rejects.toThrow(/valid UTF-8/);
  });
});
