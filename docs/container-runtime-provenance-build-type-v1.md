# Container Runtime Provenance Build Type v1

Type URI:
`https://github.com/cinagroup/cinatoken-rust/blob/main/docs/container-runtime-provenance-build-type-v1.md`

This build type describes the credential-free
`.github/workflows/container-runtime-oci.yml` job and its separately
permissioned provenance continuation.

## External parameters

- `repository`: exact GitHub `owner/repository`.
- `ref`: source Git ref. Version 1 accepts only `refs/heads/main`.
- `eventName`: source event, limited by the checked-in provenance policy.
- `workflowPath`: exact source workflow path.

Consumers must reject unknown external parameters.

## Internal parameters

- `sourceRunId` and `sourceRunAttempt`: the successful source workflow
  invocation that produced the retained artifact.
- `sourceJob`: fixed source job name.
- `platform`: fixed `linux/amd64` output platform.
- `sourceDateEpoch`: reproducible-build timestamp.
- `independentBuilds`: exact number of independent OCI exports.

## Procedure

1. Check out the exact source commit without persisted credentials.
2. Build two no-cache `linux/amd64` OCI archives with separate pinned BuildKit
   instances and default BuildKit attestations disabled.
3. Require byte-identical archives and an exact OCI graph, platform, metadata,
   layer, diff ID, and runtime-binary match.
4. Generate two network-isolated deterministic Syft catalogs and require exact
   bytes plus OCI subject binding.
5. Extract the frozen Grype database twice, scan twice without network, and
   apply the checked-in fail-closed vulnerability policy.
6. Upload the complete accepted source packet.
7. In a distinct `workflow_run` job, accept only a successful same-repository,
   same-commit `main` run; revalidate the OCI and SBOM evidence, validate all
   retained S2 inputs, construct the exact SLSA v1 statement, and sign it with
   GitHub Actions OIDC through Sigstore.
8. Verify the blob subject, Fulcio identity and issuer, GitHub workflow claims,
   SCT, Rekor inclusion, RFC 3161 timestamp, DSSE payload, and checked-in
   signer policy before retaining the S3 packet.

## Outputs

The subjects are the exact OCI archive, OCI index, platform manifest, config,
runtime binary, deterministic SBOM, and deterministic vulnerability scan.
`runDetails.byproducts` binds the retained reports and source evidence by
SHA-256 and byte length.

## Security boundary

Version 1 is SLSA v1-format provenance and does not claim a SLSA build level.
The signing job is separate from the source build but remains repository
controlled. GitHub artifact retention is immutable for the retained artifact
version but is deletable and expiring; it is not approved WORM retention.
Registry publication, Cloudflare deployment, P5 eligibility, customer traffic,
financial authority, and production cutover remain unauthorized.
