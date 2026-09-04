# Publishing to the VS Code Marketplace

Everything in `package.json` is ready except one field only you can fill in.

## 0. The one thing to change

```jsonc
"publisher": "Smile1294"
```

This must be the **publisher ID you create in step 2**, exactly. It is not your
GitHub username and not your email — it is a separate identity on the
Marketplace. `vsce` refuses to publish if it does not match, so a wrong value
fails loudly rather than publishing under the wrong name.

The repository URLs point at `Smile1294/Agents-Kanban`. The capitalisation is
load-bearing: `github.com` redirects case-insensitively, but
`raw.githubusercontent.com` does NOT, so a lower-cased URL would 404 every
screenshot on the listing.

```jsonc
"repository": { "url": "https://github.com/Smile1294/Agents-Kanban.git" },
"bugs":       { "url": "https://github.com/Smile1294/Agents-Kanban/issues" },
"homepage":   "https://github.com/Smile1294/Agents-Kanban#readme"
```

If you pick a different repo name, change these **and** the image URLs at the
top of `README.md` — see step 5.

## 1. Azure DevOps account

The Marketplace runs on Azure DevOps identity. Sign in at
<https://dev.azure.com> with a Microsoft account and create an organisation
(the name does not matter and is never shown).

## 2. Create a publisher

Go to <https://marketplace.visualstudio.com/manage>, sign in with the same
account, and **Create publisher**. The **ID** you choose is what goes in
`package.json`; the display name is what users see.

## 3. Personal Access Token

In Azure DevOps → **User settings → Personal access tokens → New Token**:

| Field | Value |
|---|---|
| Organization | **All accessible organizations** — not your single org |
| Scopes | **Custom defined** → **Marketplace → Manage** |
| Expiration | up to a year |

Copy the token now; it is never shown again. Getting the *organization* field
wrong is the single most common cause of a `401` at publish time.

```bash
node scripts/run-bin.mjs @vscode/vsce vsce login <your-publisher-id>
```

## 4. Check what you are about to ship

```bash
npm run verify          # typecheck, build, tests, launch gates
npm run verify:package  # builds a real .vsix and checks what is inside it
```

`verify:package` matters more than it sounds. The Agent SDK and `zod` are
*externals*, so a package built without dependencies installed will install
perfectly and then die on the first dynamic import.

## 5. Images

The README is the Marketplace listing page, and **relative image paths do not
resolve there**. Every screenshot link is therefore an absolute
`raw.githubusercontent.com` URL pointing at the `main` branch.

Two consequences:

- The images only appear once the repo is **public** and the branch is pushed.
  Publish the extension after pushing, not before.
- Rename the repo or the default branch and every image on the listing breaks.
  If you do, update the URLs in `README.md` to match.

`docs/screenshots/**` is excluded from the `.vsix` on purpose — the listing
pulls them from GitHub, so shipping them again would only make the download
bigger.

## 6. Publish

```bash
node scripts/run-bin.mjs @vscode/vsce vsce publish            # uses package.json version
node scripts/run-bin.mjs @vscode/vsce vsce publish minor      # bumps first
```

The listing takes a few minutes to appear. Verification of a new publisher can
take longer.

## Before the first publish

- [ ] `publisher` matches the publisher ID you created
- [ ] Repo made **public** — the listing's images are served from it, and a
      private repo returns 404 for every one of them
- [ ] `version` is not still `0.0.1`
- [ ] `npm run verify` and `npm run verify:package` both pass
- [ ] The README renders correctly on GitHub — that is what the listing will
      look like

## Notes

- **The name.** The extension is deliberately not called "Claude" anything.
  "Claude" is Anthropic's trademark, and a Marketplace listing in the AI
  category using it would invite a complaint and brush against the Marketplace
  naming and impersonation policy. Saying it *works with* Claude Code, as the
  README does, is ordinary descriptive use and fine.
- **The Claude Code CLI is not bundled**, and must not be. It is excluded in
  `.vscodeignore`; shipping it would add ~190MB and pin users to whatever
  version we happened to package.
- **Licence.** MIT, in `LICENSE`. The Marketplace picks it up automatically.
