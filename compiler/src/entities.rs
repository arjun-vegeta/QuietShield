//! Concrete suffixes for `label.*` entity domains, so DNR (which has no wildcard domains) can
//! express `domain=label.*` as `initiatorDomains: [label.com, label.net, ...]`.
//!
//! Suffixes come from (a) hostnames the lists themselves mention for that label and (b) the most
//! common public suffixes across the lists. Every expanded domain is inside the entity's meaning,
//! so expansion can under-cover but never over-block.

use regex::Regex;
use std::collections::{BTreeSet, HashMap};

const FILE_EXT: &[&str] = &[
    "js", "css", "php", "html", "htm", "json", "png", "gif", "jpg", "jpeg", "svg", "txt", "xml", "mp4", "mp3",
    "webp", "woff", "woff2", "ttf", "ico", "swf", "aspx", "asp", "jsp", "cgi", "gz", "zip", "m3u8", "ts", "vtt",
    "map", "webm", "avif",
];

fn is_suffix(s: &str) -> bool {
    if FILE_EXT.contains(&s) {
        return false;
    }
    let p: Vec<&str> = s.split('.').collect();
    match p.as_slice() {
        [one] => (2..=24).contains(&one.len()) && one.bytes().all(|b| b.is_ascii_lowercase()) || one.starts_with("xn--"),
        [a, b] => a.len() <= 3 && (2..=3).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_lowercase()),
        _ => false,
    }
}

pub fn suffixes(list_text: &str, top_n: usize) -> HashMap<String, Vec<String>> {
    let opt = Regex::new(r"(?:domain|from|to)=([^,\s$]+)").unwrap();
    let cosmetic = Regex::new(r"(?m)^([^#\s]*?)#[@?$%]?#").unwrap();
    let host = Regex::new(r"[a-z0-9][-a-z0-9.]*\.[a-z][-a-z0-9]{1,62}").unwrap();

    let mut entities = BTreeSet::new();
    let mut add_entity = |d: &str| {
        if let Some(e) = d.trim_start_matches('~').strip_suffix(".*") {
            if !e.is_empty() {
                entities.insert(e.to_ascii_lowercase());
            }
        }
    };
    for c in opt.captures_iter(list_text) {
        c[1].split('|').for_each(&mut add_entity);
    }
    for c in cosmetic.captures_iter(list_text) {
        c[1].split(',').for_each(&mut add_entity);
    }

    let lower = list_text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut suffix_freq: HashMap<String, usize> = HashMap::new();
    let mut by_label: HashMap<String, BTreeSet<String>> = HashMap::new();
    for m in host.find_iter(&lower) {
        // Skip wildcard hosts like `foo.bar*`: emulates the `(?![-a-z0-9.]*\*)` lookahead.
        let mut j = m.end();
        while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'.') {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'*' {
            continue;
        }
        let labels: Vec<&str> = m.as_str().split('.').collect();
        for k in (1..labels.len()).rev() {
            let suf = labels[k..].join(".");
            if !is_suffix(&suf) {
                continue;
            }
            if k == labels.len() - 1 {
                *suffix_freq.entry(suf.clone()).or_default() += 1;
            }
            for s in 0..k {
                by_label.entry(labels[s..k].join(".")).or_default().insert(suf.clone());
            }
        }
    }
    let mut top: Vec<(String, usize)> = suffix_freq.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let top: Vec<String> = top.into_iter().take(top_n).map(|(s, _)| s).collect();

    entities
        .into_iter()
        .map(|e| {
            let mut set: BTreeSet<String> = by_label.remove(&e).unwrap_or_default();
            set.extend(top.iter().cloned());
            (e, set.into_iter().collect())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn collects_observed_and_top_suffixes() {
        let text = "||yts.mx^\n||yts.lt/ads.js\n*/clock.js$script,domain=yts.*\nfoo.com##.ad\nbar.com##.ad\n";
        let m = super::suffixes(text, 1);
        assert_eq!(m["yts"], vec!["com".to_string(), "lt".to_string(), "mx".to_string()]);
    }
}
