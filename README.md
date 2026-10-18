# litho-mcp

litho-mcp is a remote [MCP](https://modelcontextprotocol.io) server that runs on Vercel as a single Node.js function. Add it to claude.ai as a custom connector and Claude can generate and edit images through [OpenRouter](https://openrouter.ai) during a conversation. Results appear inline in the chat. It has been validated on claude.ai web, Claude desktop and the Claude iOS app.

Each deployment serves one person: the one who deployed it. There is no database and no sign-in flow. The connector authenticates with a shared secret sent as a request header.

Tools:

- `generate_image`: create an image from a text prompt, with any OpenRouter image model.
- `edit_image`: edit an image, or build a new one from reference images. References can be images this server generated, photos you uploaded, or public http(s) URLs.
- `upload_image`: show an upload button in the chat so you can pick a photo from your device.
- `list_models`: list OpenRouter image models and the parameters each supports.

The design, the alternatives that were rejected and the reasons are recorded in [docs/design/](docs/design/README.md).

## Requirements

- A claude.ai account that has the **Request headers** option for custom connectors. This feature is in beta with limited availability. Without it litho-mcp cannot authenticate, so it cannot be used (see [ADR 0009](docs/design/0009-connector-secret-header.md)).
- A Vercel account on the Hobby plan.
- An [OpenRouter](https://openrouter.ai) API key with a **spending limit** set. The server never caps model spending itself, so the limit on the key is what bounds your cost.
- Node.js 22.19 or newer on the machine you deploy from.

## Deploy

All commands run from a clone of this repository. Check flags against `npx vercel <command> --help` if your CLI version differs; these were checked against Vercel CLI 64.5.0 on 2026-10-18.

1. Log in and create and link a project:

   ```
   npm install
   npx vercel login
   npx vercel project create <name>
   npx vercel link --yes --project <name>
   ```

   Plain `npx vercel link` also works and asks the questions interactively.

2. Create a **public** Blob store. It holds the images, which are served straight from Blob URLs (see [ADR 0010](docs/design/0010-vercel-blob-storage.md)):

   ```
   npx vercel blob create-store <name> --access public --yes
   ```

   With `--yes` the store is connected to Production, Preview and Development, and the CLI sets `BLOB_READ_WRITE_TOKEN` in all three as a plain (Config) variable. It does not set `BLOB_STORE_ID`. That is fine: the server derives the store id from the token.

   The token can write and delete every image, so it should be a Secret (write-only) variable instead. Vercel does not convert a saved variable in place, and variables created by an integration cannot be switched to Secret from the variables list. The documented route is: disconnect the store from the project, rotate its token, reconnect it with Development deselected and Sensitive enabled, then redeploy. This route follows Vercel's documentation and has not yet been verified end to end. The tested path is the plain variable above, which works.

   `BLOB_STORE_ID` is optional. When set, it takes precedence over the id inside the token when building the public image base URL. Connecting a store from the dashboard is documented to add `BLOB_STORE_ID` and an OIDC token; that path has not been tested.

3. Generate the two secrets. Each must be at least 32 characters; the server refuses to serve with a shorter one:

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   CRON_SECRET=$(openssl rand -base64 32)
   ```

   Keep the `CONNECTOR_SECRET` value for step 4 of the next section. It cannot be read back from Vercel once stored as a Secret.

4. Add the variables from [.env.example](.env.example). Pass secrets on stdin, never with `--value`, so they stay out of shell history:

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production,preview,development --sensitive
   printf %s "$CRON_SECRET" | npx vercel env add CRON_SECRET production,preview,development --sensitive
   npx vercel env add OPENROUTER_API_KEY production,preview,development --sensitive
   ```

   The last command prompts for the key. Optional plain variables:

   ```
   npx vercel env add RETENTION_DAYS production --value 30 --no-sensitive --yes
   npx vercel env add DEFAULT_MODEL production --value <model id> --no-sensitive --yes
   ```

   | Variable | Required | Meaning |
   |---|---|---|
   | `OPENROUTER_API_KEY` | yes | OpenRouter key used for all image requests. |
   | `CONNECTOR_SECRET` | yes | Secret claude.ai sends in the `Authorization` header. At least 32 characters. |
   | `CRON_SECRET` | yes | Secret Vercel Cron sends to the cleanup route. At least 32 characters. |
   | `BLOB_READ_WRITE_TOKEN` | yes | Token for the Blob store (set in step 2). |
   | `BLOB_STORE_ID` | no | Blob store id, with or without a `store_` prefix. Empty derives it from the token. |
   | `DEFAULT_MODEL` | no | Model used when a call names none. Empty uses the built-in default. |
   | `RETENTION_DAYS` | no | Days an image is kept. Empty means 30. |
   | `OPENROUTER_REFERER` | no | `HTTP-Referer` sent to OpenRouter. Empty sends none. |

   A missing or weak required variable makes the server answer `500` with `server_misconfigured`. The log names the variable, never its value.

5. Deploy:

   ```
   npx vercel --prod
   ```

6. Check that the endpoint rejects unauthenticated requests:

   ```
   curl -i -X POST https://<project>.vercel.app/mcp
   ```

   The response must be `401` with `{"error":"unauthorized"}`.

## Add the connector in claude.ai

1. Open Customize > Connectors and add a custom connector.
2. URL: `https://<project>.vercel.app/mcp`.
3. Authentication: **No sign-in** (no OAuth).
4. Request header: name `Authorization`, value `Bearer <CONNECTOR_SECRET>`.
5. Add it on claude.ai web or the desktop app first.

The add completes directly, with no "Continue anyway" step. While adding, claude.ai sends an `initialize` request without headers and gets `401`, and it looks up OAuth metadata under `/.well-known/` and gets Vercel's static `404`. Both are expected. In Vercel's request log the first shows only as a `401`; the server logs nothing about it.

If claude.ai reports a "Connection issue" saying the server asked for sign-in (status 401), the header value is wrong or missing.

## Rotate the secret

1. Generate a new value and replace the variable:

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production,preview,development --sensitive --force
   ```

2. Redeploy with `npx vercel --prod`.
3. Remove the connector in claude.ai and add it again with the new header value. The headers of an existing connector cannot be edited.

Rotate `CRON_SECRET` the same way; no claude.ai step is needed. To rotate `OPENROUTER_API_KEY`, create a new key at OpenRouter, replace the variable and redeploy.

## Retention

Images are deleted `RETENTION_DAYS` days after creation (default 30). Cleanup is a Vercel Cron job that runs once a day at 03:00 UTC (`vercel.json`), so an image can outlive the setting by up to about a day. Changing `RETENTION_DAYS` takes effect after a redeploy.

## Limits

- Going over a Vercel Hobby or Blob quota pauses the service for up to 30 days. Hobby and Blob do not bill for overage.
- The Hobby plan is for non-commercial use.
- Model spending is billed by OpenRouter and is bounded only by the limit you set on the key.

## Security notes

- Image links are capability URLs: the Blob store is public, and anyone holding a link can view that image. Links are unguessable and are not listed anywhere, but treat them like shared secrets. Images are deleted after the retention period.
- `CONNECTOR_SECRET` is a long-lived bearer secret. Anyone who has it can use your OpenRouter key through this server. It is compared in constant time, and a wrong and a missing secret get the same response.
- There is no OAuth and no per-session sign-in. Rotation is manual (see above).
- URLs passed to `edit_image` are fetched by the server behind SSRF checks (see [ADR 0007](docs/design/0007-reference-urls-ssrf.md)).
- `npx vercel link` and `npx vercel env pull` write real tokens to `.env.local`. Files matching `.env*` are gitignored, and the allowlist in `.vercelignore` keeps them out of deploy uploads. Do not copy them elsewhere.
- `public/robots.txt` disallows crawling of the deployment.
- The server never logs request or response bodies, secrets or tokens.

## Development

```
npm test            # builds the widget, then runs vitest
npm run typecheck   # server and widget TypeScript
npm run hygiene     # scans tracked files for personal information
npx vercel dev      # run the function locally (needs the env vars)
```

Tests never touch the network. Run `npm run hygiene` before every commit.

`npx vercel link` writes `.env.local` with `BLOB_READ_WRITE_TOKEN` and `VERCEL_OIDC_TOKEN`, but no `BLOB_STORE_ID`. With Vercel CLI 64.5.0, `npx vercel blob` commands then fail with "VERCEL_OIDC_TOKEN and BLOB_STORE_ID must both be set, or both be unset". Remove the `VERCEL_OIDC_TOKEN` line, or pass the matching flags (`--rw-token`, or `--oidc-token` together with `--store-id`). Check the current behavior if your CLI version differs.

Host-specific code stays behind small adapters so the core can move hosts. Only `src/deps.ts`, the Blob store adapter and the sharp thumbnailer import Vercel- or sharp-specific packages.

## Platform limitations

- The Claude desktop app has no direct "save image", and Copy Image does not work. Copy the image address from the result and open it in a browser.
- The desktop app cannot decode DNG photos, and probably not HEIC. Export them as JPEG first. iOS converts both.
- After replacing an uploaded photo, wait about a minute before asking for an edit, or the previous photo may still be used.
- Android is untested.

## Remove a deployment

1. Empty the linked project's store: `npx vercel blob empty-store`.
2. Find the store id with `npx vercel blob list-stores --all` (it looks like `store_...`), then delete the store with `npx vercel blob delete-store <store id>`. This command has no `--yes` and refuses a store that is not empty.
3. Remove the project: `npx vercel project remove <name>`.
4. Remove the connector in claude.ai.

## License

[MIT](LICENSE)
