# litho-mcp

litho-mcp is a remote [MCP](https://modelcontextprotocol.io) server that runs on Vercel as a single Node.js function. Add it to claude.ai as a custom connector and Claude can generate and edit images through [OpenRouter](https://openrouter.ai) during a conversation. Results appear inline in the chat. Its design was validated on claude.ai web, Claude desktop and the Claude iOS app.

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
- An [OpenRouter](https://openrouter.ai) API key with a **spending limit** set: create the key in the OpenRouter dashboard and give it a credit limit. The server never caps model spending itself, so the limit on the key is what bounds your cost.
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

2. Create a **public** Blob store. It holds the images, which are served straight from Blob URLs (see [ADR 0010](docs/design/0010-vercel-blob-storage.md)). The recommended path is the Vercel dashboard (labels as of 2026-10-19, they may drift):

   1. In the Vercel dashboard, choose **Create Blob Store** and set the access to **Public**.
   2. Connect the store to the project for Production and Preview.
   3. Leave **Add a read-write token env var to this connection** unchecked.

   Connecting adds `BLOB_STORE_ID` (and `BLOB_WEBHOOK_PUBLIC_KEY`, which the server does not use) but no token. The function then authenticates to Blob with the OIDC token Vercel attaches to each invocation, so the project holds no long-lived Blob secret. Cron invocations get the token too, so the daily cleanup works the same way.

   The supported alternative is the CLI:

   ```
   npx vercel blob create-store <name> --access public --yes
   ```

   With `--yes` the store is connected to Production, Preview and Development, and the CLI sets `BLOB_READ_WRITE_TOKEN` in all three as a plain (Config) variable. It does not set `BLOB_STORE_ID`; the server derives the store id from the token. This works, and its cost is that the token, which can write and delete every image, stays readable in the dashboard and through `npx vercel env pull`.

   When both are present, the token wins. To use OIDC after a CLI setup, remove `BLOB_READ_WRITE_TOKEN` and make sure `BLOB_STORE_ID` is set.

3. Generate the two secrets. Each must be at least 32 characters; the server refuses to serve with a shorter one:

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   CRON_SECRET=$(openssl rand -base64 32)
   ```

   Save the `CONNECTOR_SECRET` value in a password manager now (on macOS, `printf %s "$CONNECTOR_SECRET" | pbcopy` copies it). It cannot be read back from Vercel once stored as a Secret, and you need it again for the connector header. Keep this shell session open until the next step is done, or use the saved value.

4. Add the variables from [.env.example](.env.example). The app secrets go to **production only**: a single-user deployment does not need them in Preview or Development, and copying them there widens exposure. Preview deployments then answer `500` with `server_misconfigured`, which is expected. Local runs read `.env.local`, filled in per `.env.example`; it is gitignored and never uploaded. Pass secrets on stdin, never with `--value`, so they stay out of shell history:

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production --sensitive
   printf %s "$CRON_SECRET" | npx vercel env add CRON_SECRET production --sensitive
   npx vercel env add OPENROUTER_API_KEY production --sensitive
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
   | `BLOB_READ_WRITE_TOKEN` | one of the two | Read-write token for the store, written as a plain variable by the CLI path. When set, it is used for every Blob call. |
   | `BLOB_STORE_ID` | one of the two | Store id, with or without a `store_` prefix. Required without a token, where the function uses the platform's OIDC token. With a token it is optional and overrides the id inside the token for the public base URL. |
   | `DEFAULT_MODEL` | no | Model used when a call names none. Empty uses the built-in default. |
   | `RETENTION_DAYS` | no | Days an image is kept. Empty means 30. |
   | `OPENROUTER_REFERER` | no | `HTTP-Referer` sent to OpenRouter. Empty sends none. |

   A missing or weak required variable, or neither Blob variable, makes the server answer `500` with `server_misconfigured`. The log names the variable, never its value.

5. Deploy:

   ```
   npx vercel --prod
   ```

   The command prints two URLs. Use the one labeled `Aliased`: it is the project's production domain, and `<project>.vercel.app` stands for it in this document. The one labeled `Production` is that single deployment's own URL. It sits behind Vercel's deployment protection and answers `302` (a redirect to a Vercel sign-in), so do not use it for the connector or the check below.

6. Check that the endpoint rejects unauthenticated requests:

   ```
   curl -i -X POST https://<project>.vercel.app/mcp
   ```

   The response must be `401` with `{"error":"unauthorized"}`.

   This check does not touch Blob. The next section has a second check that does.

## Add the connector in claude.ai

1. Open Customize > Connectors and add a custom connector.
2. URL: `https://<project>.vercel.app/mcp`.
3. Authentication: **No sign-in** (no OAuth). claude.ai shows a warning for this choice. It is expected: the request header in the next step is the authentication.
4. Request header: name `Authorization`, value `Bearer <CONNECTOR_SECRET>`.
5. Add it on claude.ai web or the desktop app first; the dialog with request headers is easiest to use there. Do not screenshot or share the dialog while it shows the header value.

The add completes directly, with no "Continue anyway" step. While adding, claude.ai sends an `initialize` request without headers and gets `401`, and it looks up OAuth metadata under `/.well-known/` and gets Vercel's static `404`. Both are expected. In Vercel's request log the first shows only as a `401`; the server logs nothing about it.

### First test: upload a photo

Before any generation, ask Claude to call `upload_image`, then pick any photo in the widget. This is the recommended first test because it costs nothing: it makes no OpenRouter request. When the widget shows the photo as uploaded, the Blob token, the store id and the public image URL derived from them all work end to end. A wrong Blob base URL (a bad `BLOB_STORE_ID`, or an unusable store id in the token) would otherwise first show up on the first paid `generate_image`, which would fail with "could not be saved" after the model had already been billed.

If the widget reports that the photo could not be uploaded, the server answered "The photo could not be saved. Try uploading it again." and logged the cause in the deployment's Vercel log as `upload save failed: <reason>`. The reason is one of:

- `blob base URL mismatch`: Blob accepted the write, but the URL it returned differs from the one the server derives from `BLOB_STORE_ID` or the token. Fix or remove `BLOB_STORE_ID`, redeploy and retry.
- an error from the Blob SDK, such as an invalid or revoked token: check `BLOB_READ_WRITE_TOKEN`. Without a token, check that the store is connected to the project for the environment you are testing.

If claude.ai reports a "Connection issue" saying the server asked for sign-in (status 401), the header value is wrong or missing.

### Using it

claude.ai has its own ways to make visuals, and it may use them for a request such as "draw a recipe card". The first time in a conversation, name the connector, for example "use litho-mcp to generate a recipe card". Once litho-mcp has been used in a conversation, Claude keeps using it there.

## Rotate the secret

1. Generate a new value and save it in a password manager:

   ```
   CONNECTOR_SECRET=$(openssl rand -base64 32)
   printf %s "$CONNECTOR_SECRET" | pbcopy   # macOS; elsewhere, copy it by hand
   ```

2. Replace the variable. Do not run this with an empty `CONNECTOR_SECRET`; the server would refuse to serve.

   ```
   printf %s "$CONNECTOR_SECRET" | npx vercel env add CONNECTOR_SECRET production --sensitive --force
   ```

3. Redeploy with `npx vercel --prod`. The old connector fails at once, and claude.ai shows "This connector's stored credential was rejected". That message is about the connector secret, not the OpenRouter key.
4. Remove the connector in claude.ai and add it again with the new header value. The headers of an existing connector cannot be edited.

`env add --force` replaces any variable, so `CRON_SECRET` and `OPENROUTER_API_KEY` rotate the same way (create the new OpenRouter key in its dashboard first). Rotating `CRON_SECRET` needs no connector change.

## Retention

Images are deleted `RETENTION_DAYS` days after creation (default 30). Cleanup is a Vercel Cron job that runs once a day, around 03:00 UTC (`vercel.json`; Hobby cron timing is only precise to the hour), so an image can outlive the setting by up to about a day. Changing `RETENTION_DAYS` takes effect after a redeploy.

## Limits

- Going over a Vercel Hobby or Blob quota pauses the service for up to 30 days. Hobby and Blob do not bill for overage.
- The Hobby plan is for non-commercial use.
- Model spending is billed by OpenRouter and is bounded only by the limit you set on the key.

## Security notes

- Image links are capability URLs: the Blob store is public, and anyone holding a link can view that image. Links are unguessable and are not listed anywhere, but treat them like shared secrets. Images are deleted after the retention period.
- Vercel Blob counts every download against the Hobby data-transfer quota, cache hits included: 10 GB a month (checked 2026-10-18 at <https://vercel.com/docs/vercel-blob/usage-and-pricing>, updated 2026-09-23). Going over pauses Blob access for up to 30 days, so a widely shared link can pause the deployment.
- To revoke one leaked image, run `npx vercel blob del <url>` (flags checked against Vercel CLI 64.5.0; see the `--oidc-token` note under [Development](#development)). Because of CDN propagation, the image can stay reachable for up to about 60 seconds after deletion.
- On OIDC the project holds no Blob secret. With `BLOB_READ_WRITE_TOKEN`, anyone who can read the project's variables can write and delete every image.
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
- After replacing an uploaded photo, wait about a minute before asking for an edit, or the previous photo may still be used. The widget shows the same note ("Claude can use the new photo in about a minute.") after a replacement.
- Android is untested.

## Remove a deployment

Run the `vercel blob` commands from the linked clone. After `npx vercel link`, `.env.local` holds `VERCEL_OIDC_TOKEN` without `BLOB_STORE_ID`, and these commands fail until you remove the `VERCEL_OIDC_TOKEN` line or pass the matching flags (`--rw-token`, or `--oidc-token` with `--store-id`); see [Development](#development).

1. Empty the linked project's store: `npx vercel blob empty-store`.
2. Find the store id with `npx vercel blob list-stores --all` (it looks like `store_...`), then delete the store with `npx vercel blob delete-store <store id>`. This command has no `--yes` and refuses a store that is not empty.
3. Remove the project: `npx vercel project remove <name>`.
4. Remove the connector in claude.ai.

## License

[MIT](LICENSE)
