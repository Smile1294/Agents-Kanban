/* Attaching an image to a message, in the view layer.

   This is the riskiest code added to board.js in a while: it runs inside event
   handlers the host never sees, it touches four browser APIs, and a throw in
   any of them is a silently blank panel with no error anywhere — the failure
   this file's stub DOM exists to catch.

   The downscale is asserted as well as the plumbing, because it is not
   cosmetic: an image costs roughly width×height/750 tokens, so a retina screen
   grab that goes through unscaled spends ~5k tokens of the context the board
   now displays, on detail the service discards anyway. */
import { boardSource, fakeImageFile, renderBoardWith, walk } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const src = await boardSource()
const run = (state) => renderBoardWith(src, state, { layout: 'board' })

const COLUMNS = [{ id: 'implementing', name: 'Implementing', category: 'started' }]
const CARD = {
  key: 'abc', sessionId: 'abc', title: 'Fix login', phase: 'implementing', tags: [], updated: 1,
}
const chat = {
  ready: true, mode: 'chat', selectedKey: 'abc', columns: COLUMNS, cards: [CARD], transcript: [],
  composer: {
    model: 'claude-opus-5', effort: 'high', thinking: 'enabled',
    models: [{ id: 'claude-opus-5', label: 'Opus 5', context: '1M' }],
    efforts: [{ key: 'high', label: 'High' }], contextTokens: 0,
    permissionMode: 'acceptEdits', permissionModes: [{ key: 'acceptEdits', label: 'Auto', detail: 'x' }],
  },
  running: 0, waiting: 0,
}

const find = (root, pred) => walk(root).find(pred)
const byClass = (root, cls) => find(root, (n) => (n.className || '').split(' ').includes(cls))
const allByClass = (root, cls) => walk(root).filter((n) => (n.className || '').split(' ').includes(cls))
const textarea = (root) => find(root, (n) => n.tagName === 'textarea')

/** Paste files the way a browser does: items of kind "file" on clipboardData. */
const paste = (root, files) => {
  let prevented = false
  textarea(root).onpaste({
    preventDefault: () => { prevented = true },
    clipboardData: {
      items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    },
  })
  return prevented
}

// ---------------------------------------------------------------------------
// 1. A pasted screenshot becomes an attachment on the message being composed.
{
  const b = run(chat)
  const prevented = paste(b.root, [fakeImageFile('shot.png', 'image/png', { width: 800, height: 600 })])
  ok(prevented, 'pasting an image takes over the paste — it must not also land as text')
  const chips = allByClass(b.root, 'attachment')
  ok(chips.length === 1, `one attachment is shown (${chips.length})`)
  const thumb = byClass(b.root, 'attachment-thumb')
  ok(!!thumb && String(thumb.src).startsWith('data:image/png;base64,'),
     'with a thumbnail of the image itself')
  ok(b.root.textContent.includes('1 image will be sent'),
     `and the composer says it will be sent: ${/\d+ images? will be sent[^.]*/.exec(b.root.textContent)?.[0]}`)
}

// ---------------------------------------------------------------------------
// 2. Pasting TEXT must still be ordinary pasting. The clipboard carries a
// text/plain flavour alongside a copied image on some platforms, so a handler
// that always prevents the default breaks typing.
{
  const b = run(chat)
  let prevented = false
  textarea(b.root).onpaste({
    preventDefault: () => { prevented = true },
    clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
  })
  ok(!prevented, 'pasting text is left alone')
  ok(allByClass(b.root, 'attachment').length === 0, 'and attaches nothing')
}

// ---------------------------------------------------------------------------
// 3. Sending carries the images, and clears them.
{
  const b = run(chat)
  paste(b.root, [
    fakeImageFile('a.png', 'image/png', { width: 400, height: 300, data: 'AAA' }),
    fakeImageFile('b.png', 'image/png', { width: 400, height: 300, data: 'BBB' }),
  ])
  const ta = textarea(b.root)
  ta.oninput({ target: { value: 'what is wrong here?', style: {} } })
  byClass(b.root, 'send').onclick()

  const sent = b.posted.filter((m) => m.type === 'send')
  ok(sent.length === 1, `sending posts one message (${sent.length})`)
  ok(sent[0]?.text === 'what is wrong here?', 'with the text')
  ok(sent[0]?.images?.length === 2, `and both images (${sent[0]?.images?.length})`)
  ok(sent[0]?.images?.[0]?.data === 'AAA' && sent[0]?.images?.[1]?.data === 'BBB',
     'as raw base64, in order, with no data: prefix')
  ok(sent[0]?.images?.[0]?.mediaType === 'image/png', 'and the media type the API needs')
  ok(allByClass(b.root, 'attachment').length === 0,
     'and the strip is emptied — a sent image must not ride along on the next message too')
}

// ---------------------------------------------------------------------------
// 4. An images-only message is a real message.
//
// "Look at this" with a screenshot says everything it needs to, and the old
// `if (!text) return` would have swallowed it silently.
{
  const b = run(chat)
  paste(b.root, [fakeImageFile('only.png', 'image/png', {})])
  byClass(b.root, 'send').onclick()
  const sent = b.posted.filter((m) => m.type === 'send')
  ok(sent.length === 1 && sent[0].text === '' && sent[0].images.length === 1,
     'an image with no text is sent')
}
// ...but an empty message with neither is still nothing.
{
  const b = run(chat)
  byClass(b.root, 'send').onclick()
  ok(b.posted.filter((m) => m.type === 'send').length === 0, 'an entirely empty message is not sent')
}

// ---------------------------------------------------------------------------
// 5. The downscale. A 3000×2000 screenshot must not be sent at full size.
{
  const b = run(chat)
  paste(b.root, [fakeImageFile('huge.png', 'image/png', { width: 3000, height: 2000, data: 'HUGE' })])
  byClass(b.root, 'send').onclick()
  const im = b.posted.find((m) => m.type === 'send').images[0]
  ok(im.data === 'SCALED', `an oversized image is re-encoded, not passed through (${im.data})`)
  ok(im.mediaType === 'image/png', 'and stays PNG — a screenshot is text and edges, which JPEG smears')
}
// An image already within the limit is passed through untouched: re-encoding it
// would cost quality for nothing.
{
  const b = run(chat)
  paste(b.root, [fakeImageFile('small.png', 'image/png', { width: 900, height: 400, data: 'SMALL' })])
  byClass(b.root, 'send').onclick()
  ok(b.posted.find((m) => m.type === 'send').images[0].data === 'SMALL',
     'an image inside the limit is sent as it came')
}

// ---------------------------------------------------------------------------
// 6. Removing one, and the cap.
{
  const b = run(chat)
  paste(b.root, [
    fakeImageFile('x.png', 'image/png', { data: 'XXX' }),
    fakeImageFile('y.png', 'image/png', { data: 'YYY' }),
  ])
  allByClass(b.root, 'attachment-x')[0].onclick()
  ok(allByClass(b.root, 'attachment').length === 1, 'the × takes one attachment off')
  byClass(b.root, 'send').onclick()
  ok(b.posted.find((m) => m.type === 'send').images[0].data === 'YYY',
     'and the one that is left is the one that is sent')
}
{
  const b = run(chat)
  paste(b.root, Array.from({ length: 12 }, (_, i) =>
    fakeImageFile(`n${i}.png`, 'image/png', { data: 'N' + i })))
  ok(allByClass(b.root, 'attachment').length === 8,
     `at most eight images on one message (${allByClass(b.root, 'attachment').length})`)
}

// ---------------------------------------------------------------------------
// 7. Things that are not images, and things that claim to be and are not.
{
  const b = run(chat)
  paste(b.root, [{ name: 'notes.txt', type: 'text/plain', _dataUrl: 'data:text/plain;base64,x' }])
  ok(allByClass(b.root, 'attachment').length === 0, 'a text file pasted as a file is not attached')

  // A file whose bytes will not decode. In a browser this is `img.onerror`;
  // the stub reaches it by having no dimensions registered for the URL.
  paste(b.root, [{ name: 'lies.png', type: 'image/png', _dataUrl: 'data:image/png;base64,NOTREALLY' }])
  ok(allByClass(b.root, 'attachment').length === 0,
     'and a file that claims to be an image but will not decode is dropped, not thrown on')
}

// ---------------------------------------------------------------------------
// 8. Dropping a file in from Finder is the other half of the same path.
{
  const b = run(chat)
  const ta = textarea(b.root)
  let prevented = false
  ta.ondragover({ preventDefault: () => { prevented = true } })
  ok(prevented, 'dragover is prevented — without it the webview navigates to the file')
  ta.ondrop({
    preventDefault: () => {},
    dataTransfer: { files: [fakeImageFile('dropped.png', 'image/png', { data: 'DROP' })] },
  })
  ok(allByClass(b.root, 'attachment').length === 1, 'a dropped image is attached')
}

// ---------------------------------------------------------------------------
// 9. Attachments survive the repaints an agent causes.
//
// Same failure mode as the collapsed panels and the scroll positions: the
// composer is rebuilt several times a second while an agent works, and a
// screenshot held in the DOM would be gone before it could be sent.
{
  const b = run(chat)
  paste(b.root, [fakeImageFile('keep.png', 'image/png', { data: 'KEEP' })])
  b.deliver({ ...chat, streaming: 'the agent is talking' })
  ok(allByClass(b.root, 'attachment').length === 1,
     'an attachment survives a frame from the agent')
  b.deliver({ ...chat, streaming: 'still talking' })
  b.deliver({ ...chat, streaming: 'and again' })
  byClass(b.root, 'send').onclick()
  ok(b.posted.find((m) => m.type === 'send')?.images?.[0]?.data === 'KEEP',
     'and is still the one that gets sent after several')
}

// ---------------------------------------------------------------------------
// 10. A new session can start with an image. "Build me this" plus a mockup is
// the case, and it goes through newSession rather than send.
{
  const b = run({ ...chat, selectedKey: undefined, cards: [] })
  paste(b.root, [fakeImageFile('mockup.png', 'image/png', { data: 'MOCK' })])
  byClass(b.root, 'send').onclick()
  const started = b.posted.filter((m) => m.type === 'newSession')
  ok(started.length === 1 && started[0].images?.[0]?.data === 'MOCK',
     'a new session can be started from an image')
}

// ---------------------------------------------------------------------------
// 11. The transcript says an image went with a message. The bytes are not kept
// in the board's state, so without the note an images-only message renders as
// an empty bubble and the history looks like nothing was sent.
{
  const b = run({
    ...chat,
    transcript: [
      { kind: 'prompt', at: 1, text: 'what is wrong here?', images: 2 },
      { kind: 'prompt', at: 2, text: '', images: 1 },
      { kind: 'prompt', at: 3, text: 'no pictures' },
    ],
  })
  const t = b.root.textContent
  ok(t.includes('2 images attached'), `a message says how many images it carried: ${/\d+ images? attached/.exec(t)?.[0]}`)
  ok(t.includes('1 image attached'), 'singular for one')
  ok((t.match(/attached/g) || []).length === 2, 'and a message with none says nothing about images')
}

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — a pasted image reaches the message, downscaled, and survives the repaints')
process.exit(fails ? 1 : 0)
