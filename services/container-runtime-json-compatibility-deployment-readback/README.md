# JSON compatibility deployment readback Worker

This D0 Worker is the read-only half of the deployment transition boundary. Its
default entrypoint has no methods. The named entrypoint exposes
`readDeploymentState(input)` for live execution and
`readDeploymentStateForResolution(input)` for separately signed, target-only
inflight recovery. Both methods remain read-only.

## Boundary

- The normal RPC accepts exactly `campaignPlan`, `statePlan`,
  `authorizedTransition`, `sourceAuthentication`, and `readbackRequest`. The
  recovery RPC instead accepts exactly `campaignPlan`, `statePlan`,
  `authorizedTransition`, `authorizedResolution`, `sourceAuthentication`,
  `originalSourceAuthentication`, `mutationIntent`, `sourceReadbacks`, and
  `readbackRequest`. The artifact inventory is read only from the signed
  `authorizedTransition`.
- Plan currency, owner authorization, source authentication, operation digests,
  the signed inventory, the exact step/phase/artifact, and the Reader's signed
  execution authority are validated before the token binding is read.
- The recovery RPC additionally validates the dedicated resolution signature
  and its exact fresh-source-proof digest before token or network access. A
  separately valid substituted proof is rejected.
- The only secret is `CLOUDFLARE_DEPLOYMENT_READ_API_TOKEN`. The account ID,
  account digest, and credential ID digest are non-secret identity anchors.
- The remote client performs one GET each for deployments, the exact version,
  subdomain, and account custom domains, then traverses the complete
  account-filtered zone pagination and reads every zone's Worker routes. It
  never retries, uses `redirect: "manual"`, shares one 10 second deadline, and
  accepts at most 64 KiB across all response bodies.
- A live active version ID is joined to its immutable, signed artifact inventory
  entry. Live `workers_dev` and preview state come from the subdomain endpoint.
  The route digest is rebuilt from current custom-domain and zone-route
  responses; pagination drift, incomplete traversal, or any response shape
  that cannot establish those facts returns v2 `ambiguous`.

Both Wrangler profiles have `workers_dev`, preview URLs, and the Reader gate set
to false, and neither profile declares routes. Before staging activation, replace
the placeholder account and credential identity values, deploy a version, bind
that exact `CF_VERSION_METADATA.id` into a newly signed execution authority, set
the read-only token with Wrangler's interactive secret command, and only then
enable the gate in a reviewed configuration change.

## Local verification

```text
bun run --cwd services/container-runtime-json-compatibility-deployment-readback check
```

`src/shared_protocol_adapter.mjs` contains no protocol logic. It only supplies a
local declaration surface for the shared campaign module's canonical JSON/hash
helpers; transition validation and v2 builders are imported directly from the
shared transition module.
