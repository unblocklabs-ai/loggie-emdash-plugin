# Loggie Connections for EmDash

View the services available to your Loggie agent and look up the latest GitHub release notes directly in the EmDash admin.

[Loggie](https://loggie.ai) brokers access to connected services. You give this plugin one scoped Loggie agent key; upstream GitHub credentials stay in Loggie. Loggie applies the profile’s access rules and audits proxied API calls.

## What it does

- Lists the connections, access levels, and readiness returned by your Loggie agent profile.
- Lets an administrator choose an authorized GitHub connection and look up a repository’s latest release.
- Shows release notes as plain code text and links to the source on GitHub.
- Makes only read requests. It does not create, publish, or change CMS content or GitHub data.

The admin page and route require `plugins:manage`. The plugin has no public routes, MCP tools, content permissions, or unrestricted network access. Its only network destination is `app.loggie.ai`.

## Setup

Requires EmDash 1.4.0 or newer with sandboxed plugin support.

1. Configure `EMDASH_ENCRYPTION_KEY` on your EmDash host. Use EmDash’s `emdash secrets generate` workflow and keep the key securely with database backups. Do not replace an existing key without preserving keys needed to decrypt stored secrets.
2. Create a dedicated read-only agent profile in [Loggie](https://app.loggie.ai), granting only the integrations and endpoints this site needs. For release lookup, connect GitHub and authorize `GET /repos/{owner}/{repo}/releases/latest` for that profile.
3. Install the plugin artifact through your EmDash administrator workflow and approve its `network:request` permission for `app.loggie.ai`.
4. Open the plugin’s generated settings page and save the Loggie API key. EmDash treats it as a write-only encrypted secret.
5. Open **Loggie connections** and refresh. If a ready GitHub integration is available, enter the repository owner and name to view the latest release.

Never commit an agent key, paste it into content, or put it in a public URL. Do not reuse a key with broad write permissions. This plugin does not need those permissions.

## Errors and limits

Invalid/revoked keys, policy denials, rate limits, pending approvals, and malformed responses produce administrator-facing messages. No automatic retry is performed. A pending approval must be resolved in Loggie before trying again.

The catalog currently supports up to 200 connections. Release notes are displayed up to 16,000 characters; use the GitHub link to read the full release. This is an admin lookup tool, not a content importer. A GitHub integration must be ready and visible to the configured Loggie profile. Slugs come from discovery and are never assumed to equal `github`.

## Development

```sh
npm ci
npm run validate
npm run typecheck
npm test
npm run build
npm run bundle
```

Tests execute the built plugin inside EmDash’s production Cloudflare sandbox and host bridge. They verify encrypted settings, actual Block Kit validation, outbound requests, expected failures, and route access controls. Outbound APIs are queued test responses; this does not prove a deployed site’s configuration or a real GitHub integration.

The supported baseline is `emdash@1.4.0` with `@emdash-cms/plugin-cli@0.13.5`. Zod is overridden to patched `4.6.7` across the dependency tree to avoid GHSA-mrhx-c7xc-m3w5 in earlier versions.

## Release status and procedure

**Unpublished.** The manifest contains a deliberately invalid-for-publishing placeholder publisher identity, `did:plc:aaaaaaaaaaaaaaaaaaaaaaaa`. It must be replaced with the authenticated publisher’s real DID before release. There is no registry or directory listing yet.

1. Finish publisher account verification and run `npm run login -- loggieai.bsky.social` through the plugin CLI (substitute the final account handle if different).
2. Replace the placeholder publisher DID in `emdash-plugin.jsonc` with that account’s DID. Verify the repository URL in the manifest.
3. Re-run validation, typecheck, tests, build, and bundle. Review the manifest, permissions, README, and generated bundle.
4. Perform a live read-only discovery check with a dedicated profile. Verify a GitHub release lookup when a test GitHub integration is available. Visually verify installation and the admin UI in a real EmDash site before claiming those are live-tested.
5. Run `npm run publish`, then use the CLI-provided `info ... --watch` command to verify registry indexing and the public listing, including the link to Loggie.

## Security

Report vulnerabilities privately to **bill@unblocklabs.ai**. Never include credentials in a report.

## License

MIT. Copyright 2026 Unblock Labs.
