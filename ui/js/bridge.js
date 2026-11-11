// The window's line to the Rust core. Inside the app that is Tauri's invoke/listen; a test
// page can provide window.__HARMONY_DEV__ with the same two functions instead.

const tauri = window.__TAURI__;
const dev = window.__HARMONY_DEV__;

export const invoke = (command, args = {}) => (tauri ? tauri.core.invoke(command, args) : dev.invoke(command, args));

export const listen = (event, handler) => (tauri ? tauri.event.listen(event, e => handler(e.payload)) : dev.listen(event, handler));

/** Call Harmony's core (core.rs). Always resolves to {ok, data, error}. */
export async function api(method, route, { query, body, timeout } = {}) {
  try {
    return await invoke('api', { method, route, query: query || null, body: body || null, timeout: timeout || null });
  } catch (error) {
    return { ok: false, data: {}, error: String(error?.message || error) };
  }
}

export const get = (route, query) => api('GET', route, { query });
export const post = (route, body, timeout) => api('POST', route, { body, timeout });
