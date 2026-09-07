/** The HTML document the headless server sends for the board and the settings
 *  page. Pure — a string in, a string out — so `theme.test.mjs` can assert on
 *  the REAL document order rather than on how server.mjs happens to be written:
 *  the bug this guards against was a page that supplied no theme at all, and
 *  the fix is only a fix if theme.css is in the document, before the sheets
 *  that read its variables.
 *
 *  theme.css FIRST, before either app stylesheet. Every colour in board.css is
 *  `var(--vscode-*)`; in the editor VS Code sets those inline on <html>, and in
 *  a browser nobody does — so without that sheet every var() resolved to
 *  nothing and the board painted as a white page with black text. The sheet is
 *  the Dark Modern palette on :root, and theme.test.mjs checks it covers every
 *  variable the stylesheets use.
 *
 *  Both scripts live in the BODY, after #root, and the bridge is first:
 *  board.js and settings.js call acquireVsCodeApi() the moment they load —
 *  exactly as they do in the real webview, where VS Code injects the API before
 *  any script runs — and they need #root to exist, which is why they sit in the
 *  body rather than the head.
 */
export function pageHtml(which) {
  const settings = which === 'settings'
  const app = settings
    ? '<link rel="stylesheet" href="/media/board.css"><link rel="stylesheet" href="/media/settings.css">'
    : '<link rel="stylesheet" href="/media/board.css">'
  return `<!DOCTYPE html>
<html lang="en"${settings ? '' : ' data-layout="board"'}>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Agents Kanban${settings ? ' — Settings' : ''}</title>
<link rel="stylesheet" href="/media/theme.css">
${app}
<link rel="stylesheet" href="/bridge.css">
</head>
<body${settings ? ' class="settings"' : ''}>
<div id="root"></div>
<script src="/bridge.js" data-surface="${settings ? 'settings' : 'board'}"></script>
<script src="${settings ? '/media/settings.js' : '/media/board.js'}"></script>
</body>
</html>`
}
