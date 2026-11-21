import { apiUrl, authHeaders, clearSession, getApiBase, getUser, isGuest, setApiBase, setGuest, setSession } from "./api.js";

const els = {
  button: document.getElementById("accountButton"),
  initial: document.getElementById("accountInitial"),
  sheet: document.getElementById("accountSheet"),
  backdrop: document.getElementById("accountBackdrop"),
  close: document.getElementById("accountClose"),
  avatar: document.getElementById("accountAvatar"),
  name: document.getElementById("accountName"),
  email: document.getElementById("accountEmail"),
  base: document.getElementById("accountBase"),
  saveBase: document.getElementById("accountSaveBase"),
  baseNote: document.getElementById("accountBaseNote"),
  logout: document.getElementById("accountLogout")
};

if (els.button && els.sheet) {
  const nativeShell = location.protocol !== "http:" && location.protocol !== "https:";

  function paint() {
    const guest = isGuest();
    const user = getUser() || {};
    const label = guest ? "游客" : user.name || user.email || "我";
    els.initial.textContent = String(label).slice(0, 1).toUpperCase();
    els.avatar.textContent = String(label).slice(0, 1).toUpperCase();
    els.name.textContent = guest ? "游客" : user.name || "我的账户";
    els.email.textContent = guest ? "未登录 · 自选只保存在这台设备" : user.email || "";
    els.logout.textContent = guest ? "登录 / 注册" : "退出登录";
    els.base.value = getApiBase();
    els.baseNote.textContent = nativeShell ? "App 内需填写后端公网地址" : "网页版留空即可";
  }

  function open() {
    paint();
    els.sheet.hidden = false;
    els.button.setAttribute("aria-expanded", "true");
    els.base.focus({ preventScroll: true });
  }

  function close() {
    els.sheet.hidden = true;
    els.button.setAttribute("aria-expanded", "false");
  }

  els.button.addEventListener("click", () => (els.sheet.hidden ? open() : close()));
  els.close.addEventListener("click", close);
  els.backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.sheet.hidden) close();
  });

  els.saveBase.addEventListener("click", () => {
    setApiBase(els.base.value);
    els.base.value = getApiBase();
    els.baseNote.textContent = getApiBase() ? "已保存，下次打开时生效" : "已清空，使用网页同源地址";
  });

  els.logout.addEventListener("click", async () => {
    if (isGuest()) {
      setGuest(false);
      location.href = "/login.html";
      return;
    }
    els.logout.disabled = true;
    try {
      await fetch(apiUrl("/api/auth/logout"), { method: "POST", headers: authHeaders() });
    } catch {
      /* Still sign out locally when the server is unreachable. */
    }
    clearSession();
    location.replace("/login.html");
  });

  // The cached user can be missing after a fresh install while a token exists.
  if (!isGuest() && !getUser()) {
    fetch(apiUrl("/api/auth/me"), { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload?.user) {
          setSession({ token: null, user: payload.user });
          paint();
        }
      })
      .catch(() => {});
  }

  paint();
}
