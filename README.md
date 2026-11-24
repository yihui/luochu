# Luochu

Luochu is a small, browser-first code and Djot document editor with a local Go
server.

## Download

Install a prerelease on Linux or macOS with:

```bash
curl -fsSL https://raw.githubusercontent.com/yihui/luochu/main/install.sh | sh -s -- v0.1.0-alpha.1
# run: ~/.local/bin/luochu
```

On Windows, run in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/yihui/luochu/main/install.ps1))) -Version v0.1.0-alpha.1
# run: & "$env:LOCALAPPDATA\Programs\Luochu\luochu.exe"
```

Omit the version to install the latest stable release. The installers verify
the release checksum and need no Go or Node installation.

## Development requirements

- Go 1.25 or newer
- Node.js and npm

## Run

The simplest development command builds the UI, starts Luochu, and opens the
default browser:

```bash
npm run dev
```

Install frontend dependencies and build the browser assets:

```bash
npm ci
npm run build
```

Start the server:

```bash
go run ./cmd/luochu
```

The server prints a local URL containing a random per-session token. When
standard input is a terminal, it also attempts to open the URL in the default
browser. Use `-open=false` to disable this, or `-open` to enable it when
standard input is not a terminal. In a remote shell, the browser opens on the
remote machine; disable it and use the printed URL or proxy URL instead.

To inspect a project directory:

```bash
npm run build
go run ./cmd/luochu -project /path/to/project
```

For a fixed port, or a proxy that must match an exact prefix:

```bash
go run ./cmd/luochu -base-path /proxy -port 48765
```

Without `-base-path`, any proxy prefix ending in the app routes is accepted.
Token, Host and Origin checks still apply. Use `-allow-origin` for a browser
origin outside Workbench.

The token is required for requests. It is printed once when the server starts.

## Local security

Loopback limits network access to the machine running the server, but other
local processes and websites opened in your browser may still try to reach it.
The token in the initial URL authenticates the browser; subsequent requests
use an HttpOnly cookie. Keep the URL private. Origin and Host checks provide
additional protection against malicious websites and DNS rebinding. Document
HTML is sanitized to remove scripts before rendering.

External images are allowed, but their hosts can see your IP address and the
requested image URL. The browser does not send the Luochu URL as a referrer.

## Terminal

Open the terminal to start a shell in the project directory, where you can run
commands such as Claude or Copilot. It runs with your user permissions. Agent
approval is handled by each CLI's normal permission prompts; the shell has
unrestricted user-level access. Pasting a multiline editor selection asks for
confirmation because it may run commands immediately.

The terminal reconnects to the same process after a connection loss, replaying
up to 256 KiB of output. A disconnected process is stopped after two minutes.
On Unix it opens `$SHELL` (or `/bin/sh`); on Windows it opens `%COMSPEC%`
(or `cmd.exe`) and requires ConPTY (Windows 10 version 1809 or later).

## Git

When Git is installed, open the Git sidebar to see the nearest repository for
the active file. Clicking a folder in Files selects that directory instead.
Use Project root to select the starting directory again.
Switch files or folders to work with multiple repositories, including nested
ones. The pane shows the whole repository even when its root is above the
directory passed to `-project`.

Select a changed file to review all diffs; each diff loads as it comes into
view. Check or uncheck files to stage or unstage them. Git uses saved files, so
save editor changes first. The active pane refreshes automatically every five
seconds; use Refresh to check immediately.
A mixed checkbox means a file has both staged and unstaged changes; checking it
stages the remaining changes. Its diff compares the working file with the
staged version.
Long diff lines wrap. Click a new-file line number to open that line in the
editor; files outside the project root cannot be opened this way.
Enter a commit message and commit staged changes. Choose a branch from the
header dropdown to switch, show recent commits, and pull or push the current
branch. Cleanup merged previews merged branches, pruned gone remotes, and squash/merged
or closed GitHub PR branches. It requires confirmation and offers associated
worktrees for separate opt-in; dirty worktrees are never removed.

## Test

```bash
npm test
npm run test:browser
go test ./...
```

## Development builds

```bash
npm run build
npm run server
```

`npm run server` rebuilds browser assets before starting the Go server.
Generated assets under `server/static/assets/` are ignored and should not be
committed.

## Releases

Push a version tag such as `v0.1.0` to build, test, and publish archives
automatically. Tags containing a hyphen, such as `v0.1.0-alpha.1`, create
prereleases. The Release workflow can also be run manually to build artifacts
without publishing. The separate `SHA256SUMS` file verifies the archives.
