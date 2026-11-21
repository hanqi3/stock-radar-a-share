import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Account storage for the phone app.
 *
 * Two small JSON files under `data/` are the whole database:
 *
 *   data/users.json      [{ id, email, name, salt, hash, createdAt }]
 *   data/sessions.json   { [token]: { userId, createdAt, expiresAt } }
 *
 * The market data stays read-only and public; only the account and the
 * per-user watchlist are private. Passwords are hashed with scrypt and the
 * session tokens are opaque random strings, so a leaked file cannot be
 * replayed as a password.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_USERS = 5000;
const MAX_NAME = 24;
const MAX_EMAIL = 254;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normaliseEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString("hex");
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 1)}\n`, "utf8");
  await fs.rename(temp, file);
}

/**
 * @param {object} options
 * @param {string} options.dataDir        where users.json / sessions.json live
 * @param {() => number} [options.now]    injectable clock for tests
 */
export function createAuthStore({ dataDir, now = () => Date.now() }) {
  const usersFile = path.join(dataDir, "users.json");
  const sessionsFile = path.join(dataDir, "sessions.json");

  let usersPromise = null;
  let sessionsPromise = null;
  const limits = new Map();
  let writeQueue = Promise.resolve();

  function locked(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  }

  async function loadUsers() {
    if (!usersPromise) {
      usersPromise = readJson(usersFile, { users: [] }).then((payload) => {
        const list = Array.isArray(payload?.users) ? payload.users : [];
        return list.filter((user) => user && user.id && user.email);
      });
    }
    return usersPromise;
  }

  async function saveUsers(users) {
    usersPromise = Promise.resolve(users);
    await writeJson(usersFile, { version: 1, users });
  }

  async function loadSessions() {
    if (!sessionsPromise) {
      sessionsPromise = readJson(sessionsFile, { sessions: {} }).then((payload) => {
        const source = payload?.sessions && typeof payload.sessions === "object" ? payload.sessions : {};
        const fresh = {};
        const cutoff = now();
        for (const [token, session] of Object.entries(source)) {
          if (session && Number(session.expiresAt) > cutoff) fresh[token] = session;
        }
        return fresh;
      });
    }
    return sessionsPromise;
  }

  async function saveSessions(sessions) {
    sessionsPromise = Promise.resolve(sessions);
    await writeJson(sessionsFile, { version: 1, sessions });
  }

  function checkRateLimit(bucket, ip, max, windowMs) {
    const key = `${bucket}:${ip || "unknown"}`;
    const stamp = now();
    const entry = limits.get(key);
    if (!entry || entry.resetAt <= stamp) {
      limits.set(key, { count: 1, resetAt: stamp + windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > max) {
      const seconds = Math.max(1, Math.ceil((entry.resetAt - stamp) / 1000));
      throw new AuthError(429, "rate_limited", `尝试次数过多，请 ${seconds} 秒后再试`);
    }
  }

  function validatePassword(password) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      throw new AuthError(400, "weak_password", `密码至少需要 ${MIN_PASSWORD} 位`);
    }
    if (password.length > MAX_PASSWORD) {
      throw new AuthError(400, "weak_password", `密码不能超过 ${MAX_PASSWORD} 位`);
    }
  }

  function validateEmail(email) {
    if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
      throw new AuthError(400, "invalid_email", "请输入有效的邮箱地址");
    }
  }

  async function issueSession(user) {
    const token = randomBytes(32).toString("hex");
    const stamp = now();
    const sessions = await loadSessions();
    sessions[token] = { userId: user.id, createdAt: stamp, expiresAt: stamp + SESSION_TTL_MS };
    await saveSessions(sessions);
    return token;
  }

  async function register({ email, password, name, ip } = {}) {
    checkRateLimit("register", ip, 8, 60 * 60 * 1000);
    const cleanEmail = normaliseEmail(email);
    validateEmail(cleanEmail);
    validatePassword(password);
    const cleanName = String(name ?? "").trim().slice(0, MAX_NAME) || cleanEmail.split("@")[0].slice(0, MAX_NAME);

    return locked(async () => {
      const users = await loadUsers();
      if (users.length >= MAX_USERS) {
        throw new AuthError(429, "too_many_users", "注册人数已达上限");
      }
      if (users.some((user) => user.email === cleanEmail)) {
        throw new AuthError(409, "email_taken", "该邮箱已经注册，请直接登录");
      }
      const salt = randomBytes(16).toString("hex");
      const user = {
        id: randomUUID(),
        email: cleanEmail,
        name: cleanName,
        salt,
        hash: hashPassword(password, salt),
        createdAt: new Date(now()).toISOString()
      };
      await saveUsers([...users, user]);
      const token = await issueSession(user);
      return { token, user: publicUser(user) };
    });
  }

  async function login({ email, password, ip } = {}) {
    checkRateLimit("login", ip, 12, 15 * 60 * 1000);
    const cleanEmail = normaliseEmail(email);
    if (!cleanEmail || !password) {
      throw new AuthError(400, "missing_credentials", "请输入邮箱和密码");
    }
    const users = await loadUsers();
    const user = users.find((entry) => entry.email === cleanEmail);
    // Always run a hash so a missing account and a wrong password cost the same.
    const salt = user?.salt ?? "00000000000000000000000000000000";
    const candidate = hashPassword(String(password), salt);
    if (!user || !safeEqualHex(candidate, user.hash)) {
      throw new AuthError(401, "invalid_credentials", "邮箱或密码不正确");
    }
    const token = await issueSession(user);
    return { token, user: publicUser(user) };
  }

  async function authenticateToken(token) {
    if (!token) return null;
    const sessions = await loadSessions();
    const session = sessions[token];
    if (!session) return null;
    if (Number(session.expiresAt) <= now()) {
      delete sessions[token];
      await saveSessions(sessions);
      return null;
    }
    const users = await loadUsers();
    const user = users.find((entry) => entry.id === session.userId);
    return user ?? null;
  }

  async function authenticate(req) {
    const header = String(req?.headers?.authorization || "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : "";
    return authenticateToken(token);
  }

  async function logout(token) {
    if (!token) return false;
    return locked(async () => {
      const sessions = await loadSessions();
      if (!sessions[token]) return false;
      delete sessions[token];
      await saveSessions(sessions);
      return true;
    });
  }

  return {
    register,
    login,
    logout,
    authenticate,
    authenticateToken,
    publicUser,
    usersFile,
    sessionsFile
  };
}
