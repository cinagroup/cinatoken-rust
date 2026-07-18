import { describe, expect, test } from "vitest";

import {
  MAX_PROVIDER_RESPONSE_V3_BODY_BYTES,
  MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES,
  MAX_PROVIDER_RESPONSE_V3_OPERATIONAL_ENVELOPE_BYTES,
  PROVIDER_RESPONSE_V3_CONTENT_TYPE,
  PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
  PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
  PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
  parseProviderResponseV3,
  readProviderResponseV3,
  type ProviderResponseClassV3,
  type ProviderResponseEnvelopeV3,
} from "../src/provider_response_v3";
import type { ProviderUsageReceipt } from "../src/storage_gateway";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const completedAt = 1_784_313_600_000;
const requestSha256 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const operationId = "corpus-operation-exact-200";
const providerOperationId = "corpus-provider-operation-1";
const workerVersionId = "corpus-worker-version-1";
const providerRequestId = "request-exact-200";
const errorBody = encoder.encode(
  '{"error":{"message":"provider failed","type":"provider_error","param":"","code":"provider_error"}}',
);

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? Mutable<T[Key]> : T[Key];
};
type MutableEnvelope = Mutable<ProviderResponseEnvelopeV3>;

interface FixtureOptions {
  responseClass?: ProviderResponseClassV3;
  providerStatus?: number;
  clientStatus?: number;
  auditStatus?: number;
  rawBody?: Uint8Array;
  clientBody?: Uint8Array;
  bodySameAsRaw?: boolean;
  includeReceipt?: boolean;
  rawHeaders?: Record<string, string>;
  rawContentType?: string | null;
}

interface CanonicalFixture {
  envelope: MutableEnvelope;
  bytes: Uint8Array;
  rawBody: Uint8Array;
  clientBody: Uint8Array;
  usageReceiptSha256: string | null;
}

// Mirrors Rust ProviderResponseV3CorpusFixture. Fixed digests keep the local
// exact_200 producer byte-identical until the primary integrator wires generated corpus I/O.
interface ProviderResponseV3SharedVector {
  name: string;
  envelope_bytes: Uint8Array;
  envelope_length: number;
  canonical_envelope_sha256: string;
  raw_body_sha256: string;
  client_body_sha256: string;
  usage_receipt_sha256: string | null;
  provider_response_evidence_sha256: string;
  client_response_artifact_sha256: string;
}

const LOCAL_SHARED_VECTOR_EXPECTED = {
  envelope_length: 3_051,
  canonical_envelope_sha256:
    "e4b278bd5f0e63d4fded93365ecb83acb4ca2b746f26c327f97f5dfa1a897c5e",
  raw_body_sha256: "be88c1b90db65470bc5e7ea82df92570863ac4fbf343b534d281d729769f5911",
  client_body_sha256: "be88c1b90db65470bc5e7ea82df92570863ac4fbf343b534d281d729769f5911",
  usage_receipt_sha256:
    "ac8f9f89afbd5eff11058ec3eac2450a381f41d82dae305aab0328f5cf91e9c4",
  provider_response_evidence_sha256:
    "794b6d7568c2491ecd8afee9bac0b23d4297cfdb2e41c984a79aee5bc8727ee3",
  client_response_artifact_sha256:
    "95c583b95fef6da49b1f18e35358212799e24ab3bca3ed78f6190dc6ffbb6dbe",
} as const;

describe("provider response v3 shared canonical vector", () => {
  test("accepts exact bytes and exposes gateway-ready typed evidence", async () => {
    const vector = await localSharedVector();
    const verified = await parseProviderResponseV3(vector.envelope_bytes);

    expect(vector.envelope_length).toBe(LOCAL_SHARED_VECTOR_EXPECTED.envelope_length);
    expect(vector.canonical_envelope_sha256).toBe(
      LOCAL_SHARED_VECTOR_EXPECTED.canonical_envelope_sha256,
    );
    expect(vector.raw_body_sha256).toBe(LOCAL_SHARED_VECTOR_EXPECTED.raw_body_sha256);
    expect(vector.client_body_sha256).toBe(LOCAL_SHARED_VECTOR_EXPECTED.client_body_sha256);
    expect(vector.usage_receipt_sha256).toBe(
      LOCAL_SHARED_VECTOR_EXPECTED.usage_receipt_sha256,
    );
    expect(vector.provider_response_evidence_sha256).toBe(
      LOCAL_SHARED_VECTOR_EXPECTED.provider_response_evidence_sha256,
    );
    expect(vector.client_response_artifact_sha256).toBe(
      LOCAL_SHARED_VECTOR_EXPECTED.client_response_artifact_sha256,
    );
    expect(verified.envelope.interpretation.response_class).toBe("success");
    expect(verified.raw_headers).toEqual({
      "content-type": "application/json",
      "x-request-id": providerRequestId,
    });
    expect(verified.client_headers).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-request-id": providerRequestId,
    });
    expect(verified.envelope.usage_receipt).not.toBeNull();
    expect(typeof verified.envelope.usage_receipt).toBe("object");
    expect(verified.raw_body).toEqual(verified.client_body);
    expect(verified.usage_receipt_sha256).toBe(vector.usage_receipt_sha256);
    expect(verified.usage_receipt_json).toBe(
      JSON.stringify(verified.envelope.usage_receipt),
    );
    expect("body_base64" in verified.envelope.raw).toBe(false);
    expect("body_base64" in verified.envelope.client).toBe(false);
  });

  test("reads only exact outer HTTP 200 and v3 media type", async () => {
    const fixture = await canonicalFixture();
    const response = new Response(fixture.bytes, {
      status: 200,
      headers: {
        "content-length": String(fixture.bytes.byteLength),
        "content-type": PROVIDER_RESPONSE_V3_CONTENT_TYPE,
      },
    });
    const verified = await readProviderResponseV3(response);
    expect(verified.envelope.provider_response_evidence_sha256).toBe(
      fixture.envelope.provider_response_evidence_sha256,
    );

    for (const invalid of [
      new Response(fixture.bytes, {
        status: 502,
        headers: { "content-type": PROVIDER_RESPONSE_V3_CONTENT_TYPE },
      }),
      new Response(fixture.bytes, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]) {
      await expect(readProviderResponseV3(invalid)).rejects.toMatchObject({
        code: "provider_response_v3_outer_response_invalid",
      });
    }
  });

  test("rejects invalid or dishonest content-length before parsing", async () => {
    const fixture = await canonicalFixture();
    const mismatch = new Response(fixture.bytes, {
      status: 200,
      headers: {
        "content-length": String(fixture.bytes.byteLength + 1),
        "content-type": PROVIDER_RESPONSE_V3_CONTENT_TYPE,
      },
    });
    await expect(readProviderResponseV3(mismatch)).rejects.toMatchObject({
      code: "provider_response_v3_content_length_mismatch",
    });

    const overrun = new Response(fixture.bytes, {
      status: 200,
      headers: {
        "content-length": String(fixture.bytes.byteLength - 1),
        "content-type": PROVIDER_RESPONSE_V3_CONTENT_TYPE,
      },
    });
    await expect(readProviderResponseV3(overrun)).rejects.toMatchObject({
      code: "provider_response_v3_content_length_mismatch",
    });

    const oversized = new Response("{}", {
      status: 200,
      headers: {
        "content-length": String(MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES + 1),
        "content-type": PROVIDER_RESPONSE_V3_CONTENT_TYPE,
      },
    });
    await expect(readProviderResponseV3(oversized)).rejects.toMatchObject({
      code: "provider_response_v3_envelope_too_large",
    });
  });

  test("supports a stricter operational envelope limit without changing the protocol bound", async () => {
    const fixture = await canonicalFixture();
    expect(fixture.bytes.byteLength).toBeLessThan(
      MAX_PROVIDER_RESPONSE_V3_OPERATIONAL_ENVELOPE_BYTES,
    );
    const response = new Response(fixture.bytes, {
      status: 200,
      headers: {
        "content-length": String(fixture.bytes.byteLength),
        "content-type": PROVIDER_RESPONSE_V3_CONTENT_TYPE,
      },
    });

    await expect(
      readProviderResponseV3(response, fixture.bytes.byteLength - 1),
    ).rejects.toMatchObject({ code: "provider_response_v3_envelope_too_large" });
  });
});

describe("provider response v3 fatal encoding and canonical envelope", () => {
  test("rejects empty, oversized, invalid UTF-8, BOM, whitespace, and trailing bytes", async () => {
    const fixture = await canonicalFixture();
    const invalidInputs = [
      new Uint8Array(),
      new Uint8Array(MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES + 1),
      Uint8Array.of(0xff),
      concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), fixture.bytes),
      concatBytes(encoder.encode(" "), fixture.bytes),
      concatBytes(fixture.bytes, encoder.encode("\n")),
      concatBytes(fixture.bytes, encoder.encode("{}")),
    ];
    for (const input of invalidInputs) {
      await expect(parseProviderResponseV3(input)).rejects.toBeDefined();
    }
  });

  test("rejects duplicate keys at every JSON layer through canonical replay", async () => {
    const fixture = await canonicalFixture();
    const text = decoder.decode(fixture.bytes);
    const duplicateOuter = text.replace(
      '{"protocol_version":3,',
      '{"protocol_version":3,"protocol_version":3,',
    );
    const duplicateNested = text.replace(
      `{"operation_id":"${operationId}",`,
      `{"operation_id":"${operationId}","operation_id":"${operationId}",`,
    );
    const duplicateReceipt = text.replace(
      '"usage_receipt":{"schema_version":1,',
      '"usage_receipt":{"schema_version":1,"schema_version":1,',
    );
    for (const attack of [duplicateOuter, duplicateNested, duplicateReceipt]) {
      await expect(parseProviderResponseV3(encoder.encode(attack))).rejects.toMatchObject({
        code: "provider_response_v3_envelope_noncanonical",
      });
    }
  });

  test("rejects unknown, missing, and reordered envelope or nested keys", async () => {
    const fixture = await canonicalFixture();

    const unknown = cloneEnvelope(fixture);
    (unknown as unknown as Record<string, unknown>).unknown = true;

    const missing = cloneEnvelope(fixture);
    delete (missing.raw as unknown as Record<string, unknown>).completed_at;

    const reordered = cloneEnvelope(fixture);
    const reorderedRecord = {
      identity: reordered.identity,
      protocol_version: reordered.protocol_version,
      interpretation: reordered.interpretation,
      raw: reordered.raw,
      client: reordered.client,
      usage_receipt: reordered.usage_receipt,
      provider_response_evidence_sha256: reordered.provider_response_evidence_sha256,
      client_response_artifact_sha256: reordered.client_response_artifact_sha256,
    };

    const nestedReordered = cloneEnvelope(fixture);
    const identity = nestedReordered.identity;
    nestedReordered.identity = {
      owner_generation: identity.owner_generation,
      operation_id: identity.operation_id,
      attempt_generation: identity.attempt_generation,
      provider_operation_id: identity.provider_operation_id,
      request_sha256: identity.request_sha256,
      egress_profile: identity.egress_profile,
      egress_worker_version_id: identity.egress_worker_version_id,
    } as MutableEnvelope["identity"];

    for (const attack of [unknown, missing, reorderedRecord, nestedReordered]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toBeDefined();
    }
  });

  test("rejects wrong types, unsafe integers, negative numbers, and noncanonical numbers", async () => {
    const fixture = await canonicalFixture();
    const wrongType = cloneEnvelope(fixture);
    (wrongType as unknown as Record<string, unknown>).protocol_version = "3";

    const unsafe = cloneEnvelope(fixture);
    unsafe.identity.owner_generation = Number.MAX_SAFE_INTEGER + 1;

    const negative = cloneEnvelope(fixture);
    negative.raw.completed_at = -1;

    for (const attack of [wrongType, unsafe, negative]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toBeDefined();
    }

    const noncanonicalNumber = decoder
      .decode(fixture.bytes)
      .replace('"owner_generation":2', '"owner_generation":2.0');
    await expect(parseProviderResponseV3(encoder.encode(noncanonicalNumber))).rejects.toMatchObject({
      code: "provider_response_v3_envelope_noncanonical",
    });
  });
});

describe("provider response v3 base64url and body integrity", () => {
  test("rejects padding, non-URL alphabet, impossible length, and nonzero pad bits", async () => {
    const fixture = await canonicalFixture({ includeReceipt: false });
    const padding = cloneEnvelope(fixture);
    padding.raw.body_base64 += "=";

    const alphabet = cloneEnvelope(fixture);
    alphabet.raw.body_base64 = `+${alphabet.raw.body_base64.slice(1)}`;

    const impossible = cloneEnvelope(fixture);
    impossible.raw.body_base64 = "A";
    impossible.raw.body_length = 0;

    const oneByte = await canonicalFixture({
      rawBody: Uint8Array.of(0),
      clientBody: encoder.encode("{}"),
      bodySameAsRaw: false,
      includeReceipt: false,
    });
    const noncanonicalReplay = cloneEnvelope(oneByte);
    expect(noncanonicalReplay.raw.body_base64).toBe("AA");
    noncanonicalReplay.raw.body_base64 = "AB";

    for (const attack of [padding, alphabet, impossible, noncanonicalReplay]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toBeDefined();
    }
  });

  test("rejects decoded length, digest, and raw/client bounds mismatches", async () => {
    const fixture = await canonicalFixture({ includeReceipt: false });
    const rawLength = cloneEnvelope(fixture);
    rawLength.raw.body_length += 1;

    const rawDigest = cloneEnvelope(fixture);
    rawDigest.raw.body_sha256 = "0".repeat(64);

    const rawOversize = cloneEnvelope(fixture);
    rawOversize.raw.body_length = MAX_PROVIDER_RESPONSE_V3_BODY_BYTES + 1;

    const clientTooSmall = cloneEnvelope(fixture);
    clientTooSmall.client.body_length = 1;

    for (const attack of [rawLength, rawDigest, rawOversize, clientTooSmall]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toBeDefined();
    }
  });

  test("enforces body_same_as_raw and mandatory independent client body", async () => {
    const deduplicated = await canonicalFixture({ includeReceipt: false });
    const carriesDuplicate = cloneEnvelope(deduplicated);
    carriesDuplicate.client.body_base64 = deduplicated.envelope.raw.body_base64;

    const lengthContradiction = cloneEnvelope(deduplicated);
    lengthContradiction.client.body_length += 1;

    const digestContradiction = cloneEnvelope(deduplicated);
    digestContradiction.client.body_sha256 = "f".repeat(64);

    const independent = await canonicalFixture({
      responseClass: "typed_error",
      includeReceipt: false,
    });
    const missingIndependentBody = cloneEnvelope(independent);
    missingIndependentBody.client.body_base64 = null;

    const corruptIndependentDigest = cloneEnvelope(independent);
    corruptIndependentDigest.client.body_sha256 = "0".repeat(64);

    const redundantIndependentBody = cloneEnvelope(deduplicated);
    redundantIndependentBody.client.body_same_as_raw = false;
    redundantIndependentBody.client.body_base64 = deduplicated.envelope.raw.body_base64;
    await resignEnvelope(redundantIndependentBody);

    for (const attack of [
      carriesDuplicate,
      lengthContradiction,
      digestContradiction,
      missingIndependentBody,
      corruptIndependentDigest,
      redundantIndependentBody,
    ]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toBeDefined();
    }
  });
});

describe("provider response v3 canonical header boundary", () => {
  test("rejects noncanonical, duplicate, unknown, uppercase, reordered, and non-string raw headers", async () => {
    const attacks = [
      '{ "content-type":"application/json"}',
      '{"content-type":"application/json","content-type":"application/json"}',
      '{"authorization":"Bearer secret","content-type":"application/json"}',
      '{"Content-Type":"application/json"}',
      '{"x-request-id":"request-1","content-type":"application/json"}',
      '{"content-type":1}',
    ];
    for (const headersJson of attacks) {
      const fixture = await canonicalFixture({ includeReceipt: false });
      await setHeadersJson(fixture.envelope, "raw", headersJson);
      await expect(parseProviderResponseV3(jsonBytes(fixture.envelope))).rejects.toBeDefined();
    }
  });

  test("checks exact header UTF-8 length and SHA-256", async () => {
    const fixture = await canonicalFixture({ includeReceipt: false });
    const badLength = cloneEnvelope(fixture);
    badLength.raw.headers_length += 1;
    const badHash = cloneEnvelope(fixture);
    badHash.client.headers_sha256 = "0".repeat(64);
    await expect(parseProviderResponseV3(jsonBytes(badLength))).rejects.toBeDefined();
    await expect(parseProviderResponseV3(jsonBytes(badHash))).rejects.toBeDefined();
  });

  test("rejects unsafe header values and malformed media types", async () => {
    const attacks = [
      '{"content-type":"application json"}',
      '{"content-type":" application/json"}',
      '{"content-type":"application/json;"}',
      '{"content-language":"","content-type":"application/json"}',
      `{"content-language":"${"x".repeat(1_025)}","content-type":"application/json"}`,
      '{"content-language":"\u00e9","content-type":"application/json"}',
      '{"content-language":"line\\nbreak","content-type":"application/json"}',
      '{"content-type":"application/json","x-request-id":"unsafe request id"}',
    ];
    for (const headersJson of attacks) {
      const fixture = await canonicalFixture({ includeReceipt: false });
      await setHeadersJson(fixture.envelope, "raw", headersJson);
      await expect(parseProviderResponseV3(jsonBytes(fixture.envelope))).rejects.toBeDefined();
    }
  });

  test("derives provider_request_id from x, OpenAI, then generic request id", async () => {
    const fixture = await canonicalFixture({
      includeReceipt: false,
      rawHeaders: {
        "content-type": "application/json",
        "openai-request-id": "openai-id",
        "request-id": "generic-id",
        "x-request-id": "x-id",
      },
    });
    fixture.envelope.raw.provider_request_id = "openai-id";
    await resignEnvelope(fixture.envelope);
    await expect(parseProviderResponseV3(jsonBytes(fixture.envelope))).rejects.toMatchObject({
      code: "provider_response_v3_provider_request_id_contradiction",
    });
  });

  test("requires raw content-type iff observed and exact", async () => {
    const fixture = await canonicalFixture({ includeReceipt: false });
    const absent = cloneEnvelope(fixture);
      await setHeadersJson(
      absent,
      "raw",
      `{"x-request-id":"${providerRequestId}"}`,
    );

    const synthesized = cloneEnvelope(fixture);
    synthesized.raw.content_type = null;
    await resignEnvelope(synthesized);

    for (const attack of [absent, synthesized]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toMatchObject({
        code: "provider_response_v3_raw_content_type_contradiction",
      });
    }
  });

  test("requires exact success projection and exact two-header error artifact", async () => {
    const success = await canonicalFixture({ includeReceipt: false });
    await setHeadersJson(
      success.envelope,
      "client",
      '{"cache-control":"no-store","content-type":"application/json"}',
    );

    const typed = await canonicalFixture({
      responseClass: "typed_error",
      includeReceipt: false,
    });
    await setHeadersJson(
      typed.envelope,
      "client",
      '{"cache-control":"no-store","content-language":"en","content-type":"application/json"}',
    );

    for (const attack of [success.envelope, typed.envelope]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toMatchObject({
        code: "provider_response_v3_client_headers_contradiction",
      });
    }
  });
});

describe("provider response v3 classification matrix", () => {
  const acceptedScenarios: ReadonlyArray<{
    name: string;
    options: FixtureOptions;
    expectedClass: ProviderResponseClassV3;
  }> = [
    {
      name: "exact ordinary 200",
      options: { responseClass: "success", includeReceipt: false },
      expectedClass: "success",
    },
    {
      name: "typed HTTP 200",
      options: {
        responseClass: "typed_error",
        rawBody: encoder.encode('{"error":{"type":"rate_limit_error"}}'),
        includeReceipt: false,
      },
      expectedClass: "typed_error",
    },
    ...[201, 202, 204, 206, 300, 400, 500].map((status) => ({
      name: `HTTP error ${status}`,
      options: {
        responseClass: "http_error" as const,
        providerStatus: status,
        rawBody: status === 204 ? new Uint8Array() : encoder.encode("{}"),
        includeReceipt: false,
      },
      expectedClass: "http_error" as const,
    })),
    ...[
      ["malformed", encoder.encode("{")],
      ["scalar", encoder.encode("1")],
      ["array", encoder.encode("[]")],
      ["empty", new Uint8Array()],
      ["invalid UTF-8", Uint8Array.of(0xff)],
    ].map(([name, rawBody]) => ({
      name: `invalid body ${name as string}`,
      options: {
        responseClass: "invalid_body" as const,
        rawBody: rawBody as Uint8Array,
        includeReceipt: false,
      },
      expectedClass: "invalid_body" as const,
    })),
  ];

  for (const scenario of acceptedScenarios) {
    test(`accepts Rust-asserted ${scenario.name}`, async () => {
      const fixture = await canonicalFixture(scenario.options);
      const verified = await parseProviderResponseV3(fixture.bytes);
      expect(verified.envelope.interpretation.response_class).toBe(
        scenario.expectedClass,
      );
      expect(verified.raw_body).toEqual(fixture.rawBody);
      expect(verified.client_body).toEqual(fixture.clientBody);
    });
  }

  test("rejects contradictions across all four classes, including provider 202 as success", async () => {
    const attacks: FixtureOptions[] = [
      {
        responseClass: "success",
        providerStatus: 202,
        clientStatus: 202,
        auditStatus: 500,
        includeReceipt: false,
      },
      {
        responseClass: "typed_error",
        auditStatus: 200,
        includeReceipt: false,
      },
      { responseClass: "typed_error", includeReceipt: true },
      {
        responseClass: "http_error",
        providerStatus: 200,
        clientStatus: 200,
        auditStatus: 500,
        includeReceipt: false,
      },
      {
        responseClass: "http_error",
        providerStatus: 202,
        clientStatus: 201,
        auditStatus: 500,
        includeReceipt: false,
      },
      {
        responseClass: "http_error",
        providerStatus: 202,
        clientStatus: 202,
        auditStatus: 202,
        includeReceipt: false,
      },
      {
        responseClass: "invalid_body",
        clientStatus: 200,
        includeReceipt: false,
      },
      {
        responseClass: "invalid_body",
        auditStatus: 200,
        includeReceipt: false,
      },
    ];
    for (const options of attacks) {
      const fixture = await canonicalFixture(options);
      await expect(parseProviderResponseV3(fixture.bytes)).rejects.toMatchObject({
        code: "provider_response_v3_classification_contradiction",
      });
    }
  });

  test("does not reinterpret provider body semantics in TypeScript", async () => {
    const assertedSuccess = await canonicalFixture({
      responseClass: "success",
      rawBody: encoder.encode('{"error":{"type":"provider_claim"}}'),
      includeReceipt: false,
    });
    const assertedInvalid = await canonicalFixture({
      responseClass: "invalid_body",
      rawBody: encoder.encode('{"id":"syntactically-valid-object"}'),
      includeReceipt: false,
    });
    await expect(parseProviderResponseV3(assertedSuccess.bytes)).resolves.toBeDefined();
    await expect(parseProviderResponseV3(assertedInvalid.bytes)).resolves.toBeDefined();
  });
});

describe("provider response v3 usage receipt", () => {
  test("accepts an exact matching success receipt and optional null", async () => {
    const withReceipt = await canonicalFixture({ includeReceipt: true });
    const withoutReceipt = await canonicalFixture({ includeReceipt: false });
    const first = await parseProviderResponseV3(withReceipt.bytes);
    const second = await parseProviderResponseV3(withoutReceipt.bytes);
    expect(first.usage_receipt_sha256).toBe(withReceipt.usageReceiptSha256);
    expect(second.usage_receipt_json).toBeNull();
    expect(second.usage_receipt_sha256).toBeNull();
  });

  test("rejects unknown, missing, reordered, or internally contradictory receipt fields", async () => {
    const fixture = await canonicalFixture({ includeReceipt: true });
    const receipt = requireReceipt(fixture.envelope);

    const unknown = cloneEnvelope(fixture);
    (requireReceipt(unknown) as unknown as Record<string, unknown>).unknown = true;

    const missing = cloneEnvelope(fixture);
    delete (requireReceipt(missing) as unknown as Record<string, unknown>).estimated;

    const reordered = cloneEnvelope(fixture);
    reordered.usage_receipt = {
      parser_contract: receipt.parser_contract,
      schema_version: receipt.schema_version,
      ...Object.fromEntries(
        Object.entries(receipt).filter(
          ([key]) => key !== "parser_contract" && key !== "schema_version",
        ),
      ),
    } as unknown as MutableEnvelope["usage_receipt"];

    const contradictoryMask = cloneEnvelope(fixture);
    requireReceipt(contradictoryMask).reported_usage_fields = 0;

    for (const attack of [unknown, missing, reordered, contradictoryMask]) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toMatchObject({
        code: "provider_response_v3_usage_receipt_invalid",
      });
    }
  });

  test("binds receipt identity, status, body, request id, and completion time exactly", async () => {
    const fixture = await canonicalFixture({ includeReceipt: true });
    const attacks = [
      cloneEnvelope(fixture),
      cloneEnvelope(fixture),
      cloneEnvelope(fixture),
      cloneEnvelope(fixture),
      cloneEnvelope(fixture),
    ];
    requireReceipt(attacks[0]!).operation_id = "operation-2";
    requireReceipt(attacks[1]!).provider_response_status = 201;
    requireReceipt(attacks[2]!).provider_response_sha256 = "f".repeat(64);
    requireReceipt(attacks[3]!).provider_request_id = "request-2";
    requireReceipt(attacks[4]!).provider_completed_at += 1;

    for (const attack of attacks) {
      await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toMatchObject({
        code: "provider_response_v3_usage_receipt_contradiction",
      });
    }
  });
});

describe("provider response v3 attestation digests", () => {
  test("recomputes and rejects either attestation independently", async () => {
    const fixture = await canonicalFixture({ includeReceipt: false });
    const provider = cloneEnvelope(fixture);
    provider.provider_response_evidence_sha256 = "0".repeat(64);
    await expect(parseProviderResponseV3(jsonBytes(provider))).rejects.toMatchObject({
      code: "provider_response_v3_provider_attestation_mismatch",
    });

    const client = cloneEnvelope(fixture);
    client.client_response_artifact_sha256 = "0".repeat(64);
    await expect(parseProviderResponseV3(jsonBytes(client))).rejects.toMatchObject({
      code: "provider_response_v3_client_attestation_mismatch",
    });
  });

  test("detects attested metadata tampering even when bodies still hash", async () => {
    const fixture = await canonicalFixture({ includeReceipt: false });
    const attack = cloneEnvelope(fixture);
    attack.raw.completed_at += 1;
    await expect(parseProviderResponseV3(jsonBytes(attack))).rejects.toMatchObject({
      code: "provider_response_v3_provider_attestation_mismatch",
    });
  });
});

async function canonicalFixture(options: FixtureOptions = {}): Promise<CanonicalFixture> {
  const responseClass = options.responseClass ?? "success";
  const providerStatus = options.providerStatus ?? defaultProviderStatus(responseClass);
  const clientStatus = options.clientStatus ?? defaultClientStatus(responseClass, providerStatus);
  const auditStatus = options.auditStatus ?? defaultAuditStatus(responseClass, providerStatus);
  const rawBody = options.rawBody ?? encoder.encode(
    '{"id":"chatcmpl-1","usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}',
  );
  const clientBody = options.clientBody ?? (responseClass === "success" ? rawBody : errorBody);
  const bodySameAsRaw = options.bodySameAsRaw ?? bytesEqual(rawBody, clientBody);
  const rawHeaders = options.rawHeaders ?? {
    "content-type": "application/json",
    "x-request-id": providerRequestId,
  };
  const observedProviderRequestId = rawHeaders["x-request-id"] ??
    rawHeaders["openai-request-id"] ?? rawHeaders["request-id"] ?? null;
  const rawContentType = Object.prototype.hasOwnProperty.call(options, "rawContentType")
    ? options.rawContentType!
    : rawHeaders["content-type"] ?? null;
  const rawHeadersJson = canonicalHeadersJson(rawHeaders);
  const clientHeaders = responseClass === "success"
    ? Object.fromEntries(
      Object.entries({
        ...rawHeaders,
        "cache-control": "no-store",
        "content-type": "application/json",
      }).sort(([left], [right]) => left.localeCompare(right, "en-US")),
    ) as Record<string, string>
    : {
      "cache-control": "no-store",
      "content-type": "application/json",
    };
  const clientHeadersJson = canonicalHeadersJson(clientHeaders);
  const rawBodySha256 = await sha256Hex(rawBody);
  const clientBodySha256 = await sha256Hex(clientBody);

  const identity = {
    operation_id: operationId,
    owner_generation: 2,
    attempt_generation: 1,
    provider_operation_id: providerOperationId,
    request_sha256: requestSha256,
    egress_profile: PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
    egress_worker_version_id: workerVersionId,
  } as const;
  const interpretation = {
    contract: PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
    source_commit: PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
    response_class: responseClass,
    provider_status: providerStatus,
    client_status: clientStatus,
    audit_status: auditStatus,
  } as const;
  const includeReceipt = options.includeReceipt ?? responseClass === "success";
  const usageReceipt = includeReceipt
    ? providerUsageReceipt(providerStatus, rawBodySha256, observedProviderRequestId)
    : null;

  const envelope: MutableEnvelope = {
    protocol_version: 3,
    identity: { ...identity },
    interpretation: { ...interpretation },
    raw: {
      content_type: rawContentType,
      headers_json: rawHeadersJson,
      headers_length: encoder.encode(rawHeadersJson).byteLength,
      headers_sha256: await sha256Hex(encoder.encode(rawHeadersJson)),
      body_length: rawBody.byteLength,
      body_sha256: rawBodySha256,
      body_base64: base64UrlNoPad(rawBody),
      provider_request_id: observedProviderRequestId,
      completed_at: completedAt,
    },
    client: {
      content_type: "application/json",
      headers_json: clientHeadersJson,
      headers_length: encoder.encode(clientHeadersJson).byteLength,
      headers_sha256: await sha256Hex(encoder.encode(clientHeadersJson)),
      body_length: clientBody.byteLength,
      body_sha256: clientBodySha256,
      body_same_as_raw: bodySameAsRaw,
      body_base64: bodySameAsRaw ? null : base64UrlNoPad(clientBody),
    },
    usage_receipt: usageReceipt as MutableEnvelope["usage_receipt"],
    provider_response_evidence_sha256: "0".repeat(64),
    client_response_artifact_sha256: "0".repeat(64),
  };
  const usageReceiptSha256 = await resignEnvelope(envelope);
  return {
    envelope,
    bytes: jsonBytes(envelope),
    rawBody,
    clientBody,
    usageReceiptSha256,
  };
}

async function localSharedVector(): Promise<ProviderResponseV3SharedVector> {
  const fixture = await canonicalFixture();
  return {
    name: "exact_200",
    envelope_bytes: fixture.bytes,
    envelope_length: fixture.bytes.byteLength,
    canonical_envelope_sha256: await sha256Hex(fixture.bytes),
    raw_body_sha256: fixture.envelope.raw.body_sha256,
    client_body_sha256: fixture.envelope.client.body_sha256,
    usage_receipt_sha256: fixture.usageReceiptSha256,
    provider_response_evidence_sha256:
      fixture.envelope.provider_response_evidence_sha256,
    client_response_artifact_sha256:
      fixture.envelope.client_response_artifact_sha256,
  };
}

function providerUsageReceipt(
  providerStatus: number,
  rawBodySha256: string,
  observedProviderRequestId: string | null,
): ProviderUsageReceipt {
  return {
    schema_version: 1,
    parser_contract: "openai-chat-completions-usage-v1",
    normalization_contract: "billing-token-normalization-v1",
    source: "provider_response",
    estimated: false,
    operation_id: operationId,
    owner_generation: 2,
    attempt_generation: 1,
    provider_operation_id: providerOperationId,
    request_sha256: requestSha256,
    egress_profile: PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
    egress_worker_version_id: workerVersionId,
    provider_response_status: providerStatus,
    provider_response_sha256: rawBodySha256,
    provider_request_id: observedProviderRequestId,
    provider_completed_at: completedAt,
    usage_present: true,
    reported_usage_fields: 7,
    prompt_tokens: 7,
    completion_tokens: 5,
    total_tokens: 12,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    cache_creation_tokens_5m: 0,
    cache_creation_tokens_1h: 0,
    image_input_tokens: 0,
    image_output_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
    is_anthropic_usage_semantic: false,
    usage_semantic_source: "openai_default",
    provider_cost_usd: null,
    cache_creation_source: "none",
    responses_web_search_calls: 0,
    responses_file_search_calls: 0,
    claude_web_search_calls: 0,
    image_generation_quality: null,
    image_generation_size: null,
  };
}

async function resignEnvelope(envelope: MutableEnvelope): Promise<string | null> {
  const receiptJson = envelope.usage_receipt === null
    ? null
    : JSON.stringify(envelope.usage_receipt);
  const receiptSha256 = receiptJson === null
    ? null
    : await sha256Hex(encoder.encode(receiptJson));
  envelope.provider_response_evidence_sha256 = await sha256Hex(
    encoder.encode(JSON.stringify({
      contract: "cinatoken-provider-evidence-attestation-v1",
      identity: envelope.identity,
      interpretation: envelope.interpretation,
      raw: {
        content_type: envelope.raw.content_type,
        headers_length: envelope.raw.headers_length,
        headers_sha256: envelope.raw.headers_sha256,
        body_length: envelope.raw.body_length,
        body_sha256: envelope.raw.body_sha256,
        provider_request_id: envelope.raw.provider_request_id,
        completed_at: envelope.raw.completed_at,
      },
    })),
  );
  envelope.client_response_artifact_sha256 = await sha256Hex(
    encoder.encode(JSON.stringify({
      contract: "cinatoken-client-response-attestation-v1",
      identity: envelope.identity,
      provider_response_evidence_sha256:
        envelope.provider_response_evidence_sha256,
      interpretation: envelope.interpretation,
      client: {
        content_type: envelope.client.content_type,
        headers_length: envelope.client.headers_length,
        headers_sha256: envelope.client.headers_sha256,
        body_length: envelope.client.body_length,
        body_sha256: envelope.client.body_sha256,
        body_same_as_raw: envelope.client.body_same_as_raw,
      },
      usage_receipt_sha256: receiptSha256,
    })),
  );
  return receiptSha256;
}

async function setHeadersJson(
  envelope: MutableEnvelope,
  target: "raw" | "client",
  json: string,
): Promise<void> {
  const headers = envelope[target];
  headers.headers_json = json;
  headers.headers_length = encoder.encode(json).byteLength;
  headers.headers_sha256 = await sha256Hex(encoder.encode(json));
  await resignEnvelope(envelope);
}

function requireReceipt(envelope: MutableEnvelope): Mutable<ProviderUsageReceipt> {
  if (envelope.usage_receipt === null) throw new Error("fixture receipt missing");
  return envelope.usage_receipt;
}

function cloneEnvelope(fixture: CanonicalFixture): MutableEnvelope {
  return JSON.parse(decoder.decode(fixture.bytes)) as MutableEnvelope;
}

function canonicalHeadersJson(headers: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(headers).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}

function defaultProviderStatus(responseClass: ProviderResponseClassV3): number {
  return responseClass === "http_error" ? 500 : 200;
}

function defaultClientStatus(
  responseClass: ProviderResponseClassV3,
  providerStatus: number,
): number {
  return responseClass === "invalid_body" ? 500 : providerStatus;
}

function defaultAuditStatus(
  responseClass: ProviderResponseClassV3,
  providerStatus: number,
): number {
  if (responseClass === "success") return 200;
  if (responseClass === "http_error" && providerStatus >= 400) return providerStatus;
  return 500;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}
