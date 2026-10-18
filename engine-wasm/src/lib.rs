//! Thin wasm-bindgen wrapper around adblock-rust's `Engine` (see adblock-rust issue #459).
use adblock::request::Request;
use adblock::lists::{FilterSet, ParseOptions};
use adblock::resources::PermissionMask;
use adblock::Engine;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmEngine {
    engine: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
    /// Deserializes an engine produced by `Engine::serialize()` at build time.
    #[wasm_bindgen(constructor)]
    pub fn new(dat: &[u8]) -> Result<WasmEngine, JsError> {
        let mut engine = Engine::default();
        engine
            .deserialize(dat)
            .map_err(|e| JsError::new(&format!("deserialize: {e:?}")))?;
        Ok(WasmEngine { engine })
    }

    /// Brave's second cosmetic phase: selectors for classes/ids seen in the DOM.
    #[wasm_bindgen(js_name = hiddenClassIdSelectors)]
    pub fn hidden_class_id_selectors(&self, classes: Vec<String>, ids: Vec<String>, exceptions: Vec<String>) -> Vec<String> {
        let exceptions: HashSet<String> = exceptions.into_iter().collect();
        self.engine.hidden_class_id_selectors(&classes, &ids, &exceptions)
    }

    /// `url_cosmetic_resources` minus the scriptlet text, as JSON.
    #[wasm_bindgen(js_name = urlCosmeticResources)]
    pub fn url_cosmetic_resources(&self, url: &str) -> String {
        let r = self.engine.url_cosmetic_resources(url);
        serde_json::json!({
            "hide_selectors": r.hide_selectors,
            "procedural_actions": r.procedural_actions,
            "exceptions": r.exceptions,
            "generichide": r.generichide,
        })
        .to_string()
    }

    /// Network check, used by the request logger and tests.
    pub fn check(&self, url: &str, source_url: &str, request_type: &str) -> String {
        match Request::new(url, source_url, request_type, "GET") {
            Ok(req) => {
                let r = self.engine.check_network_request(&req);
                serde_json::json!({
                    "block": r.should_block(),
                    "important": r.important,
                    "redirect": r.redirect.is_some(),
                    "rewritten_url": r.rewritten_url,
                })
                .to_string()
            }
            Err(e) => serde_json::json!({ "error": format!("{e:?}") }).to_string(),
        }
    }
}

/// Builds and serializes an engine *inside wasm*. The serialized hash tables are not portable
/// between 64-bit native builds and wasm32, so engine data for the service worker must be
/// produced by this same module (run under Node at build time).
#[wasm_bindgen(js_name = buildEngine)]
pub fn build_engine(lists: Vec<String>, permissions: Vec<u8>) -> Vec<u8> {
    let mut set = FilterSet::new(false);
    for (text, perm) in lists.into_iter().zip(permissions) {
        set.add_filter_list(text, ParseOptions { permissions: PermissionMask::from_bits(perm), ..Default::default() });
    }
    Engine::new_with_filter_set(set).serialize()
}
