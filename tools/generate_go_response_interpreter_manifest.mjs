import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dir, "..");
const GENERATOR_SCRIPT = resolve(
  ROOT,
  "tools",
  "generate_go_response_interpreter_manifest.mjs",
);
const DEFAULT_SOURCE = resolve(ROOT, "..", "cinatoken");
const DEFAULT_OUTPUT = resolve(
  ROOT,
  "crates",
  "relay",
  "tests",
  "fixtures",
  "response_interpreter_go_manifest.json",
);
const PINNED_COMMIT = "73652508abc5cb09214dde02d51d69d1d1ccc703";
const MARKER = "CINATOKEN_RESPONSE_INTERPRETER_MANIFEST_JSON=";
const GO_TEST_NAME = "TestGenerateCinaTokenResponseInterpreterManifest";
const GO_TEST_TARGET = [
  "relay",
  "channel",
  "openai",
  "zz_cinatoken_response_interpreter_manifest_test.go",
];
const GO_TEST_TEMPLATE_NAME =
  "embedded_go_response_interpreter_manifest_test.go";
const SOURCE_ROOTS = ["relay", "dto", "service", "types"];
const SOURCE_FILES = [
  "relay/compatible_handler.go",
  "relay/channel/openai/relay-openai.go",
  "dto/openai_response.go",
  "dto/error.go",
  "service/error.go",
  "service/http.go",
  "types/error.go",
];
const EXPECTED_CASE_COUNT = 27;
const EXPECTED_CLASS_COUNTS = {
  success: 4,
  typed_error: 3,
  invalid_body: 3,
  http_error: 17,
};
const REQUIRED_STATUSES = [
  200, 201, 202, 204, 300, 302, 399, 400, 401, 404, 409, 422, 429, 500,
  502, 503, 599,
];
const HEADER_NAMES = [
  "Content-Type",
  "content-language",
  "Retry-After",
  "X-Request-ID",
  "request-id",
  "OpenAI-Request-ID",
  "Content-Length",
  "X-Oneapi-Request-Id",
  "Set-Cookie",
  "Authorization",
  "Transfer-Encoding",
];
const PUBLIC_SAFE_HEADERS = new Set([
  "content-type",
  "content-language",
  "retry-after",
  "x-request-id",
  "request-id",
  "openai-request-id",
]);
const SOURCE_REJECTED_HEADERS = new Set([
  "content-length",
  "x-oneapi-request-id",
]);

const GO_TEST_TEMPLATE = `package openai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/cinagroup/cinatoken/dto"
	"github.com/cinagroup/cinatoken/service"
)

const responseInterpreterManifestMarker = "CINATOKEN_RESPONSE_INTERPRETER_MANIFEST_JSON="

type responseManifestSeed struct {
	Name   string
	Status int
	Body   string
}

type responseManifestHeaderDecision struct {
	Name           string \`json:"name"\`
	SourceEligible bool   \`json:"source_eligible"\`
	PublicForward  bool   \`json:"public_forward"\`
}

type responseManifestError struct {
	Message  string \`json:"message"\`
	Type     string \`json:"type"\`
	Param    string \`json:"param"\`
	Code     any    \`json:"code"\`
	Metadata any    \`json:"metadata"\`
}

type responseManifestUsage struct {
	PromptTokens                 int     \`json:"prompt_tokens"\`
	CompletionTokens             int     \`json:"completion_tokens"\`
	TotalTokens                  int     \`json:"total_tokens"\`
	CachedTokens                 int     \`json:"cached_tokens"\`
	CacheCreationTokens          int     \`json:"cache_creation_tokens"\`
	ClaudeCacheCreation5mTokens  int     \`json:"claude_cache_creation_5m_tokens"\`
	ClaudeCacheCreation1hTokens  int     \`json:"claude_cache_creation_1h_tokens"\`
	ImageInputTokens             int     \`json:"image_input_tokens"\`
	ImageOutputTokens            int     \`json:"image_output_tokens"\`
	AudioInputTokens             int     \`json:"audio_input_tokens"\`
	AudioOutputTokens            int     \`json:"audio_output_tokens"\`
	AnthropicUsageSemantic       bool    \`json:"is_anthropic_usage_semantic"\`
	UsageSemanticSource          string  \`json:"usage_semantic_source"\`
	ProviderCostUSD              *string \`json:"provider_cost_usd"\`
	CacheCreationSource          string  \`json:"cache_creation_source"\`
	ResponsesWebSearchCalls      int     \`json:"responses_web_search_calls"\`
	ResponsesFileSearchCalls     int     \`json:"responses_file_search_calls"\`
	ClaudeWebSearchCalls         int     \`json:"claude_web_search_calls"\`
	ImageGenerationPresent      bool    \`json:"image_generation_present"\`
}

type responseManifestExpected struct {
	Class           string                           \`json:"class"\`
	UpstreamStatus  int                              \`json:"upstream_status"\`
	ClientStatus    int                              \`json:"client_status"\`
	AuditStatus     int                              \`json:"audit_status"\`
	Success         bool                             \`json:"success"\`
	HasJSONObject   bool                             \`json:"has_json_object"\`
	BodySHA256      string                           \`json:"body_sha256"\`
	Error            *responseManifestError           \`json:"error"\`
	Usage            responseManifestUsage            \`json:"usage"\`
	HeaderDecisions []responseManifestHeaderDecision \`json:"header_decisions"\`
}

type responseManifestCase struct {
	Name     string                   \`json:"name"\`
	Status   int                      \`json:"status"\`
	Body     string                   \`json:"body"\`
	Expected responseManifestExpected \`json:"expected"\`
}

var responseManifestHeaderNames = []string{
	"Content-Type",
	"content-language",
	"Retry-After",
	"X-Request-ID",
	"request-id",
	"OpenAI-Request-ID",
	"Content-Length",
	"X-Oneapi-Request-Id",
	"Set-Cookie",
	"Authorization",
	"Transfer-Encoding",
}

var responseManifestPublicSafeHeaders = map[string]bool{
	"content-type":       true,
	"content-language":   true,
	"retry-after":        true,
	"x-request-id":       true,
	"request-id":         true,
	"openai-request-id":  true,
}

func responseManifestBodyHash(body string) string {
	digest := sha256.Sum256([]byte(body))
	return hex.EncodeToString(digest[:])
}

func responseManifestJSONObject(body string) bool {
	var object map[string]any
	return json.Unmarshal([]byte(body), &object) == nil && object != nil
}

func responseManifestRawValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func responseManifestCost(value any) *string {
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	text := string(encoded)
	return &text
}

func responseManifestUsageFromGo(usage dto.Usage) responseManifestUsage {
	semanticSource := "openai_default"
	if usage.UsageSemantic != "" {
		semanticSource = "upstream_explicit"
	}
	cacheCreationSource := "none"
	if usage.PromptTokensDetails.CachedCreationTokens > 0 {
		cacheCreationSource = "upstream_aggregate"
	} else if usage.ClaudeCacheCreation5mTokens > 0 || usage.ClaudeCacheCreation1hTokens > 0 {
		cacheCreationSource = "upstream_split"
	}
	return responseManifestUsage{
		PromptTokens:                usage.PromptTokens,
		CompletionTokens:            usage.CompletionTokens,
		TotalTokens:                 usage.TotalTokens,
		CachedTokens:                usage.PromptTokensDetails.CachedTokens,
		CacheCreationTokens:         usage.PromptTokensDetails.CachedCreationTokens,
		ClaudeCacheCreation5mTokens: usage.ClaudeCacheCreation5mTokens,
		ClaudeCacheCreation1hTokens: usage.ClaudeCacheCreation1hTokens,
		ImageInputTokens:            usage.PromptTokensDetails.ImageTokens,
		ImageOutputTokens:           usage.CompletionTokenDetails.ImageTokens,
		AudioInputTokens:            usage.PromptTokensDetails.AudioTokens,
		AudioOutputTokens:           usage.CompletionTokenDetails.AudioTokens,
		AnthropicUsageSemantic:      strings.EqualFold(usage.UsageSemantic, "anthropic"),
		UsageSemanticSource:         semanticSource,
		ProviderCostUSD:             responseManifestCost(usage.Cost),
		CacheCreationSource:         cacheCreationSource,
	}
}

func responseManifestHeaderDecisions(class string) []responseManifestHeaderDecision {
	decisions := make([]responseManifestHeaderDecision, 0, len(responseManifestHeaderNames))
	for _, name := range responseManifestHeaderNames {
		sourceEligible := service.ShouldCopyUpstreamHeader(nil, name, []string{"fixture"})
		publicForward := class == "success" && sourceEligible && responseManifestPublicSafeHeaders[strings.ToLower(name)]
		decisions = append(decisions, responseManifestHeaderDecision{
			Name:           name,
			SourceEligible: sourceEligible,
			PublicForward:  publicForward,
		})
	}
	return decisions
}

func responseManifestErrorFromGo(message string, kind string, param string, code any, metadata json.RawMessage) *responseManifestError {
	return &responseManifestError{
		Message:  message,
		Type:     kind,
		Param:    param,
		Code:     code,
		Metadata: responseManifestRawValue(metadata),
	}
}

func responseManifestInterpret(seed responseManifestSeed) responseManifestCase {
	expected := responseManifestExpected{
		UpstreamStatus: seed.Status,
		ClientStatus:   seed.Status,
		AuditStatus:    seed.Status,
		BodySHA256:     responseManifestBodyHash(seed.Body),
		HasJSONObject:  responseManifestJSONObject(seed.Body),
		Usage:          responseManifestUsageFromGo(dto.Usage{}),
	}

	if seed.Status != http.StatusOK {
		expected.Class = "http_error"
		if seed.Status < http.StatusBadRequest {
			expected.AuditStatus = http.StatusInternalServerError
		}
		response := &http.Response{
			StatusCode: seed.Status,
			Body:       io.NopCloser(strings.NewReader(seed.Body)),
		}
		apiError := service.RelayErrorHandler(context.Background(), response, false)
		openAIError := apiError.ToOpenAIError()
		message := apiError.Error()
		if message == "" {
			message = fmt.Sprintf("bad response status code %d", seed.Status)
		}
		expected.Error = responseManifestErrorFromGo(
			message,
			openAIError.Type,
			openAIError.Param,
			openAIError.Code,
			openAIError.Metadata,
		)
		expected.HeaderDecisions = responseManifestHeaderDecisions(expected.Class)
		return responseManifestCase{Name: seed.Name, Status: seed.Status, Body: seed.Body, Expected: expected}
	}

	var parsed dto.OpenAITextResponse
	if err := json.Unmarshal([]byte(seed.Body), &parsed); err != nil {
		expected.Class = "invalid_body"
		expected.ClientStatus = http.StatusInternalServerError
		expected.AuditStatus = http.StatusInternalServerError
		expected.Error = &responseManifestError{
			Message: "invalid upstream JSON response",
			Type:    "bad_response_body",
			Param:   "",
			Code:    "bad_response_body",
		}
		expected.HeaderDecisions = responseManifestHeaderDecisions(expected.Class)
		return responseManifestCase{Name: seed.Name, Status: seed.Status, Body: seed.Body, Expected: expected}
	}

	if openAIError := parsed.GetOpenAIError(); openAIError != nil && openAIError.Type != "" {
		expected.Class = "typed_error"
		expected.AuditStatus = http.StatusInternalServerError
		expected.Error = responseManifestErrorFromGo(
			openAIError.Message,
			openAIError.Type,
			openAIError.Param,
			openAIError.Code,
			openAIError.Metadata,
		)
		expected.HeaderDecisions = responseManifestHeaderDecisions(expected.Class)
		return responseManifestCase{Name: seed.Name, Status: seed.Status, Body: seed.Body, Expected: expected}
	}

	expected.Class = "success"
	expected.Success = true
	expected.Usage = responseManifestUsageFromGo(parsed.Usage)
	expected.HeaderDecisions = responseManifestHeaderDecisions(expected.Class)
	return responseManifestCase{Name: seed.Name, Status: seed.Status, Body: seed.Body, Expected: expected}
}

func TestGenerateCinaTokenResponseInterpreterManifest(t *testing.T) {
	if os.Getenv("CINATOKEN_RESPONSE_INTERPRETER_MANIFEST") != "1" {
		t.Skip("manifest generator only")
	}

	seeds := []responseManifestSeed{
		{
			Name:   "buffered_success_usage",
			Status: 200,
			Body: \`{"id":"chatcmpl-usage","usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":3,"cached_creation_tokens":2,"image_tokens":4,"audio_tokens":5},"completion_tokens_details":{"image_tokens":6,"audio_tokens":7},"claude_cache_creation_5_m_tokens":8,"claude_cache_creation_1_h_tokens":9,"usage_semantic":"anthropic","cost":0.0125}}\`,
		},
		{Name: "buffered_success_no_usage", Status: 200, Body: \`{"id":"chatcmpl-empty","choices":[]}\`},
		{Name: "buffered_success_message_only_error", Status: 200, Body: \`{"error":{"message":"not typed","code":"ignored"},"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\`},
		{Name: "buffered_success_null_error", Status: 200, Body: \`{"error":null,"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\`},
		{Name: "buffered_typed_error_object", Status: 200, Body: \`{"error":{"message":"rate limited","type":"rate_limit_error","param":"model","code":429},"usage":{"prompt_tokens":99,"completion_tokens":1,"total_tokens":100}}\`},
		{Name: "buffered_typed_error_string", Status: 200, Body: \`{"error":"provider failed"}\`},
		{Name: "buffered_typed_error_type_only", Status: 200, Body: \`{"error":{"type":"provider_error","code":"typed_without_message"}}\`},
		{Name: "buffered_invalid_empty", Status: 200, Body: ""},
		{Name: "buffered_invalid_malformed", Status: 200, Body: "{"},
		{Name: "buffered_invalid_array", Status: 200, Body: \`[{"id":"not-an-object-envelope"}]\`},
		{Name: "status_201_is_http_error", Status: 201, Body: \`{"id":"created"}\`},
		{Name: "status_202_is_http_error", Status: 202, Body: \`{"id":"accepted","usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\`},
		{Name: "status_204_is_http_error", Status: 204, Body: ""},
		{Name: "status_300_message", Status: 300, Body: \`{"message":"choose another endpoint"}\`},
		{Name: "status_302_error_string", Status: 302, Body: \`{"error":"redirect denied","message":"ignored"}\`},
		{Name: "status_399_detail", Status: 399, Body: \`{"detail":"redirect boundary"}\`},
		{Name: "status_400_openai_error_precedence", Status: 400, Body: \`{"error":{"message":"structured wins","type":"invalid_request_error","param":"model","code":"bad_model"},"message":"message ignored","msg":"msg ignored","detail":"detail ignored"}\`},
		{Name: "status_401_message_precedence", Status: 401, Body: \`{"message":"message wins","msg":"msg ignored","err":"err ignored","error_msg":"error_msg ignored","detail":"detail ignored"}\`},
		{Name: "status_404_msg_precedence", Status: 404, Body: \`{"msg":"msg wins","err":"err ignored","error_msg":"error_msg ignored","detail":"detail ignored"}\`},
		{Name: "status_409_err_precedence", Status: 409, Body: \`{"err":"err wins","error_msg":"error_msg ignored","detail":"detail ignored"}\`},
		{Name: "status_422_error_msg_precedence", Status: 422, Body: \`{"error_msg":"error_msg wins","detail":"detail ignored"}\`},
		{Name: "status_429_error_string_precedence", Status: 429, Body: \`{"error":"string error wins","message":"message ignored"}\`},
		{Name: "status_500_detail_precedence", Status: 500, Body: \`{"detail":"detail wins","header":{"message":"header ignored"}}\`},
		{Name: "status_500_message_only_error_object", Status: 500, Body: \`{"error":{"message":"object message","code":null},"message":"ignored"}\`},
		{Name: "status_502_header_message", Status: 502, Body: \`{"header":{"message":"header wins"},"response":{"error":{"message":"nested ignored"}}}\`},
		{Name: "status_503_nested_response_message", Status: 503, Body: \`{"response":{"error":{"message":"nested response wins"}}}\`},
		{Name: "status_599_malformed", Status: 599, Body: "not-json"},
	}

	cases := make([]responseManifestCase, 0, len(seeds))
	for _, seed := range seeds {
		cases = append(cases, responseManifestInterpret(seed))
	}
	encoded, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("%s%s\\n", responseInterpreterManifestMarker, encoded)
}
`;

function parseArgs(argv) {
  const options = {
    source: process.env.CINATOKEN_GO_SOURCE
      ? resolve(process.env.CINATOKEN_GO_SOURCE)
      : DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    check: false,
    verifyArtifact: false,
    json: false,
    goProxy: process.env.CINATOKEN_GO_PROXY ?? "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") options.source = resolve(argv[++index] ?? "");
    else if (arg === "--output") options.output = resolve(argv[++index] ?? "");
    else if (arg === "--check") options.check = true;
    else if (arg === "--verify-artifact") options.verifyArtifact = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--go-proxy") options.goProxy = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function run(command, args, cwd, env = process.env) {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.exitCode}\n${stdout}${stderr}`,
    );
  }
  return stdout;
}

function parseGeneratedCases(output) {
  const matches = output
    .split(/\r?\n/)
    .map((line) => {
      const markerIndex = line.indexOf(MARKER);
      return markerIndex < 0 ? null : line.slice(markerIndex + MARKER.length);
    })
    .filter((line) => line !== null);
  if (matches.length !== 1) {
    throw new Error(
      `${GO_TEST_NAME} emitted ${matches.length} ${MARKER} records; expected exactly one`,
    );
  }
  const parsed = JSON.parse(matches[0]);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${GO_TEST_NAME} emitted an empty case list`);
  }
  return parsed;
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

function resolveSourceFile(source, relativePath) {
  const normalized = relativePath.replaceAll("/", "\\");
  const resolved = resolve(source, normalized);
  const allowed = SOURCE_ROOTS.some((root) => {
    const rootPath = resolve(source, root);
    return resolved === rootPath || resolved.startsWith(`${rootPath}\\`);
  });
  if (!allowed) {
    throw new Error(`source path escapes the explicit safe roots: ${relativePath}`);
  }
  return resolved;
}

async function assertPinnedCleanSource(source) {
  if (!existsSync(resolve(source, "go.mod"))) {
    throw new Error(`Go source checkout is missing go.mod: ${source}`);
  }
  const commit = run("git", ["rev-parse", "HEAD"], source).trim();
  if (commit !== PINNED_COMMIT) {
    throw new Error(
      `Go source must be pinned to ${PINNED_COMMIT}; found ${commit}`,
    );
  }
  const changes = run(
    "git",
    ["status", "--porcelain=v1", "--", ...SOURCE_ROOTS],
    source,
  ).trim();
  if (changes) {
    throw new Error(
      `Go source safe roots must be clean at the pinned commit:\n${changes}`,
    );
  }
  for (const relativePath of SOURCE_FILES) {
    const path = resolveSourceFile(source, relativePath);
    if (!existsSync(path)) {
      throw new Error(`authoritative Go source file is missing: ${path}`);
    }
  }
  return commit;
}

async function buildManifest(source, goProxy) {
  const commit = await assertPinnedCleanSource(source);
  const target = resolve(source, ...GO_TEST_TARGET);
  resolveSourceFile(source, GO_TEST_TARGET.join("/"));
  if (existsSync(target)) {
    throw new Error(`refusing to overwrite existing generator target: ${target}`);
  }

  const goPath = process.env.USERPROFILE
    ? resolve(process.env.USERPROFILE, "go")
    : resolve(tmpdir(), "cinatoken-go-response-manifest-gopath");
  const goEnv = {
    ...process.env,
    CINATOKEN_RESPONSE_INTERPRETER_MANIFEST: "1",
    GOPATH: goPath,
    GOMODCACHE: resolve(goPath, "pkg", "mod"),
  };
  if (goProxy) goEnv.GOPROXY = goProxy;
  await mkdir(goEnv.GOMODCACHE, { recursive: true });

  let created = false;
  let cases;
  try {
    await writeFile(target, GO_TEST_TEMPLATE, { flag: "wx" });
    created = true;
    if ((await fileSha256(target)) !== sha256(GO_TEST_TEMPLATE)) {
      throw new Error(`injected Go template hash changed while writing ${target}`);
    }
    const output = run(
      "go",
      [
        "test",
        "./relay/channel/openai",
        "-run",
        `^${GO_TEST_NAME}$`,
        "-count=1",
        "-v",
      ],
      source,
      goEnv,
    );
    cases = parseGeneratedCases(output);
  } finally {
    if (created) await rm(target, { force: true });
  }

  const sourceFiles = {};
  for (const relativePath of SOURCE_FILES) {
    sourceFiles[relativePath] = await fileSha256(
      resolveSourceFile(source, relativePath),
    );
  }
  const payload = {
    schema_version: 1,
    contract: "go-openai-response-v1",
    source: {
      repository: "github.com/cinagroup/cinatoken",
      commit,
      files_sha256: sourceFiles,
    },
    generator: {
      runtime: "go test ./relay/channel/openai against pinned source",
      injected_target: GO_TEST_TARGET.join("/"),
      script_sha256: await fileSha256(GENERATOR_SCRIPT),
      template_name: GO_TEST_TEMPLATE_NAME,
      template_sha256: sha256(GO_TEST_TEMPLATE),
    },
    capabilities: {
      buffered_provider_response: true,
      stream_partial_usage_shared_api: false,
    },
    cases,
  };
  return {
    ...payload,
    manifest_sha256: sha256(canonicalJson(payload)),
  };
}

function isLowerHex(value, length) {
  return (
    typeof value === "string" &&
    value.length === length &&
    new RegExp(`^[0-9a-f]{${length}}$`).test(value)
  );
}

function isJSONObjectBody(body) {
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

async function verifyArtifact(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const { manifest_sha256: expectedDigest, ...payload } = manifest;
  const actualDigest = sha256(canonicalJson(payload));
  if (!isLowerHex(expectedDigest, 64) || actualDigest !== expectedDigest) {
    throw new Error(
      `manifest digest mismatch: expected ${expectedDigest}, computed ${actualDigest}`,
    );
  }
  if (
    manifest.schema_version !== 1 ||
    manifest.contract !== "go-openai-response-v1"
  ) {
    throw new Error("manifest contract identity is invalid");
  }
  if (
    manifest.source?.repository !== "github.com/cinagroup/cinatoken" ||
    manifest.source?.commit !== PINNED_COMMIT
  ) {
    throw new Error("manifest source pin is invalid");
  }

  const sourceHashes = manifest.source?.files_sha256;
  const sourceKeys =
    sourceHashes && typeof sourceHashes === "object"
      ? Object.keys(sourceHashes).sort()
      : [];
  if (
    JSON.stringify(sourceKeys) !== JSON.stringify([...SOURCE_FILES].sort()) ||
    sourceKeys.some((key) => !isLowerHex(sourceHashes[key], 64))
  ) {
    throw new Error("manifest source-file hash inventory is invalid");
  }
  if (
    manifest.generator?.runtime !==
      "go test ./relay/channel/openai against pinned source" ||
    manifest.generator?.injected_target !== GO_TEST_TARGET.join("/") ||
    manifest.generator?.script_sha256 !==
      (await fileSha256(GENERATOR_SCRIPT)) ||
    manifest.generator?.template_name !== GO_TEST_TEMPLATE_NAME ||
    manifest.generator?.template_sha256 !== sha256(GO_TEST_TEMPLATE)
  ) {
    throw new Error("manifest generator identity is invalid");
  }
  if (
    manifest.capabilities?.buffered_provider_response !== true ||
    manifest.capabilities?.stream_partial_usage_shared_api !== false
  ) {
    throw new Error("manifest capability declaration is invalid");
  }

  if (!Array.isArray(manifest.cases) || manifest.cases.length !== EXPECTED_CASE_COUNT) {
    throw new Error(
      `manifest must contain exactly ${EXPECTED_CASE_COUNT} response cases`,
    );
  }
  const names = new Set();
  const statuses = new Set();
  const classCounts = Object.fromEntries(
    Object.keys(EXPECTED_CLASS_COUNTS).map((key) => [key, 0]),
  );
  for (const entry of manifest.cases) {
    if (
      typeof entry?.name !== "string" ||
      entry.name.length === 0 ||
      names.has(entry.name)
    ) {
      throw new Error("manifest contains an invalid or duplicate case name");
    }
    names.add(entry.name);
    statuses.add(entry.status);
    const expected = entry.expected;
    if (!(expected?.class in classCounts)) {
      throw new Error(`manifest case ${entry.name} has an invalid class`);
    }
    classCounts[expected.class] += 1;
    const success = expected.class === "success";
    const expectedClientStatus =
      expected.class === "invalid_body" ? 500 : entry.status;
    const expectedAuditStatus =
      success || entry.status >= 400 ? entry.status : 500;
    if (
      expected.upstream_status !== entry.status ||
      expected.client_status !== expectedClientStatus ||
      expected.audit_status !== expectedAuditStatus ||
      expected.success !== success ||
      expected.has_json_object !== isJSONObjectBody(entry.body) ||
      expected.body_sha256 !== sha256(entry.body) ||
      (success ? expected.error !== null : expected.error === null)
    ) {
      throw new Error(`manifest case ${entry.name} has inconsistent facts`);
    }
    const decisions = expected.header_decisions;
    if (!Array.isArray(decisions) || decisions.length !== HEADER_NAMES.length) {
      throw new Error(`manifest case ${entry.name} has invalid header coverage`);
    }
    const headerNames = decisions.map((decision) => decision.name);
    if (JSON.stringify(headerNames) !== JSON.stringify(HEADER_NAMES)) {
      throw new Error(`manifest case ${entry.name} changed the header inventory`);
    }
    for (const decision of decisions) {
      const lower = decision.name.toLowerCase();
      const sourceEligible = !SOURCE_REJECTED_HEADERS.has(lower);
      const publicForward =
        success && sourceEligible && PUBLIC_SAFE_HEADERS.has(lower);
      if (
        decision.source_eligible !== sourceEligible ||
        decision.public_forward !== publicForward
      ) {
        throw new Error(
          `manifest case ${entry.name} has an invalid ${decision.name} decision`,
        );
      }
    }
  }
  for (const status of REQUIRED_STATUSES) {
    if (!statuses.has(status)) {
      throw new Error(`manifest is missing required status ${status}`);
    }
  }
  if (
    Object.entries(EXPECTED_CLASS_COUNTS).some(
      ([name, count]) => classCounts[name] !== count,
    )
  ) {
    throw new Error(
      `manifest class counts are invalid: ${JSON.stringify(classCounts)}`,
    );
  }

  return {
    manifest_sha256: actualDigest,
    cases: manifest.cases.length,
    source_commit: manifest.source.commit,
    class_counts: classCounts,
  };
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.verifyArtifact) {
    const summary = await verifyArtifact(options.output);
    console.log(options.json ? JSON.stringify(summary) : summary);
    return;
  }

  const manifest = await buildManifest(options.source, options.goProxy);
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.check) {
    const current = await readFile(options.output, "utf8");
    if (current !== encoded) {
      throw new Error(
        `Go response interpreter manifest is stale; regenerate ${options.output}`,
      );
    }
  } else {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, encoded);
  }
  const summary = await verifyArtifact(options.output);
  console.log(options.json ? JSON.stringify(summary) : summary);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
