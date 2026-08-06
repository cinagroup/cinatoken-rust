# JSON compatibility deployment Mutator

This service is the D0 private mutation leaf. The default entrypoint is inert;
the only callable method is
`JsonCompatibilityDeploymentMutationEntrypoint.mutateDeploymentOnce(input)`
over a Cloudflare Service Binding.

The Worker has one secret,
`CLOUDFLARE_DEPLOYMENT_MUTATION_API_TOKEN`. Provision it with `wrangler secret
put`; it is intentionally absent from both Wrangler configuration files. Both
enablement gates default to `false`, and neither configuration defines routes,
Workers.dev access, preview URLs, or a read credential.

`src/protocol.ts` directly calls
`validateJsonCompatibilityDeploymentTransitionMutationExecution`. The Mutator
therefore revalidates the signed Plan/state-plan authorization, embedded
inventory, source authentication, source readbacks, mutation intent, and signed
mutation leaf identity before reading the deploy token or claiming D1.

The create-once claim is the dispatch boundary. Only a definitely fresh D1
insert may send one POST. Exact replay, an in-flight call, missing outcome, or
write-result loss returns an ambiguous recovery outcome and never sends again.
