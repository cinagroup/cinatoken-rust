# JSON Compatibility Deployment Resolution Worker

This package is the private, Reader-only Worker boundary for resolving an
inflight JSON compatibility deployment transition after the normal transition
execution path has been quiesced.

## Capability Boundary

The named RPC entrypoint is
`JsonCompatibilityDeploymentTransitionResolutionEntrypoint`. It delegates only
these methods to the resolution core:

- `resolveDeploymentTransitionInflight(env, input)` returning `ReceiptV1`
- `getDeploymentTransitionResolutionStatus(env, input)` returning `StatusV1`

The core exports `DeploymentTransitionResolutionEnv`. The default entrypoint is
an inert `WorkerEntrypoint` with no methods.

The Worker has exactly two platform capabilities:

- the shared deployment-transition D1 database; and
- the private `JSON_COMPATIBILITY_DEPLOYMENT_READBACK` service binding.

It has no Deployment Mutator binding, Source Verifier binding, Cloudflare API
token, public route, `workers.dev` endpoint, or preview URL. Fresh source proof
and owner recovery authorization are request evidence, not Worker-held
capabilities. The owner authorization binds the exact fresh-proof digest, and
both Resolver and Reader reject proof substitution before D1, token, or
network access.

## Profiles

Tracked `local` and `staging` profiles use resolution profile version `1` and
keep the master, execution, and status-read gates disabled. Both bind the
Reader staging service identity. The staging service name is
`cinatoken-container-runtime-json-compatibility-deployment-resolution-staging`.

The D1 binding points at the same database as the corresponding transition
profile. Migration ownership remains with the transition package through:

```text
../container-runtime-json-compatibility-deployment-transition/migrations
```

## Verification

Run from this directory:

```powershell
bun run types
bun run test
bun run check
```

`wrangler types` generates `worker-configuration.d.ts` from the local profile.
The complete `check` command verifies generated-type drift, strict TypeScript,
Node protocol/configuration behavior, Workerd/D1 migration and repository
invariants, plus local and staging Wrangler dry-runs.

Local tests and dry runs verify the tracked shell only. They do not establish
remote D1 schema state, private caller topology, exact deployed Version
Metadata, quiescence, credential isolation, or production cutover readiness.
