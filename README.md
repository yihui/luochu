# Luochu

Luochu is a small, browser-first code and Djot document editor with a local Go
server.

## Requirements

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

The server prints a local URL containing a random per-session token. Open that
URL in a browser. To inspect a project directory:

```bash
npm run build
go run ./cmd/luochu -project /path/to/project
```

For a proxy-mounted URL or a fixed port:

```bash
go run ./cmd/luochu -base-path /proxy -port 48765
```

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

Open the terminal and choose a shell or an installed Claude/Copilot CLI. It
starts in the project directory and runs with your user permissions. Agent
approval is handled by each CLI's normal permission prompts; the shell has
unrestricted user-level access. Pasting a multiline editor selection asks for
confirmation because it may run commands immediately.

The terminal reconnects to the same process after a connection loss, replaying
up to 256 KiB of output. A disconnected process is stopped after two minutes.
Terminal support is currently unavailable on Windows.

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
