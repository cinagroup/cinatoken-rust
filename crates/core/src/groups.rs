//! User group resolution — pure ports of the Go group-config helpers used by
//! channel selection (`service/group.go`, `setting/user_usable_group.go`,
//! `setting/auto_group.go`). These decide which groups a user may use and, of
//! those, which participate in "auto" cross-group selection. Parity target:
//! `docs/source-channel-selection-parity.md`.
//!
//! The actual settings (base usable groups, per-group special overrides, the
//! auto-group list) are loaded from D1/options by the caller and passed in here,
//! keeping this layer pure and unit-testable. Pair with
//! [`crate::channel_select::auto_group_retry_step`], which consumes the
//! [`user_auto_groups`] list.

use std::collections::HashMap;

/// Default description Go assigns to a user's own group when it is not already in
/// the usable set (`service.GetUserUsableGroups`).
pub const DEFAULT_USER_GROUP_DESC: &str = "用户分组";

/// Resolve the groups a user may use — faithful port of
/// `service.GetUserUsableGroups`:
///
/// 1. start from a copy of the base usable groups (`group -> description`);
/// 2. for a non-empty `user_group`, apply that group's special overrides:
///    - `"-:<g>"` removes group `<g>`,
///    - `"+:<g>"` adds group `<g>` with the override's description,
///    - any other key adds that group verbatim;
/// 3. ensure `user_group` itself is present (added with [`DEFAULT_USER_GROUP_DESC`]
///    if missing).
///
/// `special_usable_groups` is this user-group's override map (empty when none is
/// configured — Go's `!ok` skips step 2). As in Go, conflicting `+:`/`-:` entries
/// for the same group resolve in map-iteration order.
pub fn user_usable_groups(
    user_group: &str,
    base_usable_groups: &HashMap<String, String>,
    special_usable_groups: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut groups = base_usable_groups.clone();
    if user_group.is_empty() {
        return groups;
    }
    for (special, desc) in special_usable_groups {
        if let Some(remove) = special.strip_prefix("-:") {
            groups.remove(remove);
        } else if let Some(add) = special.strip_prefix("+:") {
            groups.insert(add.to_string(), desc.clone());
        } else {
            groups.insert(special.clone(), desc.clone());
        }
    }
    groups
        .entry(user_group.to_string())
        .or_insert_with(|| DEFAULT_USER_GROUP_DESC.to_string());
    groups
}

/// The user's auto groups — faithful port of `service.GetUserAutoGroup`: the
/// configured `auto_groups` (in their configured order) filtered to those the
/// user may use ([`user_usable_groups`]). This is the ordered group list the
/// auto cross-group retry walks.
pub fn user_auto_groups(
    user_group: &str,
    auto_groups: &[String],
    base_usable_groups: &HashMap<String, String>,
    special_usable_groups: &HashMap<String, String>,
) -> Vec<String> {
    let usable = user_usable_groups(user_group, base_usable_groups, special_usable_groups);
    auto_groups
        .iter()
        .filter(|group| usable.contains_key(group.as_str()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HashMap<String, String> {
        [("default", "默认分组"), ("vip", "vip分组")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn keys(m: &HashMap<String, String>) -> Vec<String> {
        let mut k: Vec<String> = m.keys().cloned().collect();
        k.sort();
        k
    }

    #[test]
    fn empty_user_group_returns_base_unchanged() {
        let g = user_usable_groups("", &base(), &HashMap::new());
        assert_eq!(keys(&g), vec!["default", "vip"]);
    }

    #[test]
    fn known_user_group_is_unchanged() {
        let g = user_usable_groups("vip", &base(), &HashMap::new());
        assert_eq!(keys(&g), vec!["default", "vip"]);
    }

    #[test]
    fn unknown_user_group_is_added_with_default_desc() {
        let g = user_usable_groups("svip", &base(), &HashMap::new());
        assert_eq!(keys(&g), vec!["default", "svip", "vip"]);
        assert_eq!(g.get("svip").map(String::as_str), Some(DEFAULT_USER_GROUP_DESC));
    }

    #[test]
    fn special_add_remove_and_plain() {
        // +:svip adds, -:vip removes, plain "premium" adds.
        let special = map(&[("+:svip", "超级vip"), ("-:vip", ""), ("premium", "高级")]);
        let g = user_usable_groups("default", &base(), &special);
        assert_eq!(keys(&g), vec!["default", "premium", "svip"]);
        assert_eq!(g.get("svip").map(String::as_str), Some("超级vip"));
        assert_eq!(g.get("premium").map(String::as_str), Some("高级"));
    }

    #[test]
    fn special_overrides_only_apply_for_non_empty_user_group() {
        // Empty user group skips specials entirely (Go gates them on userGroup!="").
        let special = map(&[("+:svip", "x")]);
        let g = user_usable_groups("", &base(), &special);
        assert_eq!(keys(&g), vec!["default", "vip"]);
    }

    #[test]
    fn auto_groups_filtered_and_ordered() {
        // auto list order is preserved; groups the user can't use are dropped.
        let auto = ["vip", "default", "ghost"].map(String::from);
        let got = user_auto_groups("default", &auto, &base(), &HashMap::new());
        assert_eq!(got, vec!["vip".to_string(), "default".to_string()]);
    }

    #[test]
    fn auto_groups_respect_special_additions() {
        // A group added via a special override becomes auto-eligible.
        let auto = ["svip".to_string()];
        let special = map(&[("+:svip", "超级vip")]);
        let got = user_auto_groups("default", &auto, &base(), &special);
        assert_eq!(got, vec!["svip".to_string()]);
    }

    #[test]
    fn auto_groups_respect_special_removals() {
        // -:vip removes vip, so it is no longer auto-eligible.
        let auto = ["vip".to_string(), "default".to_string()];
        let special = map(&[("-:vip", "")]);
        let got = user_auto_groups("default", &auto, &base(), &special);
        assert_eq!(got, vec!["default".to_string()]);
    }
}
