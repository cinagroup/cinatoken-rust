use std::process::Command;

const BINARY: &str = env!("CARGO_BIN_EXE_cinatoken-ring-transition-runner");

#[test]
fn describe_ignores_runtime_trust_and_secret_poisoning() {
    let output = Command::new(BINARY)
        .arg("--describe")
        .env("CINATOKEN_RING_RUNNER_ENABLED", "true")
        .env("CINATOKEN_RING_RUNNER_TRUST", "poison-trust")
        .env("CINATOKEN_RING_TRANSITION_READ_TOKEN", "poison-read-token")
        .env(
            "CINATOKEN_RING_TRANSITION_CLAIM_HMAC_SECRET",
            "poison-claim-secret",
        )
        .env(
            "CINATOKEN_RING_TRANSITION_DEPLOY_TOKEN",
            "poison-deploy-token",
        )
        .env(
            "CINATOKEN_RING_TRANSITION_ACCESS_CLIENT_ID",
            "poison-access-client-id",
        )
        .env(
            "CINATOKEN_RING_TRANSITION_ACCESS_CLIENT_SECRET",
            "poison-access-client-secret",
        )
        .output()
        .expect("runner must start");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("stdout must be UTF-8 JSON");
    assert!(stdout.contains("\"releasePublished\": false"));
    assert!(stdout.contains("\"credentialsRead\": false"));
    assert!(!stdout.contains("poison"));
    assert!(output.stderr.is_empty());
}

#[test]
fn execute_and_override_arguments_fail_closed() {
    let execute = Command::new(BINARY)
        .arg("--execute")
        .env("CINATOKEN_RING_RUNNER_ENABLED", "true")
        .output()
        .expect("runner must start");
    assert_eq!(execute.status.code(), Some(1));
    assert!(execute.stdout.is_empty());
    assert_eq!(
        String::from_utf8(execute.stderr).expect("stderr must be UTF-8"),
        "embedded release is disabled\n"
    );

    for arguments in [
        vec!["--execute", "--config", "unreviewed.json"],
        vec!["--runner", "other.exe"],
        vec!["--trust-key", "replacement"],
    ] {
        let rejected = Command::new(BINARY)
            .args(arguments)
            .output()
            .expect("runner must start");
        assert_eq!(rejected.status.code(), Some(2));
        assert!(rejected.stdout.is_empty());
        assert_eq!(
            String::from_utf8(rejected.stderr).expect("stderr must be UTF-8"),
            "usage: cinatoken-ring-transition-runner --describe|--execute\n"
        );
    }
}
