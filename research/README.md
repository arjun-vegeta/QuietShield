# Research prototypes

REA-driven experiments behind the fixes in this branch. Production code lives elsewhere; these
are kept for reference and future opt-in features.

| Folder | What it explores | Status |
|---|---|---|
| `cname/` | Cloaked-tracker coverage, DoH uncloaking (`doh-uncloak.js`), ephemeral storage | CNAME rulesets shipped (`scripts/build-cname.mjs`); DoH and ephemeral storage are opt-in ideas |
| `regex/` | Why Chrome rejects regex filters (memory vs syntax), RE2 replica, rewriter + gate | Rewriter shipped as `scripts/lib/regex-rewrite.mjs` + `scripts/regex-alternatives.mjs` |
| `rt-shim/` | Synthesizing Resource Timing entries for redirected surrogates | Prototype; candidate opt-in "anti-detection" setting |
| `farbling/` | Canvas/audio/hardwareConcurrency farbling modeled on brave-core | Prototype; workers and timing are not coverable |
| `updates/` | Chrome Web Store skip-review eligibility simulation | Design for content-hash rule ids + unsafe rules as metadata |
| `scriptlets/` | Which scriptlets the lists actually use (`usage.json`) | Top 20 cover 91% of `##+js` filters |
