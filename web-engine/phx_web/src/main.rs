//! Browser boundary for the complete end-user PHX API.
//!
//! The same protocol-v1 JSON the Android and desktop apps send goes in, the
//! same envelope comes out. Files live in the Emscripten virtual file system:
//! inputs are mounted read-only from the user's own `File` objects (WORKERFS),
//! outputs and the private history go to in-memory storage the page saves.
//! Nothing here touches the network.
//!
//! **Web edition entitlement.** The free web edition opens every end-user
//! feature without a license: the policy is resolved here, once, as the tier
//! that grants every gated operation. Requests still go through the desktop
//! allowlist (`dispatch_json_desktop`), so vendor-only operations such as
//! license generation stay unreachable, and `[BET]` capabilities keep their
//! experimental, hidden-by-default labels.
use std::ffi::{c_char, CStr, CString};

use phx_api::PhxApi;
use phx_policy::{Policy, Tier};

/// Where the engine keeps its private history inside the virtual file system.
const HISTORY_DIR: &str = "/phx/history";

/// The web edition's entitlement: every gated end-user feature is open.
fn web_policy() -> Policy {
    Policy::new(Tier::Pro, None)
}

/// Run one protocol-v1 request. Returns a NUL-terminated JSON envelope that the
/// caller must release with [`phx_free`].
///
/// # Safety
/// `request` must point to a NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn phx_dispatch(request: *const c_char) -> *mut c_char {
    let request = if request.is_null() {
        String::new()
    } else {
        CStr::from_ptr(request).to_string_lossy().into_owned()
    };
    CString::new(dispatch(&request))
        .unwrap_or_default()
        .into_raw()
}

fn dispatch(request: &str) -> String {
    let _ = std::fs::create_dir_all(HISTORY_DIR);
    let engine = PhxApi::builder()
        .history_dir(HISTORY_DIR)
        .policy(web_policy())
        .build();
    match tokio::runtime::Builder::new_current_thread().build() {
        Ok(rt) => rt.block_on(engine.dispatch_json_desktop(request)),
        Err(e) => format!("{{\"v\":1,\"response\":{{\"error\":{{\"kind\":\"internal\",\"message\":\"runtime: {e}\"}}}}}}"),
    }
}

/// Release a string returned by [`phx_dispatch`].
///
/// # Safety
/// `ptr` must come from [`phx_dispatch`] and be freed once.
#[no_mangle]
pub unsafe extern "C" fn phx_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

/// In the browser the page calls [`phx_dispatch`]; `main` only initialises.
#[cfg(target_os = "emscripten")]
fn main() {}

/// Native build of the same boundary: one request on stdin, one envelope on
/// stdout. Used to check that the WebAssembly build answers exactly like a
/// native build of the identical code.
#[cfg(not(target_os = "emscripten"))]
fn main() {
    use std::io::Read;
    let mut request = String::new();
    if std::io::stdin().read_to_string(&mut request).is_ok() {
        print!("{}", dispatch(&request));
    }
}
