# QuietShield architecture

The question that started this: *Brave blocks ads well and websites rarely notice. Can Chrome do the
same with an extension?* This document covers the research, the design, how we tested against
Brave, what we fixed after reverse-engineering the differences, and how to build it yourself.

- [1. Research](#1-research)
- [2. The core design decision](#2-the-core-design-decision)
- [3. How each part of Brave Shields maps to Chrome](#3-how-each-part-of-brave-shields-maps-to-chrome)
- [4. The build pipeline](#4-the-build-pipeline)
- [5. Testing against Brave](#5-testing-against-brave)
- [6. Second round: closing the gaps with REA](#6-second-round-closing-the-gaps-with-rea)
- [7. What still differs from Brave](#7-what-still-differs-from-brave)
- [8. Shipping](#8-shipping)
- [9. Build from source](#9-build-from-source)
- [10. Repository layout](#10-repository-layout)

---

## 1. Research

We started with four research tracks in parallel, each reading source code rather than guessing.

| Track | What we read | Key finding |
|---|---|---|
| **Brave's engine** | [brave/adblock-rust](https://github.com/brave/adblock-rust) | Already compiles to WebAssembly. Its API splits cleanly into network matching (`check_network_request`) and cosmetic filtering (`url_cosmetic_resources`, `hidden_class_id_selectors`). About 85–88% of Brave's rules are plain enough to convert to Chrome's format. |
| **Chrome's limits (Manifest V3)** | developer.chrome.com, Chromium source | Extensions can no longer inspect requests themselves. Blocking must go through `declarativeNetRequest` (DNR): fixed rule lists that Chrome applies. 30k guaranteed static rules (330k shared pool), regexes capped at 1,000 and a 2 KiB RE2 memory budget, a service worker that's stopped after 30 s idle. |
| **The best existing MV3 blockers** | uBlock Origin Lite, AdGuard MV3 | uBOL precomputes everything at build time and keeps no engine running; AdGuard runs an engine in the service worker and its injected scripts sometimes arrive late. uBOL's domain-merging trick shrinks EasyList from ~57k filters to ~3.7k rules. |
| **How Brave wires it in** | [brave/brave-core](https://github.com/brave/brave-core) (`components/brave_shields`, `components/cosmetic_filters`) | Two engines (default lists with *first-party protections* vs. additional lists), Standard mode never blocks a site's own requests, cosmetic rules are fetched synchronously before page scripts run, scriptlets are injected as an inline script in the main world, `$redirect` stubs are served in place. |

## 2. The core design decision

Chrome won't let an extension run an engine on every request, and its service worker can be killed
at any moment. So instead of running Brave's engine *per request*, we run it **at build time** and
ship its answers:

- **Network blocking:** adblock-rust parses Brave's lists; our Rust compiler converts every filter
  into DNR rules.
- **Hiding elements:** we ask the engine "what should be hidden on this site?" for every one of the
  ~62k hostnames the lists mention, and ship the answers as per-site data.
- **Anti-adblock scriptlets:** the engine assembles the per-site script list; we bundle the
  scriptlet functions once and inject them in the page's main world before page scripts.

The engine *also* runs in the extension: compiled to WebAssembly in the service worker, it handles
the part that can't be precomputed — hiding ad elements identified by class/id as the page changes —
exactly like Brave's own `hidden_class_id_selectors` call.

## 3. How each part of Brave Shields maps to Chrome

| Brave (brave-core) | QuietShield |
|---|---|
| `AdBlockEngine::matches()` on every request | Filters compiled to DNR rules at build time (`compiler/src/dnr.rs`), ~21k Standard + ~16k Aggressive rules after merging |
| Default engine (first-party protections) vs. additional engine | Standard rulesets add `domainType: thirdParty` to default-list blocks; `*-aggressive` rulesets add the first-party half |
| `$redirect` stub responses | DNR redirects to bundled uBO/Brave resources (`web_accessible_resources`, `use_dynamic_url`) |
| `$removeparam`, `$csp` | `queryTransform.removeParams`, `modifyHeaders` (Brave ignores default-engine removeparam; so do we) |
| Synchronous `UrlCosmeticResources` before page JS | Precomputed per host (`compiler/src/cosmetic.rs`) → `chrome.storage.local`, read at `document_start` |
| `content_cosmetic.ts`, `procedural_filters.ts` | Ported in `extension/src/cosmetic.js`; Brave's procedural engine vendored unchanged |
| `hidden_class_id_selectors` IPC | adblock-rust in WebAssembly in the service worker (`engine-wasm/`), ~25 ms cold start |
| Scriptlets as inline main-world script | MAIN-world `document_start` content scripts, sharded by site so each page loads only what it needs |
| CNAME uncloaking via DNS | AdGuard's cname-trackers map compiled into rules, filtered by Brave's engine (no DNS API in extensions) |
| Standard / Aggressive, per-site Shields down | Ruleset toggles, an `allowAllRequests` dynamic rule, content-script excludes |

## 4. The build pipeline

`npm run build` runs these steps (`scripts/build.mjs`):

1. **`scripts/build-resources.mjs`** turns uBlock Origin's scriptlets into adblock-rust resources,
   exactly as Brave's packager does.
2. **`compiler/`** (Rust, using adblock-rust natively):
   - converts network filters to DNR rulesets and merges `||host^` rules by domain
   - expands `domain=site.*` entity filters to concrete domains (`entities.rs`)
   - precomputes per-host cosmetic data and generic hiding rules
   - builds the scriptlet bundles. The engine is fed *stub* resources so it emits only the calls,
     and the function bodies ship once per shard.
3. **`engine-wasm/`** compiles adblock-rust to WebAssembly with `wasm-bindgen`.
4. **`scripts/build-engines.mjs`** builds the engine data *inside* WebAssembly. Lesson learned:
   engine data serialized by a 64-bit native build broke class/id lookups in 32-bit wasm, because
   the hash tables aren't portable.
5. **`scripts/build-cname.mjs`** keeps the cloaked hosts whose real target Brave's lists block, and
   writes the `cname` rulesets.
6. **`scripts/regex-alternatives.mjs`** prepares rewrites for regex filters Chrome might reject (see §6).
7. esbuild bundles the content script and service worker, then the manifest is generated.

## 5. Testing against Brave

We ran Brave 1.97, Chrome for Testing 155 with QuietShield, and plain Chrome side by side, each
driven over the Chrome DevTools Protocol (`tests/compare.mjs`, `probe.mjs`, `isolated.mjs`,
`sw-eval.mjs`).

| Test | Result |
|---|---|
| Brave's own QA pages (`dev-pages.brave.software`) — scriptlets in main/local/remote frames, first- vs third-party blocking in Standard and Aggressive | Identical to Brave |
| Our cosmetic parity page (`tests/pages/cosmetic.html`) on three host setups, including `$generichide` exceptions | 24/24 element states identical |
| Real sites (CNN, The Verge, Forbes, Yahoo, IMDb, Speedtest and more) | Blocked counts within 0–2 requests of Brave, zero visible ad slots |
| [REA](https://github.com/morluto/rea) passive capture of cnn.com in both browsers | Same third-party origins blocked, byte-identical stand-in scripts, identical page structure |
| Common ad-blocker detection techniques (`tests/pages/detect.html`) | Same results as Brave, with one exception (see §7) |

Two bugs these tests caught along the way:
- **`$generichide` was too broad:** we OR'd the flag across both engines, so the additional
  engine's generic hiding rules were skipped on sites where only the default engine was exempt.
  Brave applies each engine's flag separately.
- **URL-pattern exceptions were missed:** some `$generichide` exceptions are URL patterns (private
  IPs, search result pages). These are now evaluated per URL in the content script, like Brave.

## 6. Second round: closing the gaps with REA

A second pass used [REA](https://github.com/morluto/rea) to capture exactly what pages can observe
in each browser, then fixed the differences:

| Gap | Fix | Result |
|---|---|---|
| Scriptlet stack traces showed `chrome-extension://<id>` | `//# sourceURL=<anonymous>` on scriptlet bundles | Stack frames match Brave's shape |
| Pages could read our hiding rules from an adopted stylesheet | Settled rules move to a USER-origin stylesheet pages can't see | Page sees 0 sheets (Brave exposes 1) |
| Disguised (CNAME) trackers slipped through | `cname` rulesets from AdGuard's map, filtered by Brave's engine; third-party only in Standard, matching brave-core | 73,656 hosts covered; 12/12 sampled hosts blocked in both browsers |
| ~40% of regex filters rejected by Chrome's RE2 limits | Build-time rewrites (cap counted repetitions, drop lookarounds, split alternations), kept only if every extra URL they match in adblock-rust's 243k-request corpus is one Brave blocks anyway. The service worker installs the first version Chrome accepts. | Standard regex rules 171 → 262 |
| `domain=site.*` filters skipped | Expanded to concrete domains | Skipped filters 134 → 0 |
| Aggressive-only regex rules dropped; regex rules stayed active when switched off | Fixed | Off now means zero rules |

Prototypes that didn't ship yet (Resource Timing shim, fingerprint farbling, DNS-over-HTTPS
uncloaking, a fast-track store update pipeline) are in [`research/`](research/README.md).

## 7. What still differs from Brave

- **Stand-in scripts are redirected, not served in place,** so they have no Resource Timing entry.
  A shim prototype is in `research/rt-shim/`.
- **No live DNS uncloaking,** only the known list of disguised trackers.
- **No fingerprint randomization** at Brave's level, and no temporary storage for blocked sites.
- **Filter updates need a new release.** GitHub Actions rebuilds with the latest lists on every tag.

## 8. Shipping

- **Releases:** pushing a `vX.Y.Z` tag that matches `package.json` makes GitHub Actions
  (`.github/workflows/release.yml`) fetch the latest Brave lists, build, test and publish
  `quietshield.zip`.
- **Website:** [quietshield.arjunr.dev](https://quietshield.arjunr.dev/), served by GitHub Pages
  from `docs/` through a Cloudflare DNS record.
- **Updates:** GitHub installs check the latest release once a day and show a banner in the popup.
- **Chrome Web Store:** the listing, icons, screenshots and privacy policy are ready in `store/`
  and `PRIVACY.md`.

## 9. Build from source

Requirements: Node 22+, Rust (stable, with the `wasm32-unknown-unknown` target), and
`wasm-bindgen-cli 0.2.129`.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked

npm install
npm run fetch     # Brave's list catalog + default lists, resources, uBlock Origin, adblock-rust, cname-trackers
npm run build     # compile rules, cosmetic data, scriptlets, wasm engine, manifest
npm run package   # dist/quietshield-<version>.zip
cargo test --release --manifest-path compiler/Cargo.toml
```

Then load `extension/` as an unpacked extension.

## 10. Repository layout

| Path | What's there |
|---|---|
| `compiler/` | Rust compiler: filters → DNR rules, cosmetic data, scriptlet bundles |
| `engine-wasm/` | adblock-rust compiled to WebAssembly for the service worker |
| `extension/` | Service worker, content script, popup, icons (`build/` is generated) |
| `scripts/` | Build, fetch, packaging and asset scripts |
| `tests/` | CDP harnesses and test pages used to compare against Brave |
| `research/` | REA-driven prototypes and analyses |
| `docs/` | The website (GitHub Pages) |
| `store/` | Chrome Web Store listing and graphics |

### Licensing

adblock-rust, the brave-core ports and Brave's resources are MPL-2.0. uBlock Origin's scriptlets
and redirect resources are GPL-3.0, and the generated scriptlet bundles inherit that.
