// Shared API plumbing: account session, bearer token and the absolute API
// origin the native (Capacitor) shell has to use.
//
// In a normal browser the API is same-origin, so the stored base is empty and
// every URL stays relative. The iOS shell serves the page from
// capacitor://localhost, so it cannot derive the server from location and asks
// for it on the login screen instead.

export const TOKEN_KEY = "stockradar-token";
export const USER_KEY = "stockradar-user";
export const BASE_KEY = "stockradar-api-base";
export const GUEST_KEY = "stockradar-guest";

function read(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

/** Guest mode: the workbench opens without an account, self-picks stay local. */
export function isGuest() {
  return read(GUEST_KEY) === "1";
}

export function setGuest(on) {
  try {
    if (on) localStorage.setItem(GUEST_KEY, "1");
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* Private mode: guest mode lasts for this page only. */
  }
}

export function getToken() {
  return read(TOKEN_KEY);
}

export function getUser() {
  try {
    return JSON.parse(read(USER_KEY)) || null;
  } catch {
    return null;
  }
}

export function setSession({ token, user }) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.removeItem(GUEST_KEY);
  } catch {
    /* Private mode: the session lasts for this page only. */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

/** "example.com:5173" and "https://example.com/" both point at one origin. */
export function normalizeBase(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function getApiBase() {
  return normalizeBase(read(BASE_KEY));
}

export function setApiBase(value) {
  const normalized = normalizeBase(value);
  try {
    if (normalized) localStorage.setItem(BASE_KEY, normalized);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    /* ignore */
  }
  return normalized;
}

export function apiUrl(path) {
  const base = getApiBase();
  return base ? `${base}${path}` : path;
}

export function authHeaders(extra) {
  const token = getToken();
  const headers = { ...(extra || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

let redirecting = false;

/** An expired or revoked token drops back to the login screen once. */
function expireSession() {
  clearSession();
  setGuest(false);
  if (redirecting) return;
  redirecting = true;
  const here = location.pathname + location.search;
  location.replace(`/login.html?next=${encodeURIComponent(here)}`);
}

/**
 * fetch + JSON + bearer + absolute base. Throws an Error carrying
 * `status` and the server payload so callers can show the real message.
 */
export async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: authHeaders(options.headers)
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* Not JSON: a proxy or the network died. */
    }
    if (response.status === 401 && !path.startsWith("/api/auth/")) expireSession();
    const error = new Error(payload?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return response.json();
}

export function sendJson(path, method, body, options = {}) {
  return request(path, {
    ...options,
    method,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(body)
  });
}
