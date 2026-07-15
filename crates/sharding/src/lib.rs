//! Stable, I/O-free routing for the native container scheduler.
//!
//! Callers must derive the opaque routing key with a secret-keyed digest. This
//! crate never receives or serializes raw user, token, tenant, or operation IDs.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const CONTAINER_SHARD_CONTRACT_VERSION: u32 = 1;
pub const CONTAINER_SHARD_INSTANCE_PREFIX: &str = "cinatoken-relay-shard-v1";
pub const MAX_CONTAINER_SHARDS: u16 = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShardRoutingKey([u8; 32]);

impl ShardRoutingKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl TryFrom<[u8; 32]> for ShardRoutingKey {
    type Error = ShardPlanError;

    fn try_from(value: [u8; 32]) -> Result<Self, Self::Error> {
        if value.iter().all(|byte| *byte == 0) {
            return Err(ShardPlanError::InvalidRoutingKey);
        }
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShardRing {
    pub contract_version: u32,
    pub generation: u64,
    pub shard_count: u16,
}

impl ShardRing {
    pub fn new(generation: u64, shard_count: u16) -> Result<Self, ShardPlanError> {
        if generation == 0 {
            return Err(ShardPlanError::InvalidGeneration);
        }
        if !(1..=MAX_CONTAINER_SHARDS).contains(&shard_count) {
            return Err(ShardPlanError::InvalidShardCount {
                actual: shard_count,
            });
        }
        Ok(Self {
            contract_version: CONTAINER_SHARD_CONTRACT_VERSION,
            generation,
            shard_count,
        })
    }

    pub fn plan(&self, routing_key: ShardRoutingKey) -> ShardPlan {
        let hash = u64::from_be_bytes(
            routing_key.as_bytes()[..8]
                .try_into()
                .expect("routing key prefix has a fixed width"),
        );
        let shard_index = jump_consistent_hash(hash, self.shard_count);
        ShardPlan {
            contract_version: self.contract_version,
            ring_generation: self.generation,
            shard_count: self.shard_count,
            shard_index,
            instance_name: format!("{CONTAINER_SHARD_INSTANCE_PREFIX}-{shard_index:04}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShardPlan {
    pub contract_version: u32,
    pub ring_generation: u64,
    pub shard_count: u16,
    pub shard_index: u16,
    pub instance_name: String,
}

impl ShardPlan {
    pub fn validate_fence(&self, active_ring: ShardRing) -> Result<(), ShardFenceError> {
        if self.contract_version != active_ring.contract_version {
            return Err(ShardFenceError::ContractVersion {
                expected: active_ring.contract_version,
                actual: self.contract_version,
            });
        }
        if self.ring_generation != active_ring.generation {
            return Err(ShardFenceError::RingGeneration {
                expected: active_ring.generation,
                actual: self.ring_generation,
            });
        }
        if self.shard_count != active_ring.shard_count
            || self.shard_index >= active_ring.shard_count
        {
            return Err(ShardFenceError::ShardTopology);
        }
        let expected_name = format!("{CONTAINER_SHARD_INSTANCE_PREFIX}-{:04}", self.shard_index);
        if self.instance_name != expected_name {
            return Err(ShardFenceError::InstanceName);
        }
        Ok(())
    }
}

fn jump_consistent_hash(mut key: u64, buckets: u16) -> u16 {
    let mut current = -1_i64;
    let mut candidate = 0_i64;
    while candidate < i64::from(buckets) {
        current = candidate;
        key = key.wrapping_mul(2_862_933_555_777_941_757).wrapping_add(1);
        let numerator =
            u64::try_from(current + 1).expect("bucket index is non-negative") * (1_u64 << 31);
        candidate =
            i64::try_from(numerator / ((key >> 33) + 1)).expect("jump hash bucket fits in i64");
    }
    u16::try_from(current).expect("validated shard count keeps the bucket in u16")
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ShardPlanError {
    #[error("container shard ring generation must be positive")]
    InvalidGeneration,
    #[error("container shard count {actual} must be between 1 and {MAX_CONTAINER_SHARDS}")]
    InvalidShardCount { actual: u16 },
    #[error("container shard routing key must be a non-zero 32-byte keyed digest")]
    InvalidRoutingKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ShardFenceError {
    #[error("container shard contract version mismatch: expected {expected}, got {actual}")]
    ContractVersion { expected: u32, actual: u32 },
    #[error("container shard ring generation mismatch: expected {expected}, got {actual}")]
    RingGeneration { expected: u64, actual: u64 },
    #[error("container shard topology does not match the active ring")]
    ShardTopology,
    #[error("container shard instance name is not canonical")]
    InstanceName,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u64) -> ShardRoutingKey {
        let mut digest = [0_u8; 32];
        digest[..8].copy_from_slice(&seed.to_be_bytes());
        digest[8..16].copy_from_slice(&seed.rotate_left(17).to_be_bytes());
        ShardRoutingKey::try_from(digest).unwrap()
    }

    #[test]
    fn same_opaque_key_has_a_stable_canonical_owner() {
        let ring = ShardRing::new(7, 32).unwrap();
        let first = ring.plan(key(42));
        let second = ring.plan(key(42));
        assert_eq!(first, second);
        assert!(first.shard_index < 32);
        assert_eq!(
            first.instance_name,
            format!("{CONTAINER_SHARD_INSTANCE_PREFIX}-{:04}", first.shard_index)
        );
        first.validate_fence(ring).unwrap();
    }

    #[test]
    fn generation_fences_stale_work_without_remapping_the_ring() {
        let old_ring = ShardRing::new(3, 16).unwrap();
        let new_ring = ShardRing::new(4, 16).unwrap();
        let old = old_ring.plan(key(9_001));
        let new = new_ring.plan(key(9_001));
        assert_eq!(old.shard_index, new.shard_index);
        assert_eq!(old.instance_name, new.instance_name);
        assert!(matches!(
            old.validate_fence(new_ring),
            Err(ShardFenceError::RingGeneration {
                expected: 4,
                actual: 3
            })
        ));
    }

    #[test]
    fn adding_one_shard_only_moves_keys_to_the_new_shard() {
        let old_ring = ShardRing::new(1, 16).unwrap();
        let new_ring = ShardRing::new(2, 17).unwrap();
        let mut moved = 0_u32;
        for seed in 1..=10_000 {
            let old = old_ring.plan(key(seed));
            let new = new_ring.plan(key(seed));
            if old.shard_index != new.shard_index {
                moved += 1;
                assert_eq!(new.shard_index, 16);
            }
        }
        assert!(
            (400..=800).contains(&moved),
            "unexpected moved key count {moved}"
        );
    }

    #[test]
    fn plan_serialization_never_contains_the_opaque_routing_key() {
        let plan = ShardRing::new(1, 8).unwrap().plan(key(0xfeed_beef));
        let json = serde_json::to_string(&plan).unwrap();
        assert_eq!(
            json,
            format!(
                "{{\"contract_version\":1,\"ring_generation\":1,\"shard_count\":8,\"shard_index\":{},\"instance_name\":\"{}\"}}",
                plan.shard_index, plan.instance_name
            )
        );
        assert!(!json.contains("feedbeef"));
    }

    #[test]
    fn invalid_ring_and_key_inputs_fail_closed() {
        assert_eq!(ShardRing::new(0, 1), Err(ShardPlanError::InvalidGeneration));
        assert!(matches!(
            ShardRing::new(1, 0),
            Err(ShardPlanError::InvalidShardCount { actual: 0 })
        ));
        assert!(matches!(
            ShardRing::new(1, MAX_CONTAINER_SHARDS + 1),
            Err(ShardPlanError::InvalidShardCount { .. })
        ));
        assert_eq!(
            ShardRoutingKey::try_from([0_u8; 32]),
            Err(ShardPlanError::InvalidRoutingKey)
        );
    }
}
