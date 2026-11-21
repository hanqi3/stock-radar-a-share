import { apiUrl, clearSession, getApiBase, getToken, setApiBase, setGuest, setSession } from "./api.js";

const form = document.getElementById("authForm");
const errorBox = document.getElementById("authError");
const submit = form.querySelector(".auth-submit");
const guestButton = document.getElementById("guestButton");
const serverBox = document.getElementById("serverBox");
const serverInput = document.getElementById("serverBase");
const serverHint = document.getElementById("serverHint");
const isRegister = form.dataset.auth === "register";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A page served from capacitor:// cannot infer the backend from its own origin,
// so the address field is mandatory there and optional on the web.
const nativeShell = location.protocol !== "http:" && location.protocol !== "https:";

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function nextTarget() {
  const raw = new URLSearchParams(location.search).get("next") || "";
  // Same-origin paths only: an absolute URL here would be an open redirect.
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

const storedBase = getApiBase();
if (storedBase) serverInput.value = storedBase;
if (nativeShell) {
  serverBox.open = true;
  serverHint.textContent = "手机 App 必须填写后端地址，例如 http://192.168.1.10:5173 或 https://your-server.com。";
}

form.addEventListener("input", clearError);

guestButton?.addEventListener("click", () => {
  clearError();
  if (nativeShell || serverInput.value.trim()) {
    const base = setApiBase(serverInput.value);
    if (nativeShell && !base) {
      serverBox.open = true;
      showError("请先填写后端 API 地址，例如 https://your-server.com");
      return;
    }
  }
  clearSession();
  setGuest(true);
  location.replace(nextTarget());
});

async function alreadySignedIn() {
  if (!getToken()) return false;
  try {
    const response = await fetch(apiUrl("/api/auth/me"), {
      headers: { authorization: `Bearer ${getToken()}` }
    });
    if (response.ok) {
      location.replace(nextTarget());
      return true;
    }
    if (response.status === 401) clearSession();
  } catch {
    /* Server unreachable: keep the form so the user can fix the address. */
  }
  return false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;

  if (!EMAIL_RE.test(email)) return showError("请输入有效的邮箱地址");
  if (password.length < 8 || password.length > 128) return showError("密码需为 8–128 位");
  if (isRegister && password !== form.elements.password2.value) return showError("两次输入的密码不一致");

  if (nativeShell || serverInput.value.trim()) {
    const base = setApiBase(serverInput.value);
    if (nativeShell && !base) {
      serverBox.open = true;
      return showError("请先填写后端 API 地址，例如 https://your-server.com");
    }
  }

  const path = isRegister ? "/api/auth/register" : "/api/auth/login";
  const payload = isRegister
    ? { email, password, name: String(form.elements.name?.value || "").trim() }
    : { email, password };

  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = isRegister ? "注册中…" : "登录中…";

  try {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* Non-JSON error page from a proxy. */
    }
    if (!response.ok) {
      const error = new Error(data?.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    if (!data?.token) throw new Error("服务器返回缺少登录凭证");
    setSession({ token: data.token, user: data.user });
    location.replace(nextTarget());
  } catch (error) {
    if (error instanceof TypeError) showError("无法连接服务器，请检查 API 地址和网络后重试");
    else if (error.status === 429) showError("尝试次数过多，请稍后再试");
    else showError(error.message || "请求失败，请稍后再试");
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
});

alreadySignedIn();
