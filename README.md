# Luochu

Luochu is a small, browser-first code and Djot document editor with a local Go
server.

## Requirements

- Go 1.25 or newer
- Node.js and npm

## Run

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

## Test

```bash
npm test
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
