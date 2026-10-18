//! Converts adblock-rust `NetworkFilter`s into Chrome `declarativeNetRequest` rules.
//!
//! The pattern handling mirrors `adblock::content_blocking` (the Safari exporter), but emits
//! DNR `urlFilter` syntax, which already understands ABP anchors (`||`, `|`, `^`, `*`).
//!
//! Brave's two-engine "Standard" semantics are reproduced by splitting each list group into a
//! standard ruleset plus an "aggressive" complement ruleset: lists flagged with
//! `first_party_protections` only block third-party requests in Standard mode.

use adblock::filters::network::{FilterPart, NetworkFilter, NetworkFilterMask, NetworkFilterMaskHelper};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

// Priority ladder, low to high. Within the same priority DNR ranks
// allow > block > upgradeScheme > redirect, which we rely on below.
pub const P_REMOVEPARAM: i64 = 1;
pub const P_CSP: i64 = 1;
pub const P_BLOCK: i64 = 10;
pub const P_REDIRECT: i64 = 11; // + resource priority (0..=8)
pub const P_ALLOW: i64 = 30;
pub const P_IMPORTANT_BLOCK: i64 = 40;
pub const P_IMPORTANT_REDIRECT: i64 = 41; // + resource priority (0..=8)

#[derive(Default, Debug)]
pub struct Stats {
    pub converted: usize,
    pub skipped: BTreeMap<&'static str, usize>,
}

impl Stats {
    fn skip(&mut self, reason: &'static str) {
        *self.skipped.entry(reason).or_default() += 1;
    }
}

/// Output for a single list group.
#[derive(Default)]
pub struct GroupRules {
    /// Rules active in Standard mode.
    pub standard: Vec<Value>,
    /// Extra rules only active in Aggressive mode (first-party blocking, main-frame blocking).
    pub aggressive: Vec<Value>,
    /// Regex rules; must be installed as dynamic rules after `isRegexSupported()` checks.
    pub regex: Vec<Value>,
}

pub struct Converter<'r> {
    /// Maps every redirect resource name and alias to its canonical file name.
    pub redirect_aliases: &'r HashMap<String, String>,
    /// Canonical redirect resources actually referenced by emitted rules.
    pub used_redirects: BTreeSet<String>,
    pub stats: Stats,
}

/// Options section of the raw filter line, split into `key[=value]` entries.
fn raw_options(raw: &str, is_regex_pattern: bool) -> Vec<(String, Option<String>)> {
    let opts = if is_regex_pattern {
        // `/regex/$opts` — options start after the closing slash.
        match raw.rfind("/$") {
            Some(i) => &raw[i + 2..],
            None => return vec![],
        }
    } else {
        match raw.rfind('$') {
            Some(i) => &raw[i + 1..],
            None => return vec![],
        }
    };
    opts.split(',')
        .map(|o| match o.split_once('=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), Some(v.to_string())),
            None => (o.trim().to_ascii_lowercase(), None),
        })
        .collect()
}

/// Splits a `|`-separated domain option into (included, excluded), dropping entity
/// (`example.*`) and regex domains, which DNR cannot express.
fn split_domains(value: &str) -> (Vec<String>, Vec<String>, usize) {
    let mut inc = vec![];
    let mut exc = vec![];
    let mut dropped = 0;
    for d in value.split('|') {
        let (neg, d) = match d.strip_prefix('~') {
            Some(d) => (true, d),
            None => (false, d),
        };
        let d = d.trim().to_ascii_lowercase();
        if d.is_empty() || d.ends_with(".*") || d.starts_with('/') || !d.is_ascii() {
            dropped += 1;
            continue;
        }
        if neg { exc.push(d) } else { inc.push(d) }
    }
    (inc, exc, dropped)
}

fn resource_types(mask: NetworkFilterMask, include_document: bool) -> Option<Vec<&'static str>> {
    use NetworkFilterMask as M;
    let all = M::FROM_NETWORK_TYPES;
    let types = mask & all;
    if types == all && !(include_document && mask.contains(M::FROM_DOCUMENT)) {
        return None; // DNR default: everything except main_frame
    }
    let mut out = vec![];
    let table = [
        (M::FROM_IMAGE, "image"),
        (M::FROM_MEDIA, "media"),
        (M::FROM_OBJECT, "object"),
        (M::FROM_OTHER, "other"),
        (M::FROM_PING, "ping"),
        (M::FROM_SCRIPT, "script"),
        (M::FROM_STYLESHEET, "stylesheet"),
        (M::FROM_SUBDOCUMENT, "sub_frame"),
        (M::FROM_WEBSOCKET, "websocket"),
        (M::FROM_XMLHTTPREQUEST, "xmlhttprequest"),
        (M::FROM_FONT, "font"),
    ];
    for (bit, name) in table {
        if mask.contains(bit) {
            out.push(name);
        }
    }
    if include_document && mask.contains(M::FROM_DOCUMENT) {
        out.push("main_frame");
    }
    Some(out)
}

enum Pattern {
    Url(String),
    Regex(String),
    /// `||host^` with nothing else: expressed through `requestDomains` so rules can be merged.
    Host(String),
    Any,
}

fn pattern(f: &NetworkFilter) -> Result<Pattern, &'static str> {
    let m = f.mask;
    let part = match &f.filter {
        FilterPart::Simple(s) => Some(s.as_ref()),
        FilterPart::Empty => None,
        FilterPart::AnyOf(_) => return Err("optimized-filter"),
    };
    if m.contains(NetworkFilterMask::IS_COMPLETE_REGEX) {
        let re = part.ok_or("empty-regex")?;
        let re = re.strip_prefix('/').and_then(|r| r.strip_suffix('/')).ok_or("bad-regex")?;
        return Ok(Pattern::Regex(re.to_string()));
    }
    let mut url = String::new();
    match f.hostname.as_deref() {
        Some(host) if m.is_hostname_anchor() => {
            if part.is_none() && !m.contains(NetworkFilterMask::IS_HOSTNAME_REGEX) {
                if m.is_right_anchor() {
                    return Ok(Pattern::Host(host.to_string()));
                }
                url = format!("||{host}");
            } else {
                url.push_str("||");
                url.push_str(host);
                if m.contains(NetworkFilterMask::IS_HOSTNAME_REGEX) || !m.is_left_anchor() {
                    url.push('*');
                }
                url.push_str(part.unwrap_or(""));
                if m.is_right_anchor() {
                    url.push('|');
                }
            }
        }
        _ => {
            let scheme_only = m.for_http() != m.for_https();
            match part {
                None if scheme_only => {
                    url = if m.for_https() { "|https://".into() } else { "|http://".into() };
                }
                None => return Ok(Pattern::Any),
                Some(p) => {
                    if m.is_left_anchor() {
                        url.push('|');
                    }
                    url.push_str(p);
                    if m.is_right_anchor() {
                        url.push('|');
                    }
                }
            }
        }
    }
    if !url.is_ascii() {
        return Err("non-ascii");
    }
    if url.starts_with("||*") {
        url = url[2..].to_string();
    }
    Ok(Pattern::Url(url))
}

/// Resource priority suffix, e.g. `$redirect=noopjs:5`.
fn split_redirect(value: &str) -> (&str, i64) {
    match value.rsplit_once(':') {
        Some((name, prio)) if prio.chars().all(|c| c.is_ascii_digit()) && !prio.is_empty() => {
            (name, prio.parse::<i64>().unwrap_or(0).clamp(0, 8))
        }
        _ => (value, 0),
    }
}

impl<'r> Converter<'r> {
    pub fn new(redirect_aliases: &'r HashMap<String, String>) -> Self {
        Converter { redirect_aliases, used_redirects: BTreeSet::new(), stats: Stats::default() }
    }

    /// Converts one filter. `fpp` = the list group has Brave's `first_party_protections`.
    pub fn convert(&mut self, f: &NetworkFilter, fpp: bool, out: &mut GroupRules) {
        let raw = f.raw_line.as_deref().unwrap_or_default();
        let m = f.mask;

        if f.is_generic_hide() {
            return self.stats.skip("generichide (handled by cosmetic engine)");
        }
        if m.is_exception() && (f.is_csp() || f.is_redirect() || f.is_removeparam()) {
            return self.stats.skip("modifier exception");
        }
        if f.is_redirect() && !f.also_block_redirect() {
            return self.stats.skip("redirect-rule");
        }
        if f.is_removeparam() && fpp {
            // brave-core discards `rewritten_url` results from the default engine.
            return self.stats.skip("removeparam in default engine (ignored by Brave)");
        }

        let pat = match pattern(f) {
            Ok(p) => p,
            Err(reason) => return self.stats.skip(reason),
        };

        let opts = raw_options(raw, m.contains(NetworkFilterMask::IS_COMPLETE_REGEX));
        let mut cond = Map::new();

        // Initiator (`domain=` / `from=`) and request (`to=`) domain constraints.
        for (key, val) in &opts {
            let Some(val) = val else { continue };
            let (inc_key, exc_key) = match key.as_str() {
                "domain" | "from" => ("initiatorDomains", "excludedInitiatorDomains"),
                "to" => ("requestDomains", "excludedRequestDomains"),
                _ => continue,
            };
            let (inc, exc, dropped) = split_domains(val);
            if inc.is_empty() && exc.is_empty() && dropped > 0 {
                return self.stats.skip("only entity/regex domains");
            }
            if inc.is_empty() && dropped > 0 && val.split('|').any(|d| !d.starts_with('~')) {
                // All positive domains were inexpressible; the rule would become too broad.
                return self.stats.skip("only entity/regex domains");
            }
            if !inc.is_empty() {
                cond.insert(inc_key.into(), json!(inc));
            }
            if !exc.is_empty() {
                cond.insert(exc_key.into(), json!(exc));
            }
        }

        let explicit_document = opts.iter().any(|(k, _)| k == "document" || k == "doc");

        match &pat {
            Pattern::Url(u) => {
                cond.insert("urlFilter".into(), json!(u));
            }
            Pattern::Regex(r) => {
                cond.insert("regexFilter".into(), json!(r));
            }
            Pattern::Host(h) => {
                if cond.contains_key("requestDomains") {
                    cond.insert("urlFilter".into(), json!(format!("||{h}^")));
                } else {
                    cond.insert("requestDomains".into(), json!([h]));
                }
            }
            Pattern::Any => {}
        }
        if m.match_case() {
            cond.insert("isUrlFilterCaseSensitive".into(), json!(true));
        }

        // Request methods ($method=)
        let methods: Vec<&str> = [
            (NetworkFilterMask::FROM_GET, "get"),
            (NetworkFilterMask::FROM_HEAD, "head"),
            (NetworkFilterMask::FROM_POST, "post"),
        ]
        .into_iter()
        .filter(|(b, _)| m.contains(*b))
        .map(|(_, n)| n)
        .collect();
        if !methods.is_empty() && methods.len() < 3 {
            cond.insert("requestMethods".into(), json!(methods));
        }

        let third = m.third_party();
        let first = m.first_party();
        if third && !first {
            cond.insert("domainType".into(), json!("thirdParty"));
        } else if first && !third {
            cond.insert("domainType".into(), json!("firstParty"));
        }

        let is_regex = matches!(pat, Pattern::Regex(_));
        let push = |out: &mut GroupRules, rule: Value, aggressive_only: bool| {
            if is_regex {
                if !aggressive_only {
                    out.regex.push(rule);
                }
            } else if aggressive_only {
                out.aggressive.push(rule);
            } else {
                out.standard.push(rule);
            }
        };

        // ---- Exceptions --------------------------------------------------------------
        if m.is_exception() {
            if explicit_document {
                let mut c = cond.clone();
                c.remove("domainType");
                c.insert("resourceTypes".into(), json!(["main_frame", "sub_frame"]));
                push(out, json!({"priority": P_ALLOW, "action": {"type": "allowAllRequests"}, "condition": c}), false);
            } else {
                if let Some(t) = resource_types(m, false) {
                    if t.is_empty() {
                        return self.stats.skip("exception with no network types");
                    }
                    cond.insert("resourceTypes".into(), json!(t));
                }
                push(out, json!({"priority": P_ALLOW, "action": {"type": "allow"}, "condition": cond}), false);
            }
            self.stats.converted += 1;
            return;
        }

        // ---- $removeparam ---------------------------------------------------------------
        if f.is_removeparam() {
            let param = f.modifier_option.unwrap_or_default();
            if param.is_empty() || param.starts_with('/') {
                return self.stats.skip("removeparam regex/all");
            }
            let mut c = cond.clone();
            c.insert(
                "resourceTypes".into(),
                json!(resource_types(m, true).unwrap_or_else(|| vec!["main_frame", "sub_frame", "xmlhttprequest"])),
            );
            c.insert("requestMethods".into(), json!(["get", "head", "options"]));
            push(
                out,
                json!({"priority": P_REMOVEPARAM, "action": {"type": "redirect", "redirect": {"transform": {"queryTransform": {"removeParams": [param]}}}}, "condition": c}),
                false,
            );
            self.stats.converted += 1;
            return;
        }

        // ---- $csp ---------------------------------------------------------------------------
        if f.is_csp() {
            let Some(csp) = f.modifier_option.filter(|c| !c.is_empty()) else {
                return self.stats.skip("csp without value");
            };
            let mut c = cond.clone();
            c.insert("resourceTypes".into(), json!(["main_frame", "sub_frame"]));
            push(
                out,
                json!({"priority": P_CSP, "action": {"type": "modifyHeaders", "responseHeaders": [{"header": "content-security-policy", "operation": "append", "value": csp}]}, "condition": c}),
                false,
            );
            self.stats.converted += 1;
            return;
        }

        // ---- Block / redirect -----------------------------------------------------------------
        let important = m.is_important();
        let action = if f.is_redirect() {
            let (name, res_prio) = split_redirect(f.modifier_option.unwrap_or_default());
            let Some(file) = self.redirect_aliases.get(name) else {
                return self.stats.skip("unknown redirect resource");
            };
            self.used_redirects.insert(file.clone());
            let base = if important { P_IMPORTANT_REDIRECT } else { P_REDIRECT };
            (base + res_prio, json!({"type": "redirect", "redirect": {"extensionPath": format!("/build/war/{file}")}}))
        } else {
            (if important { P_IMPORTANT_BLOCK } else { P_BLOCK }, json!({"type": "block"}))
        };

        // Sub-resource part (never main_frame; Brave's Standard mode never blocks top-level
        // navigations, Aggressive mode shows an interstitial — we emit main_frame blocks there).
        let types = resource_types(m, false);
        if !matches!(&types, Some(t) if t.is_empty()) {
            let mut c = cond.clone();
            if let Some(t) = &types {
                c.insert("resourceTypes".into(), json!(t));
            }
            let rule = json!({"priority": action.0, "action": action.1, "condition": c});
            if fpp && !important {
                // Standard: drop first-party matches. Aggressive: add them back.
                let dt = c.get("domainType").and_then(|v| v.as_str()).map(str::to_owned);
                match dt.as_deref() {
                    Some("thirdParty") => push(out, rule, false),
                    Some("firstParty") => push(out, rule, true),
                    _ => {
                        let mut std_rule = rule.clone();
                        std_rule["condition"]["domainType"] = json!("thirdParty");
                        push(out, std_rule, false);
                        let mut aggr_rule = rule;
                        aggr_rule["condition"]["domainType"] = json!("firstParty");
                        push(out, aggr_rule, true);
                    }
                }
            } else {
                push(out, rule, false);
            }
        }

        // Main-frame (document) blocking: Aggressive mode only.
        if m.contains(NetworkFilterMask::FROM_DOCUMENT) && !f.is_redirect() && (explicit_document || matches!(pat, Pattern::Host(_))) {
            let mut c = cond.clone();
            c.remove("domainType");
            c.insert("resourceTypes".into(), json!(["main_frame"]));
            push(out, json!({"priority": action.0, "action": {"type": "block"}, "condition": c}), true);
        }
        self.stats.converted += 1;
    }
}

/// Merges rules that only differ by their `requestDomains` (the uBOL trick that turns tens of
/// thousands of `||host^` filters into a few hundred DNR rules), then assigns ids.
pub fn finalize(rules: Vec<Value>, first_id: i64) -> Vec<Value> {
    let mut merged: Vec<Value> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut seen: HashMap<String, ()> = HashMap::new();
    for mut rule in rules {
        let full_key = rule.to_string();
        if seen.insert(full_key, ()).is_some() {
            continue; // exact duplicate
        }
        let domains = rule["condition"].as_object_mut().and_then(|c| {
            if c.contains_key("urlFilter") || c.contains_key("regexFilter") {
                None
            } else {
                c.remove("requestDomains")
            }
        });
        match domains {
            Some(Value::Array(d)) => {
                let key = rule.to_string();
                if let Some(&i) = index.get(&key) {
                    merged[i]["condition"]["requestDomains"].as_array_mut().unwrap().extend(d);
                } else {
                    rule["condition"]["requestDomains"] = Value::Array(d);
                    index.insert(key, merged.len());
                    merged.push(rule);
                }
            }
            _ => merged.push(rule),
        }
    }
    for (i, rule) in merged.iter_mut().enumerate() {
        if let Some(Value::Array(d)) = rule["condition"].get_mut("requestDomains") {
            let set: BTreeSet<String> = d.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
            *d = prune_subdomains(set).into_iter().map(Value::String).collect();
        }
        rule["id"] = json!(first_id + i as i64);
    }
    merged
}

/// Removes entries already covered by a parent domain in the same set.
fn prune_subdomains(set: BTreeSet<String>) -> Vec<String> {
    set.iter()
        .filter(|d| {
            let mut rest = d.as_str();
            while let Some((_, parent)) = rest.split_once('.') {
                if set.contains(parent) {
                    return false;
                }
                rest = parent;
            }
            true
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use adblock::lists::{parse_filter, ParseOptions, ParsedLine};

    fn convert(line: &str, fpp: bool) -> GroupRules {
        let aliases: HashMap<String, String> = [("noopjs", "noop.js"), ("noop.js", "noop.js")]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        let mut conv = Converter::new(&aliases);
        let mut out = GroupRules::default();
        match parse_filter(line, true, ParseOptions::default()).unwrap() {
            ParsedLine::Network(f) => conv.convert(&f, fpp, &mut out),
            _ => panic!("not a network filter"),
        }
        out
    }

    #[test]
    fn hostname_rule_uses_request_domains_and_never_blocks_main_frame_in_standard() {
        let r = convert("||ads.example.com^", false);
        assert_eq!(r.standard.len(), 1);
        assert_eq!(r.standard[0]["condition"]["requestDomains"], json!(["ads.example.com"]));
        assert!(r.standard[0]["condition"].get("resourceTypes").is_none());
        // Aggressive mode adds a main_frame block (Brave shows an interstitial there).
        assert_eq!(r.aggressive.len(), 1);
        assert_eq!(r.aggressive[0]["condition"]["resourceTypes"], json!(["main_frame"]));
    }

    #[test]
    fn first_party_protection_splits_standard_and_aggressive() {
        let r = convert("||cdn.example.com/ads.js", true);
        assert_eq!(r.standard[0]["condition"]["domainType"], json!("thirdParty"));
        assert_eq!(r.aggressive[0]["condition"]["domainType"], json!("firstParty"));
        // $important bypasses first-party protection.
        let r = convert("||cdn.example.com/ads.js$important", true);
        assert!(r.standard[0]["condition"].get("domainType").is_none());
        assert_eq!(r.standard[0]["priority"], json!(P_IMPORTANT_BLOCK));
    }

    #[test]
    fn domains_options_and_patterns() {
        let r = convert("/banner/*/img^$script,domain=a.com|~b.a.com", false);
        let c = &r.standard[0]["condition"];
        assert_eq!(c["urlFilter"], json!("/banner/*/img^"));
        assert_eq!(c["initiatorDomains"], json!(["a.com"]));
        assert_eq!(c["excludedInitiatorDomains"], json!(["b.a.com"]));
        assert_eq!(c["resourceTypes"], json!(["script"]));
    }

    #[test]
    fn exceptions_redirects_removeparam_csp() {
        let r = convert("@@||good.com^$document", false);
        assert_eq!(r.standard[0]["action"]["type"], json!("allowAllRequests"));
        let r = convert("||x.com/a.js$script,redirect=noopjs", false);
        assert_eq!(r.standard[0]["action"]["redirect"]["extensionPath"], json!("/build/war/noop.js"));
        let r = convert("||x.com^$removeparam=utm_source", false);
        assert_eq!(r.standard[0]["action"]["redirect"]["transform"]["queryTransform"]["removeParams"], json!(["utm_source"]));
        let r = convert("||t.com^$csp=script-src 'none'", false);
        assert_eq!(r.standard[0]["action"]["responseHeaders"][0]["value"], json!("script-src 'none'"));
    }

    #[test]
    fn regex_rules_go_to_dynamic_list() {
        let r = convert(r"/^https?:\/\/[a-z]+\.com\/ad/$script", false);
        assert!(r.standard.is_empty());
        assert_eq!(r.regex.len(), 1);
    }

    #[test]
    fn finalize_merges_host_rules() {
        let mut rules = convert("||a.com^", false).standard;
        rules.extend(convert("||b.com^", false).standard);
        rules.extend(convert("||sub.a.com^", false).standard);
        let merged = finalize(rules, 1);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["condition"]["requestDomains"], json!(["a.com", "b.com"]));
    }
}
