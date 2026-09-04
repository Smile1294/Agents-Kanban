/**
 * Images the user attaches to a message, and how they reach the model.
 *
 * The board's composer was text only, so "look at this screenshot" meant
 * describing a screenshot in words. Pasting one now attaches it.
 *
 * **They go to the model directly, as image content blocks.** A user message in
 * the Agent SDK is an Anthropic `MessageParam`, whose content may be an array of
 * blocks — text, image, document — so an attachment can ride along inside the
 * message itself. That matters for two reasons:
 *
 *  - Nothing is written anywhere. The alternative, which is what Nimbalyst does,
 *    is to stage each attachment as a file and hand the agent a path: it needs a
 *    staging directory, it needs the agent to spend a tool call reading it back,
 *    and staging into the workspace needs a `.gitignore` entry to stop every
 *    paste showing up as a git diff. This project has a rule against putting
 *    anything in the user's repository, and no staging means nothing to clean up.
 *  - The model sees the image on the turn it was sent, rather than after
 *    deciding to go and look at a file.
 *
 * The cost is tokens: an image is roughly `width * height / 750` of them, so a
 * retina screenshot of a whole screen is ~3.5k tokens before anyone has said
 * anything about it. Hence `MAX_EDGE` and the downscale in the webview — the
 * resize happens where the bitmap already is, and this module is what refuses
 * anything that arrives too big anyway.
 */

/** The formats the API accepts. Anything else is refused rather than sent and
 *  rejected mid-turn, which surfaces as a failed run for a reason nobody can
 *  see from the board. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_TYPES)[number]

/**
 * The long edge an attachment is scaled down to before sending.
 *
 * 1568px is the documented point past which an image is downscaled anyway, so
 * anything larger spends tokens on detail the model never receives. A 5K screen
 * grab lands at ~1568x880 and costs ~1.8k tokens instead of ~5k.
 */
export const MAX_EDGE = 1568

/** Bytes of base64 per image. The API's own limit is about 5MB; the cap here is
 *  lower because several of them share one turn. */
export const MAX_BYTES = 3_500_000

/** At most this many on one message. A paste-happy moment should not silently
 *  spend 30k tokens of context before the sentence starts. */
export const MAX_IMAGES = 8

/** An attachment as it crosses from the webview to the host. */
export interface AttachedImage {
  /** For the UI and for the transcript row. Never used as a filesystem path. */
  name: string
  mediaType: string
  /** Base64, with no `data:` prefix. */
  data: string
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: ImageMediaType; data: string }
}

export interface TextBlock {
  type: 'text'
  text: string
}

/** Is this one of the media types the API will take? */
export function isImageMediaType(t: string): t is ImageMediaType {
  return (IMAGE_TYPES as readonly string[]).includes(t)
}

/**
 * Keep only what can actually be sent, and say what was dropped.
 *
 * Deliberately returns the reasons rather than filtering silently: an image
 * that vanishes between pasting and sending is indistinguishable from one the
 * model ignored, and the user would have no way to tell which.
 */
export function sanitiseImages(
  input: readonly AttachedImage[],
): { images: AttachedImage[]; dropped: string[] } {
  const images: AttachedImage[] = []
  const dropped: string[] = []
  for (const im of input) {
    const name = typeof im?.name === 'string' && im.name.trim() ? im.name.trim().slice(0, 120) : 'image'
    if (!im || typeof im.data !== 'string' || !im.data) { dropped.push(`${name} — empty`); continue }
    if (!isImageMediaType(im.mediaType)) {
      dropped.push(`${name} — ${im.mediaType || 'unknown type'} is not a supported image format`)
      continue
    }
    // Base64 only. The data is about to be embedded in a JSON message to
    // another process; anything outside the alphabet is not an image.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) { dropped.push(`${name} — not valid base64`); continue }
    if (im.data.length > MAX_BYTES) {
      dropped.push(`${name} — ${Math.round(im.data.length / 1e6)}MB is over the ${Math.round(MAX_BYTES / 1e6)}MB limit`)
      continue
    }
    if (images.length >= MAX_IMAGES) { dropped.push(`${name} — more than ${MAX_IMAGES} images on one message`); continue }
    images.push({ name, mediaType: im.mediaType, data: im.data })
  }
  return { images, dropped }
}

/**
 * The content of a user message carrying attachments.
 *
 * A plain string when there is nothing attached — the overwhelmingly common
 * case, and the shape everything downstream already handles. Otherwise blocks,
 * with the TEXT FIRST: the sentence is what the images are for, and a model
 * reading the pictures before the question has to hold them without knowing
 * what it is looking for.
 *
 * An images-only message is allowed and gets no empty text block, because an
 * empty string is not a valid text block.
 */
export function userContent(
  text: string,
  images: readonly AttachedImage[] = [],
): string | Array<TextBlock | ImageBlock> {
  if (!images.length) return text
  const blocks: Array<TextBlock | ImageBlock> = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const im of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: im.mediaType as ImageMediaType, data: im.data },
    })
  }
  return blocks
}

/** Roughly what an image will cost, for the note on the transcript row. The
 *  published estimate is `width * height / 750`; from base64 alone the pixel
 *  count is unknown, so this works back from the bytes instead and is
 *  explicitly an approximation. */
export function approxTokens(images: readonly AttachedImage[]): number {
  // ~0.75 bytes of image per base64 char, and PNG screenshots run about 1.5
  // bytes per pixel. Deliberately rough — it is a hint, not an accounting.
  return Math.round(images.reduce((n, im) => n + (im.data.length * 0.75) / 1.5 / 750, 0))
}

/** `2 images` / `1 image`, for a transcript row that must say something was
 *  sent even though the bytes are not kept in the board's state. */
export function describeImages(count: number): string {
  return `${count} image${count === 1 ? '' : 's'}`
}
