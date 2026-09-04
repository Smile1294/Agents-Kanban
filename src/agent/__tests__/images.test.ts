/* What reaches the model when a message carries images, and what is refused.

   The host half of the attachment path. Everything here arrives from the
   webview, which is another program by the time this code runs, and it is about
   to be embedded in a JSON message to a child process — so the checks are not
   politeness, they are the boundary. */
import {
  IMAGE_TYPES, MAX_BYTES, MAX_IMAGES, approxTokens, describeImages,
  isImageMediaType, sanitiseImages, userContent, type AttachedImage,
} from '../images.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const img = (over: Partial<AttachedImage> = {}): AttachedImage =>
  ({ name: 'shot.png', mediaType: 'image/png', data: 'aGVsbG8=', ...over })

// ---------------------------------------------------------------------------
// 1. A text-only message keeps the shape everything downstream already handles.
ok(userContent('just words') === 'just words',
   'with no images the content is the plain string it always was')
ok(userContent('just words', []) === 'just words', 'an empty array is the same as none')

// ---------------------------------------------------------------------------
// 2. With images it becomes blocks, TEXT FIRST.
//
// The sentence is what the pictures are for. A model reading the images before
// the question has to hold them without knowing what it is looking for.
const blocks = userContent('what is wrong here?', [img(), img({ name: 'b.png' })])
ok(Array.isArray(blocks), 'with images the content is an array of blocks')
if (Array.isArray(blocks)) {
  ok(blocks.length === 3, `one text block and both images (${blocks.length})`)
  ok(blocks[0]?.type === 'text', 'the text comes first')
  ok(blocks[1]?.type === 'image' && blocks[2]?.type === 'image', 'then the images, in order')
  const first = blocks[1]
  if (first?.type === 'image') {
    ok(first.source.type === 'base64', 'each image is a base64 source')
    ok(first.source.media_type === 'image/png', 'with the media type the API expects')
    ok(first.source.data === 'aGVsbG8=', 'and the data exactly as it arrived')
    ok(!String(first.source.data).startsWith('data:'),
       'never a data: URL — that is a browser thing and the API rejects it')
  }
}

// An images-only message gets NO text block: an empty string is not a valid one.
const only = userContent('', [img()])
ok(Array.isArray(only) && only.length === 1 && only[0]?.type === 'image',
   'an images-only message carries just the image')
ok(Array.isArray(userContent('   ', [img()])) && (userContent('   ', [img()]) as unknown[]).length === 1,
   'and whitespace does not count as text')

// ---------------------------------------------------------------------------
// 3. What is refused, and the fact that refusal is REPORTED.
//
// An attachment that disappears between pasting and sending is
// indistinguishable from one the model looked at and ignored.
const mixed = sanitiseImages([
  img({ name: 'good.png' }),
  img({ name: 'movie.mp4', mediaType: 'video/mp4' }),
  img({ name: 'empty.png', data: '' }),
  img({ name: 'weird.png', mediaType: 'image/tiff' }),
  img({ name: 'notb64.png', data: 'not base64!!' }),
])
ok(mixed.images.length === 1 && mixed.images[0]?.name === 'good.png',
   `only the sendable one survives (${mixed.images.map((i) => i.name).join(', ')})`)
ok(mixed.dropped.length === 4, `and every refusal is reported (${mixed.dropped.length})`)
ok(mixed.dropped.some((d) => d.includes('video/mp4')), 'naming the type that was wrong')
ok(mixed.dropped.every((d) => /good/.test(d) === false), 'and never the one that was fine')

for (const t of IMAGE_TYPES) {
  ok(isImageMediaType(t), `${t} is accepted`)
  ok(sanitiseImages([img({ mediaType: t })]).images.length === 1, `and survives sanitising`)
}
ok(!isImageMediaType('image/bmp'), 'image/bmp is not one the API takes, so it is not offered')
ok(!isImageMediaType('IMAGE/PNG'), 'and the check is not case-fudged — the API wants the exact token')

// Base64 with URL-safe characters is not base64 the API will decode.
ok(sanitiseImages([img({ data: 'ab-_cd' })]).images.length === 0,
   'url-safe base64 is refused rather than sent and rejected mid-turn')
ok(sanitiseImages([img({ data: 'aGVsbG8' })]).images.length === 1, 'unpadded base64 is fine')

// ---------------------------------------------------------------------------
// 4. The size and count limits.
const huge = sanitiseImages([img({ name: 'huge.png', data: 'A'.repeat(MAX_BYTES + 4) })])
ok(huge.images.length === 0, 'an image over the byte limit is refused')
ok(!!huge.dropped[0]?.includes('MB'), `and the reason says how big it was: ${huge.dropped[0]}`)

const many = sanitiseImages(Array.from({ length: MAX_IMAGES + 3 }, (_, i) => img({ name: `n${i}.png` })))
ok(many.images.length === MAX_IMAGES, `at most ${MAX_IMAGES} images survive (${many.images.length})`)
ok(many.dropped.length === 3, 'and the extras are reported rather than dropped quietly')

// ---------------------------------------------------------------------------
// 5. Names are for display only and must not be usable as a path.
const named = sanitiseImages([img({ name: '../../.ssh/id_rsa' })])
ok(named.images.length === 1, 'a hostile name does not refuse the image — the name is never a path')
ok(named.images[0]?.name === '../../.ssh/id_rsa',
   'it is carried verbatim, because nothing opens it: the bytes are already here')
ok(sanitiseImages([img({ name: '' })]).images[0]?.name === 'image', 'an empty name gets a placeholder')
ok(sanitiseImages([img({ name: 'x'.repeat(400) })]).images[0]?.name.length === 120,
   'and a very long one is bounded, so it cannot bloat a transcript row')

// A missing or malformed entry must not throw — this crosses a process boundary.
const junk = sanitiseImages([
  undefined as unknown as AttachedImage,
  {} as AttachedImage,
  { name: 'x', mediaType: 'image/png' } as AttachedImage,
])
ok(junk.images.length === 0 && junk.dropped.length === 3,
   'malformed entries are refused, not thrown on')

// ---------------------------------------------------------------------------
// 6. The estimate and the wording.
ok(approxTokens([]) === 0, 'no images cost nothing')
ok(approxTokens([img({ data: 'A'.repeat(1_500_000) })]) > 500,
   `a megabyte-and-a-half screenshot is a four-figure token cost (${approxTokens([img({ data: 'A'.repeat(1_500_000) })])})`)
ok(describeImages(1) === '1 image' && describeImages(3) === '3 images', 'singular and plural')

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — attachments reach the model as image blocks, or are refused out loud')
process.exit(fails ? 1 : 0)
