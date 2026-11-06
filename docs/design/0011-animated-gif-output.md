# 0011. Animated GIF output

- Status: Accepted. Extends the output formats of [0003](0003-model-agnostic-openrouter.md) and [0010](0010-vercel-blob-storage.md). Validated in production on 2026-11-06. Revised on 2026-11-06 for Claude's preview.
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

## Validation (2026-11-06)

- A GIF generated through OpenRouter in production was stored and animated in the widget, so the route accepts `output_format: gif`.
- Claude couldn't tell whether it was animated. Its preview was the first frame only, and its sandbox's network allowlist blocked the Blob host, so it couldn't download the image.

## Revision (2026-11-06)

- For a GIF, the result now tells Claude what the animation is: the frame count, the timing and the loop count. A single-frame GIF is reported as not animated.
- An animated GIF's preview is a contact sheet instead of the first frame: up to 9 frames, evenly spaced with the first and last included, in a grid read left to right, then top to bottom. Other formats keep the plain preview.
- Building the sheet decodes up to 9 frames, one at a time, which adds a fraction of a second to a GIF result.

## Validation (2026-11-06, after the revision)

- A 1:1 GIF of 12 frames at 150 ms each was generated with `openai/gpt-image-2.6-flare`. OpenRouter therefore passes `frame_count` and `frame_duration_ms` through; the model's default is 9 frames.
- It cost $0.131, about seven times the highest still generation seen in acceptance ($0.019, [0003](0003-model-agnostic-openrouter.md)). This is one sample: how the cost varies with the frame count or the size is not known.
- Claude reported the frame count, the timing and the loop from the result, and described the motion from the contact sheet.
