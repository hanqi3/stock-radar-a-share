import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuthError, createAuthStore } from "../lib/auth.js";

async function makeStore(t, { now } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stockradar-auth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: createAuthStore({ dataDir: dir, ...(now ? { now } : {}) }) };
}

const EMAIL = "Trader@Example.com";

test("register returns a token and a public user without secrets", async (t) => {
  const { dir, store } = await makeStore(t);
  const { token, user } = await store.register({ email: EMAIL, password: "correct horse", name: "阿琪" });

  assert.equal(token.length, 64);
  assert.equal(user.email, "trader@example.com");
  assert.equal(user.name, "阿琪");
  assert.deepEqual(Object.keys(user).sort(), ["createdAt", "email", "id", "name"]);

  const saved = JSON.parse(await fs.readFile(path.join(dir, "users.json"), "utf8")).users[0];
  assert.ok(saved.hash && saved.salt, "password hash is persisted");
  assert.equal(saved.hash.includes("correct horse"), false);
});

test("the same email cannot register twice, case and spaces ignored", async (t) => {
  const { store } = await makeStore(t);
  await store.register({ email: "dup@example.com", password: "password123" });
  await assert.rejects(
    store.register({ email: "  DUP@example.com ", password: "password123" }),
    (error) => error instanceof AuthError && error.status === 409 && error.code === "email_taken"
  );
});

test("invalid email and short passwords are rejected", async (t) => {
  const { store } = await makeStore(t);
  await assert.rejects(store.register({ email: "not-an-email", password: "password123" }), /邮箱/);
  await assert.rejects(store.register({ email: "ok@example.com", password: "short" }), /8/);
  await assert.rejects(store.register({ email: "ok@example.com", password: "x".repeat(129) }), /128/);
});

test("login accepts the right password and refuses the wrong one", async (t) => {
  const { store } = await makeStore(t);
  await store.register({ email: EMAIL, password: "correct horse" });

  const session = await store.login({ email: "trader@example.com", password: "correct horse" });
  assert.equal(session.user.email, "trader@example.com");

  await assert.rejects(
    store.login({ email: "trader@example.com", password: "wrong horse" }),
    (error) => error.status === 401
  );
  // An unknown account must not be distinguishable from a wrong password.
  await assert.rejects(
    store.login({ email: "ghost@example.com", password: "wrong horse" }),
    (error) => error.status === 401 && error.message === "邮箱或密码不正确"
  );
});

test("a bearer token identifies its user and logout revokes it", async (t) => {
  const { store } = await makeStore(t);
  const { token } = await store.register({ email: EMAIL, password: "correct horse" });
  const req = { headers: { authorization: `Bearer ${token}` } };

  assert.equal((await store.authenticate(req)).email, "trader@example.com");
  assert.equal(await store.authenticate({ headers: { authorization: "Bearer nope" } }), null);
  assert.equal(await store.authenticate({ headers: {} }), null);

  assert.equal(await store.logout(token), true);
  assert.equal(await store.authenticate(req), null);
});

test("sessions survive a restart of the process", async (t) => {
  const { dir, store } = await makeStore(t);
  const { token } = await store.register({ email: EMAIL, password: "correct horse" });

  const reopened = createAuthStore({ dataDir: dir });
  assert.equal((await reopened.authenticateToken(token)).email, "trader@example.com");
  const again = await reopened.login({ email: "trader@example.com", password: "correct horse" });
  assert.equal(again.user.email, "trader@example.com");
});

test("sessions expire after 30 days", async (t) => {
  let clock = Date.UTC(2026, 0, 1);
  const { store } = await makeStore(t, { now: () => clock });
  const { token } = await store.register({ email: EMAIL, password: "correct horse" });
  assert.ok(await store.authenticateToken(token));

  clock += 31 * 24 * 60 * 60 * 1000;
  assert.equal(await store.authenticateToken(token), null);
});

test("repeated failed logins from one address are rate limited", async (t) => {
  const { store } = await makeStore(t);
  await store.register({ email: EMAIL, password: "correct horse", ip: "10.0.0.1" });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await assert.rejects(store.login({ email: "ghost@example.com", password: "nope-nope", ip: "10.0.0.1" }));
  }
  await assert.rejects(
    store.login({ email: "ghost@example.com", password: "nope-nope", ip: "10.0.0.1" }),
    (error) => error.status === 429 && error.code === "rate_limited"
  );
});
