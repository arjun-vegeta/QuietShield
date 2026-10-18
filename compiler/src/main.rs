//! shields-compiler: builds the data an MV3 extension needs to behave like Brave Shields.
//!
//! Inputs (see scripts/fetch.mjs and scripts/build-resources.mjs):
//!   data/list_catalog.json, data/lists/<uuid>/*.txt, data/brave-resources.json,
//!   data/ubo-scriptlets.json, data/ubo-scriptlet-fn-names.json, vendor/uBlock
//! Output: extension/build/

mod cosmetic;
mod dnr;

use adblock::lists::{parse_filter, FilterSet, ParseOptions, ParsedLine};
use adblock::resources::{PermissionMask, Resource, ResourceType};
use adblock::Engine;
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Deserialize)]
struct CatalogEntry {
    uuid: String,
    title: String,
    #[serde(default)]
    default_enabled: bool,
    #[serde(default)]
    first_party_protections: bool,
    #[serde(default)]
    permission_mask: u8,
    #[serde(default)]
    platforms: Option<Vec<String>>,
    sources: Vec<Value>,
}

struct Group {
    name: String,
    title: String,
    fpp: bool,
    permissions: PermissionMask,
    text: String,
}

fn short_name(uuid: &str) -> String {
    match &uuid[..8.min(uuid.len())] {
        "default" => "default".into(),
        "4D715457" => "privacy".into(),
        "E99CBD02" => "firstparty".into(),
        "AC023D22" => "cookies".into(),
        "2F3DCE16" => "mobile".into(),
        other => other.to_ascii_lowercase(),
    }
}

fn load_groups(data: &Path) -> Result<Vec<Group>> {
    let catalog: Vec<CatalogEntry> = serde_json::from_str(&fs::read_to_string(data.join("list_catalog.json"))?)?;
    let mut groups = vec![];
    for e in catalog {
        let mobile_only = e.platforms.as_ref().is_some_and(|p| !p.is_empty() && p.iter().all(|p| p == "IOS" || p == "ANDROID"));
        if !e.default_enabled || mobile_only {
            continue;
        }
        let mut text = String::new();
        for i in 0..e.sources.len() {
            let path = data.join("lists").join(&e.uuid).join(format!("{i}.txt"));
            text.push_str(&fs::read_to_string(&path).with_context(|| format!("{}", path.display()))?);
            text.push('\n');
        }
        groups.push(Group {
            name: short_name(&e.uuid),
            title: e.title,
            fpp: e.first_party_protections,
            permissions: PermissionMask::from_bits(e.permission_mask),
            text,
        });
    }
    Ok(groups)
}

struct Resources {
    real: Vec<Resource>,
    stub: Vec<Resource>,
    /// name/alias -> canonical redirect resource name
    redirect_aliases: HashMap<String, String>,
}

fn load_resources(root: &Path) -> Result<Resources> {
    let ubo = root.join("vendor/uBlock");
    let war = adblock::resources::resource_assembler::assemble_web_accessible_resources(
        &ubo.join("src/web_accessible_resources"),
        &ubo.join("src/js/redirect-resources.js"),
    )
    .into_iter()
    .filter(|r| r.name != "google-ima-dai.js") // excluded by brave-core-crx-packager too
    .collect::<Vec<_>>();
    let brave: Vec<Resource> = serde_json::from_str(&fs::read_to_string(root.join("data/brave-resources.json"))?)?;
    let ubo_scriptlets: Vec<Resource> = serde_json::from_str(&fs::read_to_string(root.join("data/ubo-scriptlets.json"))?)?;
    let fn_names: HashMap<String, String> = serde_json::from_str(&fs::read_to_string(root.join("data/ubo-scriptlet-fn-names.json"))?)?;

    let mut redirect_aliases = HashMap::new();
    for r in war.iter().chain(brave.iter()) {
        if r.kind.supports_redirect() {
            redirect_aliases.insert(r.name.clone(), r.name.clone());
            for a in &r.aliases {
                redirect_aliases.insert(a.clone(), r.name.clone());
            }
        }
    }

    let stub_ubo: Vec<Resource> = ubo_scriptlets
        .iter()
        .map(|r| {
            let fn_name = fn_names.get(&r.name).cloned().unwrap_or_default();
            Resource {
                name: r.name.clone(),
                aliases: r.aliases.clone(),
                kind: r.kind.clone(),
                content: B64.encode(format!("function {fn_name}(){{}}")),
                dependencies: vec![],
                permission: r.permission,
            }
        })
        .collect();

    let mut real = war.clone();
    real.extend(brave.iter().cloned());
    real.extend(ubo_scriptlets);
    let mut stub = war;
    stub.extend(brave);
    stub.extend(stub_ubo);
    Ok(Resources { real, stub, redirect_aliases })
}

fn write_json(path: &Path, v: &impl serde::Serialize) -> Result<usize> {
    fs::create_dir_all(path.parent().unwrap())?;
    let s = serde_json::to_string(v)?;
    fs::write(path, &s)?;
    Ok(s.len())
}

fn main() -> Result<()> {
    let root: PathBuf = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".."));
    let data = root.join("data");
    let out = root.join("extension/build");
    if out.exists() {
        fs::remove_dir_all(&out)?;
    }
    fs::create_dir_all(&out)?;

    let t0 = Instant::now();
    let groups = load_groups(&data)?;
    let res = load_resources(&root)?;
    println!("{} list groups, {} resources ({:?})", groups.len(), res.real.len(), t0.elapsed());

    // ---------------------------------------------------------------- network → DNR
    let mut parsed: Vec<Vec<adblock::filters::network::NetworkFilter>> = vec![];
    let mut bad_ids = HashSet::new();
    let mut keys = BTreeSet::new();
    let mut ghide_d = BTreeSet::new();
    let mut ghide_a = BTreeSet::new();
    let mut parse_errors = 0usize;
    for g in &groups {
        let opts = ParseOptions { permissions: g.permissions, ..Default::default() };
        let mut filters = vec![];
        for line in g.text.lines() {
            match parse_filter(line, true, opts) {
                Ok(ParsedLine::Network(f)) => {
                    if f.is_badfilter() {
                        bad_ids.insert(f.get_id());
                    } else {
                        filters.push(f);
                    }
                }
                Ok(ParsedLine::Cosmetic(_)) => {}
                Err(adblock::lists::FilterParseError::Empty) | Err(adblock::lists::FilterParseError::Unsupported) => {}
                Err(_) => parse_errors += 1,
            }
        }
        cosmetic::collect_keys(&g.text, &mut keys);
        cosmetic::collect_generichide(&g.text, &mut keys, if g.fpp { &mut ghide_d } else { &mut ghide_a });
        parsed.push(filters);
    }

    let mut conv = dnr::Converter::new(&res.redirect_aliases);
    let mut manifest_rulesets = vec![];
    let mut regex_rules = vec![];
    let mut summary = BTreeMap::new();
    for (g, filters) in groups.iter().zip(parsed.iter()) {
        let mut rules = dnr::GroupRules::default();
        for f in filters {
            if bad_ids.contains(&f.get_id()) {
                conv.stats.converted += 0;
                continue;
            }
            conv.convert(f, g.fpp, &mut rules);
        }
        let standard = dnr::finalize(rules.standard, 1);
        let aggressive = dnr::finalize(rules.aggressive, 1);
        for mut r in rules.regex {
            r["group"] = json!(g.name);
            regex_rules.push(r);
        }
        summary.insert(g.name.clone(), json!({"title": g.title, "filters": filters.len(), "standard": standard.len(), "aggressive": aggressive.len()}));
        write_json(&out.join(format!("rules/{}.json", g.name)), &standard)?;
        manifest_rulesets.push(json!({"id": g.name, "enabled": true, "path": format!("build/rules/{}.json", g.name)}));
        if !aggressive.is_empty() {
            write_json(&out.join(format!("rules/{}-aggressive.json", g.name)), &aggressive)?;
            manifest_rulesets.push(json!({"id": format!("{}-aggressive", g.name), "enabled": false, "path": format!("build/rules/{}-aggressive.json", g.name)}));
        }
    }
    for (i, r) in regex_rules.iter_mut().enumerate() {
        r["id"] = json!(1_000_000 + i as i64);
    }
    write_json(&out.join("rules/regex.json"), &regex_rules)?;
    write_json(&out.join("rulesets.json"), &manifest_rulesets)?;

    // Redirect resources actually referenced by rules → web_accessible_resources
    let by_name: HashMap<&str, &Resource> = res.real.iter().map(|r| (r.name.as_str(), r)).collect();
    fs::create_dir_all(out.join("war"))?;
    for name in &conv.used_redirects {
        let r = by_name[name.as_str()];
        if matches!(r.kind, ResourceType::Mime(_)) {
            fs::write(out.join("war").join(name), B64.decode(&r.content)?)?;
        }
    }
    println!(
        "DNR: {} filters converted, {} badfilter'd ids, {} parse errors, {} regex rules, {} redirect resources ({:?})",
        conv.stats.converted, bad_ids.len(), parse_errors, regex_rules.len(), conv.used_redirects.len(), t0.elapsed()
    );
    for (reason, n) in &conv.stats.skipped {
        println!("  skipped {n:>6}  {reason}");
    }

    // ---------------------------------------------------------------- cosmetic engines
    let mut default_set = FilterSet::new(false);
    let mut additional_set = FilterSet::new(false);
    for g in &groups {
        let opts = ParseOptions { permissions: g.permissions, ..Default::default() };
        if g.fpp { &mut default_set } else { &mut additional_set }.add_filter_list(g.text.clone(), opts);
    }
    let mut default_engine = Engine::new_with_filter_set(default_set);
    let mut additional_engine = Engine::new_with_filter_set(additional_set);
    // The service worker's WebAssembly engine data is produced by scripts/build-engines.mjs
    // inside wasm itself (serialized hash tables aren't portable from 64-bit native to wasm32).
    default_engine.use_resources(res.stub.clone());
    additional_engine.use_resources(res.stub.clone());
    let pre = cosmetic::precompute(&default_engine, &additional_engine, &keys);
    println!("cosmetic: {} keys, {} host entries, {} scriptlet hosts, {} generic default, {} generic additional ({:?})",
        keys.len(), pre.hosts.len(), pre.scripts.len(), pre.generic_default.len(), pre.generic_additional.len(), t0.elapsed());

    // Most-specific-key lookups need explicit (possibly empty) entries for keys whose ancestors
    // have data, otherwise a `#@#` on a subdomain would fall through to the parent's rules.
    let mut hosts = pre.hosts;
    let mut scripts = pre.scripts;
    for key in &keys {
        let ancestors = ancestors(key);
        if !hosts.contains_key(key) && ancestors.iter().any(|a| hosts.contains_key(a)) {
            hosts.insert(key.clone(), cosmetic::HostEntry::default());
        }
        if !scripts.contains_key(key) && ancestors.iter().any(|a| scripts.contains_key(a)) {
            scripts.insert(key.clone(), vec![]);
        }
    }
    let n = write_json(&out.join("cosmetic/hosts.json"), &hosts)?;
    let generic = json!({"d": pre.generic_default, "a": pre.generic_additional, "ghd": ghide_d, "gha": ghide_a});
    println!("generichide URL patterns: {} default, {} additional", ghide_d.len(), ghide_a.len());
    fs::write(out.join("cosmetic/generic.js"), format!("globalThis.SHIELDS_GENERIC={};\n", generic))?;
    println!("hosts.json {} KB", n / 1024);

    // ---------------------------------------------------------------- scriptlet bundles
    let lib = load_lib(&root)?;
    let (bundles, entity_bundle) = scriptlet_bundles(&lib, &scripts);
    fs::create_dir_all(out.join("scriptlets"))?;
    let mut shard_index = vec![];
    let mut total = 0;
    for b in &bundles {
        fs::write(root.join("extension").join(&b.file), &b.code)?;
        total += b.code.len();
        shard_index.push(json!({"file": b.file, "matches": b.matches}));
    }
    fs::write(root.join("extension").join(&entity_bundle.file), &entity_bundle.code)?;
    write_json(&out.join("scriptlets/shards.json"), &shard_index)?;
    write_json(&out.join("scriptlets/entity-globs.json"), &entity_bundle.matches)?;
    println!("scriptlets: {} shards, {} KB total (avg {} KB), entity.js {} KB with {} globs",
        bundles.len(), total / 1024, total / 1024 / bundles.len().max(1), entity_bundle.code.len() / 1024, entity_bundle.matches.len());

    write_json(&out.join("summary.json"), &json!({
        "groups": summary,
        "regexRules": regex_rules.len(),
        "cosmeticHosts": hosts.len(),
        "scriptletHosts": scripts.len(),
        "skipped": conv.stats.skipped,
    }))?;
    println!("done in {:?}", t0.elapsed());
    Ok(())
}

fn ancestors(key: &str) -> Vec<String> {
    let mut out = vec![];
    if key.ends_with(".*") {
        return out;
    }
    let mut rest = key;
    while let Some((_, parent)) = rest.split_once('.') {
        out.push(parent.to_string());
        rest = parent;
    }
    out
}

/// Number of hostname shards for the MAIN-world scriptlet bundles.
const SHARDS: u64 = 32;

pub struct ScriptletLib {
    /// fn name -> source
    sources: HashMap<String, String>,
    /// fn name -> fn names it depends on
    deps: HashMap<String, Vec<String>>,
}

fn load_lib(root: &Path) -> Result<ScriptletLib> {
    let ubo: Vec<Resource> = serde_json::from_str(&fs::read_to_string(root.join("data/ubo-scriptlets.json"))?)?;
    let fn_names: HashMap<String, String> = serde_json::from_str(&fs::read_to_string(root.join("data/ubo-scriptlet-fn-names.json"))?)?;
    let mut sources = HashMap::new();
    let mut deps = HashMap::new();
    for r in ubo {
        let f = fn_names[&r.name].clone();
        sources.insert(f.clone(), String::from_utf8(B64.decode(&r.content)?)?);
        deps.insert(f, r.dependencies.iter().filter_map(|d| fn_names.get(d).cloned()).collect());
    }
    Ok(ScriptletLib { sources, deps })
}

/// First label of the registrable domain ("news.example.co.uk" -> "example").
fn site_label(key: &str) -> String {
    if let Some(entity) = key.strip_suffix(".*") {
        return entity.rsplit('.').next().unwrap_or(entity).to_string();
    }
    let domain = adblock::url_parser::parse_url(&format!("https://{key}/"))
        .map(|u| u.domain().to_string())
        .unwrap_or_else(|| key.to_string());
    domain.split('.').next().unwrap_or(&domain).to_string()
}

fn shard_of(label: &str) -> u64 {
    // FNV-1a, stable across builds
    let mut h: u64 = 0xcbf29ce484222325;
    for b in label.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h % SHARDS
}

struct Bundle {
    file: String,
    code: String,
    matches: Vec<String>,
}

fn emit_bundle(lib: &ScriptletLib, entries: &BTreeMap<String, Option<&Vec<String>>>) -> String {
    // Unique invocation blocks, referenced by index from each host.
    let mut block_ids: HashMap<&str, usize> = HashMap::new();
    let mut blocks: Vec<&str> = vec![];
    let mut used_fns: BTreeSet<String> = BTreeSet::new();
    for v in entries.values().flatten() {
        for b in v.iter() {
            if !block_ids.contains_key(b.as_str()) {
                block_ids.insert(b, blocks.len());
                blocks.push(b);
                let ident: String = b.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
                if b[ident.len()..].starts_with('(') && lib.sources.contains_key(&ident) {
                    used_fns.insert(ident);
                }
            }
        }
    }
    // Transitive dependencies
    let mut stack: Vec<String> = used_fns.iter().cloned().collect();
    while let Some(f) = stack.pop() {
        for d in lib.deps.get(&f).into_iter().flatten() {
            if used_fns.insert(d.clone()) {
                stack.push(d.clone());
            }
        }
    }

    let mut s = String::new();
    s.push_str("// Generated by shields-compiler. Scriptlets: uBlock Origin (GPLv3) and Brave adblock-resources (MPL-2.0).\n");
    s.push_str("(function () {\n");
    s.push_str(SCRIPTLET_PRELUDE);
    for f in &used_fns {
        s.push_str(&lib.sources[f]);
        s.push('\n');
    }
    s.push_str("const SHIELDS_BLOCKS = [\n");
    for b in &blocks {
        s.push_str("function () {\n");
        s.push_str(b);
        s.push_str("\n},\n");
    }
    s.push_str("];\nconst SHIELDS_SCRIPTLETS = { __proto__: null,\n");
    for (key, v) in entries {
        s.push_str(&serde_json::to_string(key).unwrap());
        match v {
            Some(v) if !v.is_empty() => {
                let ids: Vec<String> = v.iter().map(|b| block_ids[b.as_str()].to_string()).collect();
                s.push_str(&format!(": [{}],\n", ids.join(",")));
            }
            _ => s.push_str(": null,\n"),
        }
    }
    s.push_str("};\n");
    s.push_str(SCRIPTLET_LOOKUP);
    s.push_str("})();\n");
    s
}

/// Hostname shards are registered dynamically with `matches`; the entity shard (`example.*`
/// rules) is a static manifest content script using `include_globs`, which match patterns can't
/// express.
fn scriptlet_bundles(lib: &ScriptletLib, scripts: &BTreeMap<String, Vec<String>>) -> (Vec<Bundle>, Bundle) {
    let mut shards: Vec<BTreeMap<String, Option<&Vec<String>>>> = (0..SHARDS).map(|_| BTreeMap::new()).collect();
    let mut entity: BTreeMap<String, Option<&Vec<String>>> = BTreeMap::new();
    let mut entity_labels = BTreeSet::new();
    let mut entity_globs = BTreeSet::new();
    for (key, v) in scripts {
        if let Some(e) = key.strip_suffix(".*") {
            if !v.is_empty() {
                entity.insert(key.clone(), Some(v));
                entity_labels.insert(site_label(key));
                entity_globs.insert(format!("*://*{e}.*/*"));
            }
        }
    }
    let mut matches: Vec<BTreeSet<String>> = (0..SHARDS).map(|_| BTreeSet::new()).collect();
    for (key, v) in scripts {
        if key.ends_with(".*") {
            continue;
        }
        let label = site_label(key);
        let i = shard_of(&label) as usize;
        shards[i].insert(key.clone(), Some(v));
        if !v.is_empty() {
            let is_ip = key.bytes().all(|b| b.is_ascii_digit() || b == b'.');
            matches[i].insert(if is_ip { format!("*://{key}/*") } else { format!("*://*.{key}/*") });
        }
        // Hosts handled by a hostname shard must not also run the entity shard's scripts.
        if entity_labels.contains(&label) {
            entity.insert(key.clone(), None);
        }
    }
    let bundles = shards
        .iter()
        .zip(matches)
        .enumerate()
        .filter(|(_, (_, m))| !m.is_empty())
        .map(|(i, (entries, m))| Bundle {
            file: format!("build/scriptlets/shard-{i:02}.js"),
            code: emit_bundle(lib, entries),
            matches: m.into_iter().collect(),
        })
        .collect();
    let entity_bundle = Bundle {
        file: "build/scriptlets/entity.js".into(),
        code: emit_bundle(lib, &entity),
        matches: entity_globs.into_iter().collect(),
    };
    (bundles, entity_bundle)
}

/// Mirrors brave-core's GetScriptletGlobalsScript (components/cosmetic_filters/common).
const SCRIPTLET_PRELUDE: &str = r#"
const scriptletGlobals = (() => {
  const forwardedMapMethods = ["has", "get", "set"];
  const handler = {
    get(target, prop) {
      if (forwardedMapMethods.includes(prop)) {
        return Map.prototype[prop].bind(target)
      }
      return target.get(prop);
    },
    set(target, prop, value) {
      if (!forwardedMapMethods.includes(prop)) {
        target.set(prop, value);
      }
    }
  };
  return new Proxy(new Map(), handler);
})();
let deAmpEnabled = true;
"#;

/// Most-specific hostname key first, then `entity.*` keys.
const SCRIPTLET_LOOKUP: &str = r#"
const shieldsHostname = (() => {
  try { return location.hostname || new URL(self.origin).hostname; } catch (e) { return ''; }
})();
let run;
for (let h = shieldsHostname; h; ) {
  if (h in SHIELDS_SCRIPTLETS) { run = SHIELDS_SCRIPTLETS[h]; break; }
  const i = h.indexOf('.');
  if (i < 0) break;
  h = h.slice(i + 1);
}
if (run === undefined) {
  const labels = shieldsHostname.split('.');
  outer: for (let end = labels.length - 1; end >= 1; end--) {
    const suffix = labels.slice(end);
    if (suffix.length > 2 || (suffix.length === 2 && suffix[0].length > 3)) continue;
    for (let start = 0; start < end; start++) {
      const key = labels.slice(start, end).join('.') + '.*';
      if (key in SHIELDS_SCRIPTLETS) { run = SHIELDS_SCRIPTLETS[key]; break outer; }
    }
  }
}
if (run) for (const i of run) SHIELDS_BLOCKS[i]();
"#;
