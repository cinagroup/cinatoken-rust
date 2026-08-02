import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  parseOperationEnvelope,
  ProtocolError,
} from "../services/container-controller/src/protocol.ts";
import { parseContainerOperationHttpResponse } from "../services/container-controller/src/operation_outcome.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const vectors = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts",
      "container-runtime",
      "v1",
      "conformance",
      "operation-envelope-cases.json",
    ),
    "utf8",
  ),
);
const responseVectors = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "contracts",
      "container-runtime",
      "v1",
      "conformance",
      "operation-response-cases.json",
    ),
    "utf8",
  ),
);
const encoder = new TextEncoder();
const environment = {
  CONTAINER_PROTOCOL_VERSION: "1",
  CONTAINER_RING_GENERATION: "7",
  CONTAINER_SHARD_COUNT: "8",
  CONTAINER_PREVIOUS_RING_GENERATION: "0",
  CONTAINER_PREVIOUS_SHARD_COUNT: "0",
  CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: "0",
  CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: "0",
};

describe("container runtime v1 shared operation envelope vectors", () => {
  test("the vector suite is versioned and has unique names", () => {
    expect(vectors.schema_version).toBe(1);
    expect(Number.isSafeInteger(vectors.now)).toBe(true);
    expect(new Set(vectors.cases.map((entry) => entry.name)).size).toBe(
      vectors.cases.length,
    );
  });

  for (const conformanceCase of vectors.cases) {
    test(conformanceCase.name, () => {
      const parse = () =>
        parseOperationEnvelope(
          encoder.encode(JSON.stringify(conformanceCase.envelope)),
          environment,
          vectors.now,
        );

      if (conformanceCase.valid) {
        expect(parse().protocol_version).toBe(1);
      } else {
        expect(parse).toThrow(ProtocolError);
      }
    });
  }
});

describe("container runtime v1 shared operation response vectors", () => {
  test("the vector suite is versioned and has unique names", () => {
    expect(responseVectors.schema_version).toBe(1);
    expect(new Set(responseVectors.cases.map((entry) => entry.name)).size).toBe(
      responseVectors.cases.length,
    );
  });

  for (const conformanceCase of responseVectors.cases) {
    test(conformanceCase.name, () => {
      const body = encoder.encode(JSON.stringify(conformanceCase.body));
      const response = new Response(null, {
        status: conformanceCase.http_status,
        headers: { "content-type": conformanceCase.content_type },
      });
      const envelope = {
        ...responseVectors.envelope,
        operation_kind: conformanceCase.operation_kind,
      };

      let result;
      let error;
      try {
        result = parseContainerOperationHttpResponse(response, body, envelope);
      } catch (caught) {
        error = caught;
      }

      expect(error === undefined).toBe(conformanceCase.accepted);
      if (conformanceCase.accepted) {
        expect(result?.kind).toBe(conformanceCase.expected_kind);
      } else {
        expect(error).toBeInstanceOf(ProtocolError);
      }
    });
  }
});
