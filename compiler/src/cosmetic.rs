//! Precomputes cosmetic filtering and scriptlet injection per hostname by querying
//! adblock-rust's `url_cosmetic_resources` exactly as brave-core does at navigation time.
//!
//! Brave asks the engine synchronously before any page script runs. An MV3 extension can't do
//! a synchronous round-trip, so we ask the engine at build time for every hostname that any
//! cosmetic rule mentions and ship the answers:
//!   * hide/unhide selectors as per-host data the content script reads at document_start;
//!   * scriptlets as a MAIN-world content script bundle (shared function library + compact
//!     per-host call lists). The engine is fed *stub* resources so it emits only the calls,
//!     never the function bodies, which live once in the library.

use adblock::Engine;
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::LazyLock;

/// Synthetic TLD used to evaluate `example.*` entity rules in isolation.
pub const ENTITY_TLD: &str = "zzentity";

#[derive(Serialize, Default)]
pub struct HostEntry {
    /// Site-specific hide selectors from the default (first-party-protected) engine.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub d: Vec<String>,
    /// Generic default-engine selectors that this site excepts (`#@#`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub du: Vec<String>,
    /// Site-specific hide selectors from the additional engine (always forced).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub a: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub au: Vec<String>,
    /// Procedural filters (JSON, Brave's format) from the default engine.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub p: Vec<String>,
    /// Procedural filters from the additional engine.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pa: Vec<String>,
    /// `$generichide` from either engine (Brave ORs them; gates class/id lookups).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub gh: bool,
    /// Default engine generichide: its misc generic selectors are not applied.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dg: bool,
    /// Additional engine generichide.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ag: bool,
}

impl HostEntry {
    fn is_empty(&self) -> bool {
        self.d.is_empty() && self.du.is_empty() && self.a.is_empty() && self.au.is_empty()
            && self.p.is_empty() && self.pa.is_empty() && !self.gh && !self.dg && !self.ag
    }
}

pub struct Output {
    pub hosts: BTreeMap<String, HostEntry>,
    pub generic_default: Vec<String>,
    pub generic_additional: Vec<String>,
    /// key -> deduplicated scriptlet invocation blocks
    pub scripts: BTreeMap<String, Vec<String>>,
}

static HOST_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^#]*)#[@?$%]{0,2}#").unwrap());

/// Collects every hostname / entity key that a cosmetic rule (or `$generichide`) targets.
pub fn collect_keys(list_text: &str, keys: &mut BTreeSet<String>) {
    for line in list_text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('[') {
            continue;
        }
        if let Some(c) = HOST_PREFIX.captures(line) {
            for h in c[1].split(',') {
                let h = h.trim().trim_start_matches('~').to_ascii_lowercase();
                let host = h.strip_suffix(".*").unwrap_or(&h);
                let valid = !host.is_empty()
                    && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
                    && !host.starts_with('.')
                    && !host.ends_with('.')
                    && !host.contains("..");
                if valid {
                    keys.insert(h);
                }
            }
        }
    }
}

/// `$generichide` exceptions. Hostname/domain-scoped ones become precompute keys; URL-pattern
/// ones (e.g. `@@://192.168.$generichide`, `@@||bing.com/search?$generichide`) are returned as
/// JS regex sources for the content script to test against `location.href`, since Brave
/// evaluates them per URL.
pub fn collect_generichide(list_text: &str, keys: &mut BTreeSet<String>, patterns: &mut BTreeSet<String>) {
    for line in list_text.lines() {
        let line = line.trim();
        let Some(rule) = line.strip_prefix("@@") else { continue };
        let Some(dollar) = rule.rfind('$') else { continue };
        let (pattern, opts) = (&rule[..dollar], &rule[dollar + 1..]);
        let opts: Vec<&str> = opts.split(',').collect();
        if !opts.iter().any(|o| *o == "generichide" || *o == "ghide") {
            continue;
        }
        let domains: Vec<&str> = opts
            .iter()
            .filter_map(|o| o.strip_prefix("domain=").or_else(|| o.strip_prefix("from=")))
            .flat_map(|v| v.split('|'))
            .filter(|d| !d.starts_with('~'))
            .collect();
        let pattern_is_any = pattern.is_empty() || pattern == "*";
        if pattern_is_any {
            for d in domains {
                if is_key_like(d) {
                    keys.insert(d.to_ascii_lowercase());
                }
            }
            continue;
        }
        // `||host^` / `||host.*^` → keys
        if let Some(host) = pattern.strip_prefix("||").and_then(|h| h.strip_suffix('^').or(Some(h))) {
            if is_key_like(host) && domains.is_empty() {
                keys.insert(host.to_ascii_lowercase());
                continue;
            }
        }
        patterns.insert(abp_to_regex(pattern));
    }
}

fn is_key_like(h: &str) -> bool {
    let host = h.strip_suffix(".*").unwrap_or(h);
    !host.is_empty()
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        && !host.starts_with('.')
        && !host.ends_with('.')
}

/// ABP/uBO network pattern → JS RegExp source.
fn abp_to_regex(p: &str) -> String {
    let mut out = String::new();
    let mut s = p;
    if let Some(rest) = s.strip_prefix("||") {
        out.push_str(r"^[a-z][a-z0-9+.-]*://([^/?#]*\.)?");
        s = rest;
    } else if let Some(rest) = s.strip_prefix('|') {
        out.push('^');
        s = rest;
    }
    let (s, end_anchor) = match s.strip_suffix('|') {
        Some(r) => (r, true),
        None => (s, false),
    };
    for c in s.chars() {
        match c {
            '*' => out.push_str(".*"),
            '^' => out.push_str(r"(?:[^\w.%-]|$)"),
            c if r"\.+?()[]{}$/".contains(c) => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    if end_anchor {
        out.push('$');
    }
    out
}

fn url_for_key(key: &str) -> String {
    match key.strip_suffix(".*") {
        Some(entity) => format!("https://{entity}.{ENTITY_TLD}/"),
        None => format!("https://{key}/"),
    }
}

/// Extracts the per-call `try { ... } catch` blocks from an assembled script, dropping the
/// (stub) dependency prelude.
fn invocation_blocks(script: &str, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    const OPEN: &str = "try {\n";
    const CLOSE: &str = "\n} catch ( e ) { }\n";
    let Some(start) = script.find(OPEN) else { return };
    let mut rest = &script[start..];
    while let Some(body_start) = rest.strip_prefix(OPEN) {
        let Some(end) = body_start.find(CLOSE) else { break };
        let block = &body_start[..end];
        if seen.insert(block.to_string()) {
            out.push(block.to_string());
        }
        rest = &body_start[end + CLOSE.len()..];
    }
}

pub fn precompute(default_engine: &Engine, additional_engine: &Engine, keys: &BTreeSet<String>) -> Output {
    let baseline_url = "https://zz-shields-baseline.invalid/";
    let gd: BTreeSet<String> = default_engine.url_cosmetic_resources(baseline_url).hide_selectors.into_iter().collect();
    let ga: BTreeSet<String> = additional_engine.url_cosmetic_resources(baseline_url).hide_selectors.into_iter().collect();

    let mut hosts = BTreeMap::new();
    let mut scripts = BTreeMap::new();

    for key in keys {
        let url = url_for_key(key);
        let rd = default_engine.url_cosmetic_resources(&url);
        let ra = additional_engine.url_cosmetic_resources(&url);

        let hd: BTreeSet<String> = rd.hide_selectors.into_iter().collect();
        let ha: BTreeSet<String> = ra.hide_selectors.into_iter().collect();
        let generichide = rd.generichide || ra.generichide;

        let mut entry = HostEntry {
            d: hd.difference(&gd).cloned().collect(),
            a: ha.difference(&ga).cloned().collect(),
            p: rd.procedural_actions.into_iter().collect(),
            pa: ra.procedural_actions.into_iter().collect(),
            gh: generichide,
            dg: rd.generichide,
            ag: ra.generichide,
            ..Default::default()
        };
        if !rd.generichide {
            entry.du = gd.difference(&hd).cloned().collect();
        }
        if !ra.generichide {
            entry.au = ga.difference(&ha).cloned().collect();
        }
        entry.p.sort();
        entry.pa.sort();
        if !entry.is_empty() {
            hosts.insert(key.clone(), entry);
        }

        let mut blocks = vec![];
        let mut seen = HashSet::new();
        invocation_blocks(&rd.injected_script, &mut blocks, &mut seen);
        invocation_blocks(&ra.injected_script, &mut blocks, &mut seen);
        if !blocks.is_empty() {
            scripts.insert(key.clone(), blocks);
        }
    }

    Output {
        hosts,
        generic_default: gd.into_iter().collect(),
        generic_additional: ga.into_iter().collect(),
        scripts,
    }
}
