#!/bin/sh
# Run a command with a usable Node on PATH.
#
# F5 runs a task, VS Code runs tasks through a NON-INTERACTIVE shell, and every
# version manager — nvm, fnm, asdf — installs itself in ~/.bashrc, which begins
# by returning immediately when the shell is not interactive. So `node` and
# `npm` exist in your terminal and do not exist in the task that F5 waits for.
#
# Whether you ever see this depends on how VS Code itself was started: launched
# from a terminal it inherits that terminal's PATH and everything works; launched
# from the desktop, the dock or a .desktop file it inherits the session's PATH
# and F5 dies with `npm: command not found` before the extension host is even
# asked to start. Same checkout, same code, different launcher.
#
# So: find Node ourselves, the way the extension already finds the `claude`
# executable, and say something useful when there is none.
#
# POSIX sh, no dependencies — it has to run when nothing is installed.
set -eu

# Node 22.6 is where `--experimental-strip-types` landed; every test runs
# through it. Keep in step with MIN_NODE in scripts/preflight.mjs.
MIN_MAJOR=22
MIN_MINOR=6

# Is this node new enough? Asked by RUNNING it, not by parsing a path — a
# directory named v22.18.0 containing a broken binary is a real thing.
usable() {
  [ -x "$1" ] || return 1
  _v=$("$1" --version 2>/dev/null) || return 1
  _v=${_v#v}
  _major=${_v%%.*}
  _rest=${_v#*.}
  _minor=${_rest%%.*}
  case $_major in '' | *[!0-9]*) return 1 ;; esac
  case $_minor in '' | *[!0-9]*) return 1 ;; esac
  [ "$_major" -gt "$MIN_MAJOR" ] && return 0
  [ "$_major" -eq "$MIN_MAJOR" ] && [ "$_minor" -ge "$MIN_MINOR" ] && return 0
  return 1
}

# Candidates, best first. Order only decides which usable Node wins; `usable`
# decides whether any of them is one at all, so a version manager that sorts
# oddly costs nothing.
candidates() {
  command -v node 2>/dev/null || true

  _nvm=${NVM_DIR:-$HOME/.nvm}
  # nvm's own default alias first — it is what the user's terminal would pick.
  if [ -f "$_nvm/alias/default" ]; then
    _alias=$(cat "$_nvm/alias/default" 2>/dev/null || true)
    [ -n "$_alias" ] && printf '%s\n' "$_nvm/versions/node/v${_alias#v}/bin/node"
  fi
  if [ -d "$_nvm/versions/node" ]; then
    ls -1 "$_nvm/versions/node" 2>/dev/null | sort -r | while read -r _d; do
      printf '%s\n' "$_nvm/versions/node/$_d/bin/node"
    done
  fi

  # fnm, volta, asdf, n, and the usual system locations.
  for _g in \
    "${FNM_DIR:-$HOME/.local/share/fnm}/node-versions"/*/installation/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/n/bin/node" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /snap/bin/node \
    /usr/bin/node
  do
    [ -e "$_g" ] && printf '%s\n' "$_g"
  done
  true
}

NODE=''
for c in $(candidates); do
  if usable "$c"; then NODE=$c; break; fi
done

if [ -z "$NODE" ]; then
  cat >&2 <<'MSG'

  ✗ No Node 22.6+ on PATH, so this task cannot run.

    Your terminal almost certainly has one. Tasks do not: VS Code runs them in a
    non-interactive shell, and nvm/fnm/asdf install themselves in ~/.bashrc,
    which exits early for exactly that kind of shell.

    Any one of these fixes it, permanently:

      1. Start VS Code from a terminal, so it inherits that terminal's PATH:
             code .

      2. Put your version manager somewhere a login shell sees it. Add to
         ~/.profile (NOT ~/.bashrc):
             export NVM_DIR="$HOME/.nvm"
             [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
         then log out and back in.

      3. Install a system-wide Node, e.g. from https://nodejs.org

MSG
  exit 1
fi

# Prepend, never replace: npm, npx and the project's own binaries live beside
# node, and anything already on PATH stays reachable.
NODE_BIN=$(dirname "$NODE")
PATH="$NODE_BIN:$PATH"
export PATH

exec "$@"
