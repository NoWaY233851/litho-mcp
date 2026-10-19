# 0003. Model-agnostic via the OpenRouter Image API

- Status: Accepted. Revised on 2026-10-18 for billing-accurate error messages. Costs observed in acceptance on 2026-10-18 and 2026-10-19.
- Date: 2026-10-16

## Context

Claude can't generate images itself. OpenRouter offers a dedicated, synchronous endpoint:

- **Request:** `POST /api/v1/images`
- **Response:**
  - `data[].b64_json` holds raw base64;
  - `data[].media_type` holds the format;
  - `usage.cost` holds the charge.
- **Editing:** reference images go in `input_references`, as http(s) or data URLs.

`GET /api/v1/images/models` lists every image model. On 2026-10-16 there were 59.

- Each model has typed `supported_parameters` descriptors: `{type:"enum",values}`, `{type:"range",min,max}`, or `{type:"boolean"}`.
- `boolean` means "supported, value unconstrained". For example, krea declares `seed` this way, yet seed is an integer.
- A missing key means "not supported".
- `architecture.input_modalities` tells you whether the model accepts images.
- `input_references.min ≥ 1` marks edit-only models.
- Pricing comes from `GET /api/v1/models?output_modalities=image`.

The default model, `openai/gpt-image-2.5-flare`, declares:

| Parameter | Values |
|---|---|
| `aspect_ratio` | 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, auto |
| `quality` | auto … max |
| `background` | auto, transparent, opaque |
| `n` | 1–10 |
| `input_references` | 0–16 |
| `output_compression` | 0–100 |

It declares neither `output_format` nor `resolution`.

OpenRouter's errors (the docs are inconsistent about which code a spent limit uses):

| Code | Meaning |
|---|---|
| 400 | Bad or unsupported request |
| 402 / 403 | Credit or spending limit reached |
| 403 | Moderation refusal |
| 404 | Unknown model |
| 408 / 502 / 504 / 524 / 529 | Failure or timeout; 502 isn't billed |

Remaining spend is available from `GET /api/v1/key`.

## Decision

**Tools and parameters**
- Every call goes through `POST /api/v1/images`. Tools take an optional `model`, and the default comes from the `DEFAULT_MODEL` variable (`openai/gpt-image-2.5-flare`).
- Tools accept one fixed set of OpenRouter's cross-model parameters: `aspect_ratio`, `resolution`, `quality`, `background`, `output_format`, `output_compression`, `seed`.
- Not exposed:
  - `n`: one image per call;
  - `size`: conflicts with `resolution` and `aspect_ratio`;
  - `stream`;
  - `provider`;
  - provider passthrough options.

**Local validation**
- The model catalog is fetched with the key and cached for an hour.
- Every request is validated locally against the chosen model's descriptors before OpenRouter is called. Failures name the supported parameters and values.
- Unknown models point Claude to `list_models`.
- Generating with an edit-only model points it to `edit_image`.
- Editing with a text-only model, or with too many references, is rejected.
- `output_format: "svg"` is always rejected. If a model returns something that isn't PNG, JPEG or WebP anyway, the call fails cleanly and nothing is stored.

**Tools and errors**
- `list_models` shows, per model:
  - whether it can edit;
  - its maximum references;
  - which of the parameters above it supports, and their values;
  - a pricing summary.
- OpenRouter errors become short, actionable messages. A message claims "not charged" only where OpenRouter documents it:
  - **Limit reached:** any 402, or a 403 whose metadata carries a spending `limit_source` or `limit_usd`. The message includes the limit, the remaining amount and the reset period from `/api/v1/key`.
  - **Moderation:** a 403 that is not a limit error counts as moderation only when its metadata carries moderation fields (`reasons`, `flagged_input`, `provider_name`). The message names the provider, and the reason if given. Any other 403 (permissions, guardrails) gets OpenRouter's message passed through.
  - **502 from OpenRouter:** the message says the call wasn't charged and can be retried. This is the only case that claims "not charged".
  - **408, 504, 524 and 529:** the message says the call failed or timed out and can be retried, with no billing claim.
  - **The server's own 200-second timeout:** the generation may still finish and be billed, so the message says to check OpenRouter activity before retrying.
  - **Failures after OpenRouter answered 2xx:** no image in the response, an unsupported format (SVG or anything that isn't PNG, JPEG or WebP), an unreadable response, or a body cut off mid-transfer. The message says the call may have been billed, includes the reported cost when OpenRouter gives one, and doesn't suggest a bare retry. For an empty result it suggests changing the prompt or the model.
  - **Errors reported inside a 200 body:** classified like the same error returned as an HTTP status.
  - **A network failure before any response:** the message says the call can be retried, with no billing claim.
  - **Everything else:** OpenRouter's message is passed through, cut to 500 characters.
- No stack traces or keys appear in messages, and no bodies are logged. Only the metadata fields the messages use are kept.

**Request settings**
- The OpenRouter request timeout is 200 seconds, inside Claude's 240-second limit.
- Attribution uses `X-OpenRouter-Title: litho-mcp`. `HTTP-Referer` is sent only when configured.

**Spend control**
- Spend control is OpenRouter's per-key limit. The README tells deployers to set one.

## Consequences

- New OpenRouter image models work without code changes.
- A model's provider-specific extras stay unavailable.
- Two catalog calls per hour per running server instance; a cold instance fetches the catalog again. Validation errors cost nothing.
- Parameter support depends on OpenRouter's descriptors being accurate.

## Revision (2026-10-18)

- The error-message rules no longer say that every failure or timeout wasn't charged. Image generation is billed all-or-nothing, and OpenRouter documents that a generation that doesn't complete returns 502 and isn't billed ([image generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), checked 2026-10-18).
- OpenRouter sends a 200 as soon as the provider accepts the request, so generation errors can arrive inside a 200 body, and prompt processing may still be charged ([errors and debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging), checked 2026-10-18). Failures after a 2xx therefore warn that the call may have been billed.
- No billing statement covers 408, 504, 524, 529 or a client-side timeout, so those messages make no claim, and the timeout message tells Claude to check OpenRouter activity before retrying.
- A 403 is treated as moderation only when it carries moderation metadata, so permission and guardrail errors are no longer mislabelled.

## Validation (2026-10-18 and 2026-10-19, acceptance)

Costs observed with the default model on the production deployment.

- Generations cost $0.005 to $0.019 and edits $0.015 to $0.071. The highest was a text replacement on a larger image.
- A 2:3 recipe card cost $0.043.
