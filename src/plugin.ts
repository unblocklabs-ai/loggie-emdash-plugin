import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import { z } from "zod";

const ORIGIN = "https://app.loggie.ai";
const integrationSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(200),
  name: z.string().max(300),
  provider: z.string().max(100),
  permissions: z.enum(["read", "read+write"]),
  status: z.enum(["ready", "pending", "error"]),
});
const catalogSchema = z.object({
  integrations: z.array(integrationSchema).max(200),
});
const releaseInputSchema = z.object({
  slug: integrationSchema.shape.slug,
  owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine((v) => v !== "." && v !== ".."),
});
const interactionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page_load"), page: z.literal("/connections") }),
  z.object({
    type: z.literal("block_action"),
    action_id: z.literal("refresh"),
  }),
  z.object({
    type: z.literal("form_submit"),
    action_id: z.literal("release"),
    values: releaseInputSchema,
  }),
]);
const releaseSchema = z.object({
  name: z.string().max(1000).nullable(),
  tag_name: z.string().max(300),
  body: z.string().max(1_000_000).nullable(),
  html_url: z
    .string()
    .url()
    .refine((v) => {
      const url = new URL(v);
      return (
        url.origin === "https://github.com" && !url.username && !url.password
      );
    }),
});
type Integration = z.infer<typeof integrationSchema>;

async function loggieGet(ctx: PluginContext, path: string): Promise<unknown> {
  let apiKey: string | null;
  try {
    apiKey = await ctx.settings.get<string>("apiKey");
  } catch {
    throw new Error(
      "Could not read the encrypted API key. Check the EmDash encryption key configuration.",
    );
  }
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error(
      "Save your Loggie API key in this plugin’s settings first.",
    );
  let response: Response;
  try {
    if (!ctx.http) throw new Error("Network capability unavailable");
    response = await ctx.http.fetch(`${ORIGIN}${path}`, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: "application/json",
        "User-Agent": "Loggie-EmDash/0.1",
      },
    });
  } catch {
    throw new Error(
      "Could not reach Loggie. Check the connection and try again.",
    );
  }
  if (response.status === 202)
    throw new Error(
      "This request is awaiting approval in Loggie. Approve it there before trying again.",
    );
  if (response.status === 401)
    throw new Error(
      "Loggie rejected this key. Check that the agent profile is active and the key is current.",
    );
  if (response.status === 429)
    throw new Error(
      "Loggie is rate-limiting requests. Wait before refreshing.",
    );
  if (response.status === 403)
    throw new Error(
      "Loggie policy denied this request. Check the agent profile’s access rules.",
    );
  if (response.status === 404)
    throw new Error(
      "The integration, repository, or release was not found, or is not accessible to this profile.",
    );
  if (!response.ok)
    throw new Error(`Loggie request failed (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error("Loggie returned an invalid JSON response.");
  }
}

function page(
  integrations: Integration[] = [],
  extra: Block[] = [],
): BlockResponse {
  const github = integrations.filter(
    (i) => i.provider === "github" && i.status === "ready",
  );
  return {
    blocks: [
      { type: "header", text: "Loggie connections" },
      {
        type: "context",
        text: "See the services available to this Loggie agent profile. Requests are read-only and pass through Loggie’s access controls.",
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "refresh",
            label: "Refresh connections",
          },
          {
            type: "link",
            label: "API key settings",
            target: { kind: "plugin-settings" },
          },
        ],
      },
      {
        type: "table",
        columns: [
          { key: "name", label: "Connection" },
          { key: "slug", label: "Slug" },
          { key: "permissions", label: "Access" },
          { key: "status", label: "Status" },
        ],
        rows: integrations.map(({ name, slug, permissions, status }) => ({
          name,
          slug,
          permissions,
          status,
        })),
        page_action_id: "refresh",
        empty_text: "No authorized connections to show.",
      },
      ...(github.length
        ? [
            {
              type: "form" as const,
              block_id: "release-lookup",
              fields: [
                {
                  type: "select" as const,
                  action_id: "slug",
                  label: "GitHub connection",
                  options: github.map((i) => ({
                    label: i.name,
                    value: i.slug,
                  })),
                },
                {
                  type: "text_input" as const,
                  action_id: "owner",
                  label: "Repository owner",
                  placeholder: "unblocklabs-ai",
                },
                {
                  type: "text_input" as const,
                  action_id: "repo",
                  label: "Repository name",
                  placeholder: "my-project",
                },
              ],
              submit: { action_id: "release", label: "Look up latest release" },
            },
          ]
        : []),
      ...extra,
    ],
  };
}

const plugin: SandboxedPlugin = {
  routes: {
    admin: {
      permission: "plugins:manage",
      methods: ["POST"],
      request: { body: "json" },
      handler: async (routeCtx, ctx) => {
        const interaction = interactionSchema.safeParse(routeCtx.input);
        if (!interaction.success)
          return page(
            [],
            [
              {
                type: "banner",
                variant: "error",
                title: "Invalid request",
                description:
                  "Refresh the page or check the repository owner and name.",
              },
            ],
          );
        let integrations: Integration[] = [];
        try {
          const catalog = catalogSchema.safeParse(
            await loggieGet(ctx, "/api/discover"),
          );
          if (!catalog.success)
            throw new Error(
              "Loggie returned an unexpected connection catalog.",
            );
          integrations = catalog.data.integrations;
          if (interaction.data.type !== "form_submit")
            return page(integrations);
          const { slug, owner, repo } = interaction.data.values;
          if (
            !integrations.some(
              (i) =>
                i.slug === slug &&
                i.provider === "github" &&
                i.status === "ready",
            )
          )
            throw new Error(
              "Select a ready GitHub connection authorized for this profile.",
            );
          const result = releaseSchema.safeParse(
            await loggieGet(
              ctx,
              `/api/proxy/${encodeURIComponent(slug)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
            ),
          );
          if (!result.success)
            throw new Error(
              "The upstream response was not a supported GitHub release.",
            );
          const release = result.data;
          return page(integrations, [
            { type: "header", text: release.name || release.tag_name },
            { type: "context", text: `${owner}/${repo} · ${release.tag_name}` },
            {
              type: "code",
              code: (release.body || "No release notes.").slice(0, 16_000),
            },
            {
              type: "actions",
              elements: [
                {
                  type: "link",
                  label: "View release on GitHub",
                  target: { kind: "external", url: release.html_url },
                },
              ],
            },
          ]);
        } catch (error) {
          // Only fixed messages constructed above reach the administrator.
          const message =
            error instanceof Error
              ? error.message
              : "Could not load Loggie connections.";
          return page(integrations, [
            {
              type: "banner",
              variant: "error",
              title: "Loggie request incomplete",
              description: message,
            },
          ]);
        }
      },
    },
  },
};
export default plugin;
