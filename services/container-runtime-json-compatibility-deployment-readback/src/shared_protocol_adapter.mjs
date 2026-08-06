// The campaign module has no .d.mts surface yet. Keep only its canonical helpers
// here; all deployment-transition functions use the shared typed module directly.
export {
  canonicalJson,
  sha256Canonical,
} from "../../../tools/container_runtime_json_compatibility_campaign.mjs";
