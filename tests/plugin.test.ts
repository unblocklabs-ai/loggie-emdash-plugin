import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginRuntimeTestHost,
  type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
});
const origin = "https://app.loggie.ai";
const key = "test-agent-key-not-a-real-secret";
const catalog = {
  integrations: [
    {
      slug: "github-team",
      name: "GitHub team",
      provider: "github",
      permissions: "read",
      status: "ready",
    },
  ],
};
async function setup() {
  host = await createPluginRuntimeTestHost();
  return host;
}
async function configured() {
  vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_" + "A".repeat(43));
  const h = await setup();
  const result = await h.actions.plugin.updateSettings({ apiKey: key });
  expect(result).toMatchObject({ success: true });
  return h;
}
async function queueCatalog() {
  await host!.http.respond(`${origin}/api/discover`, Response.json(catalog));
}

describe("Loggie connections in the production sandbox", () => {
  it("declares only network access to Loggie and a private management route", async () => {
    const h = await setup();
    expect(h.manifest.capabilities).toEqual(["network:request"]);
    expect(h.manifest.allowedHosts).toEqual(["app.loggie.ai"]);
    expect(h.manifest.routes).toMatchObject([
      { name: "admin", permission: "plugins:manage" },
    ]);
  });
  it("guides setup without making a request when no key is saved", async () => {
    const h = await setup();
    const page = await h.admin.loadPage("/connections");
    expect(JSON.stringify(page)).toContain("Save your Loggie API key");
    expect(h.http.requests()).toHaveLength(0);
  });
  it("encrypts the key and renders connections without returning it", async () => {
    const h = await configured();
    const raw = await h.inspect.settings.raw("apiKey");
    expect(raw).not.toBeNull();
    expect(JSON.stringify(raw)).not.toContain(key);
    await queueCatalog();
    const page = await h.admin.loadPage("/connections");
    expect(JSON.stringify(page)).toContain("GitHub team");
    expect(JSON.stringify(page)).not.toContain(key);
    expect(h.http.requests()).toMatchObject([
      {
        method: "GET",
        url: `${origin}/api/discover`,
        headers: { authorization: `Bearer ${key}` },
      },
    ]);
  });
  it("looks up a release using the selected account slug", async () => {
    const h = await configured();
    await queueCatalog();
    await h.http.respond(
      `${origin}/api/proxy/github-team/repos/unblocklabs-ai/project/releases/latest`,
      Response.json({
        name: "Release 1",
        tag_name: "v1",
        body: "Release notes",
        html_url: "https://github.com/unblocklabs-ai/project/releases/tag/v1",
      }),
    );
    const page = await h.admin.submit("/connections", "release", {
      slug: "github-team",
      owner: "unblocklabs-ai",
      repo: "project",
    });
    expect(JSON.stringify(page)).toContain("Release notes");
    expect(h.http.requests()).toHaveLength(2);
    expect(h.http.requests().every((r) => r.method === "GET")).toBe(true);
  });
  it("rejects traversal and unsupported interactions before outbound requests", async () => {
    const h = await configured();
    const page = await h.admin.submit("/connections", "release", {
      slug: "github-team",
      owner: "../bad",
      repo: "project",
    });
    expect(JSON.stringify(page)).toContain("Invalid request");
    expect(h.http.requests()).toHaveLength(0);
  });
  it("rejects connections not advertised as ready GitHub integrations", async () => {
    const h = await configured();
    await queueCatalog();
    const page = await h.admin.submit("/connections", "release", {
      slug: "other",
      owner: "owner",
      repo: "repo",
    });
    expect(JSON.stringify(page)).toContain("Select a ready GitHub connection");
    expect(h.http.requests()).toHaveLength(1);
  });
  it.each([401, 403, 429, 500, 202])(
    "handles HTTP %s without displaying upstream errors or secrets",
    async (status) => {
      const h = await configured();
      await h.http.respond(
        `${origin}/api/discover`,
        Response.json({ error: { message: key } }, { status }),
      );
      const page = await h.admin.loadPage("/connections");
      expect(JSON.stringify(page)).toContain("Loggie request incomplete");
      expect(JSON.stringify(page)).not.toContain(key);
    },
  );
  it("handles empty catalogs", async () => {
    const h = await configured();
    await h.http.respond(
      `${origin}/api/discover`,
      Response.json({ integrations: [] }),
    );
    const page = await h.admin.loadPage("/connections");
    expect(JSON.stringify(page)).toContain("No authorized connections");
    expect(JSON.stringify(page)).not.toContain("release-lookup");
  });
  it.each(["not json", JSON.stringify({ integrations: "invalid" })])(
    "handles malformed responses",
    async (body) => {
      const h = await configured();
      await h.http.respond(`${origin}/api/discover`, new Response(body));
      expect(JSON.stringify(await h.admin.loadPage("/connections"))).toContain(
        "Loggie request incomplete",
      );
    },
  );
  it("rejects malformed releases and unsafe source links", async () => {
    const h = await configured();
    await queueCatalog();
    await h.http.respond(
      `${origin}/api/proxy/github-team/repos/owner/repo/releases/latest`,
      Response.json({
        name: "Release",
        tag_name: "v1",
        body: "Notes",
        html_url: "https://evil.example/phish",
      }),
    );
    const page = await h.admin.submit("/connections", "release", {
      slug: "github-team",
      owner: "owner",
      repo: "repo",
    });
    expect(JSON.stringify(page)).toContain("not a supported GitHub release");
    expect(JSON.stringify(page)).not.toContain("evil.example");
  });
  it("bounds large release notes", async () => {
    const h = await configured();
    await queueCatalog();
    await h.http.respond(
      `${origin}/api/proxy/github-team/repos/owner/repo/releases/latest`,
      Response.json({
        name: "Release",
        tag_name: "v1",
        body: "a".repeat(20000),
        html_url: "https://github.com/owner/repo/releases/tag/v1",
      }),
    );
    const page = await h.admin.submit("/connections", "release", {
      slug: "github-team",
      owner: "owner",
      repo: "repo",
    });
    const notes = page.blocks.find((b) => b.type === "code");
    expect(notes?.type === "code" && notes.code.length).toBe(16000);
  });
  it("requires plugin management permission and rejects other HTTP methods", async () => {
    const h = await setup();
    const user = await h.fixtures.user({
      email: "author@example.com",
      role: "author",
    });
    const denied = await h.actions.routes.request("admin", {
      method: "POST",
      user,
      headers: { "X-EmDash-Request": "1" },
      body: { type: "page_load", page: "/connections" },
    });
    expect(denied.status).toBe(403);
    const admin = await h.fixtures.user({
      email: "admin@example.com",
      role: "admin",
    });
    const method = await h.actions.routes.request("admin", {
      method: "GET",
      user: admin,
      headers: { "X-EmDash-Request": "1" },
    });
    expect(method.status).toBe(405);
  });
  it("enforces private-route auth and CSRF", async () => {
    const h = await setup();
    const response = await h.actions.routes.request("admin", {
      method: "POST",
      body: { type: "page_load", page: "/connections" },
    });
    expect(response.status).toBe(401);
    const admin = await h.fixtures.user({
      email: "admin@example.com",
      role: "admin",
    });
    const csrf = await h.actions.routes.request("admin", {
      method: "POST",
      user: admin,
      body: { type: "page_load", page: "/connections" },
    });
    expect(csrf.status).toBe(403);
  });
});
