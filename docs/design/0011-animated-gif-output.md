# 0011. Animated GIF output

- Status: Accepted. Extends the output formats of [0003](0003-model-agnostic-openrouter.md) and [0010](0010-vercel-blob-storage.md). Not yet validated on a deployment.
- Date: 2026-11-05

## Context

- GPT Image 2.6 can return an animated GIF: `output_format: "gif"`, with `frame_count` (2–16, default 9) and `frame_duration_ms` (20–2000, default 200). GIF output takes no custom `output_compression` ([OpenAI API reference](https://developers.openai.com/api/reference/resources/images/methods/generate), checked 2026-11-05).
- OpenRouter's catalog lists `gif` under `output_format` for `openai/gpt-image-2.6-flare` and `openai/gpt-image-2.6-sunburst`, but doesn't declare the two frame settings. Its [image generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) documents them as request fields (checked 2026-11-05).
- Until now the server stored only PNG, JPEG and WebP.

## Decision

- `output_format: "gif"` is accepted where the model declares it. The result is detected by its magic bytes (GIF87a or GIF89a) and stored as `image/gif` under an `img_` id.
- `frame_count` and `frame_duration_ms` are accepted only with `output_format: "gif"`. They are checked against the catalog's descriptor if one appears, and otherwise against OpenAI's ranges above. `list_models` shows them for models that output gif.
- `output_compression` together with gif is rejected locally.
- Inputs don't change: uploads, reference URLs and `up_` objects stay PNG, JPEG and WebP. A stored GIF can't be an edit reference, because no model documents what it does with one. To change a GIF, generate a new one.
- The widget shows the GIF in its `<img>`, so it animates. Claude's thumbnail is a still WebP of the first frame, and the result text says so.

## Consequences

- No real GIF has gone through OpenRouter yet. The first call shows whether the route accepts gif and the frame settings, and what a GIF costs and weighs.
- GIFs are larger than stills, so they use more of the Blob transfer quota.
