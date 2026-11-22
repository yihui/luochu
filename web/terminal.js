import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function openTerminal(element, status) {
  const terminal = new Terminal({ cursorBlink: true, scrollback: 5000 }),
    fit = new FitAddon(), encoder = new TextEncoder();
  terminal.loadAddon(fit);
  terminal.open(element);
  let socket, session = "", reconnectTimer, stopped = false, exited = false;

  function resize() {
    if (!element.isConnected || !element.clientWidth || !element.clientHeight) return;
    fit.fit();
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
  }
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    else status.textContent = "Disconnected; input was not sent.";
  });

  function connect() {
    const url = new URL("api/terminal", document.baseURI);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (session) url.searchParams.set("session", session);
    status.textContent = session ? "Reconnecting terminal…" : "Starting terminal…";
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === "session") {
        if (session) terminal.reset();
        session = message.id;
        status.textContent = "Connected. Shell commands run with your permissions; agents use their own prompts.";
        resize();
        terminal.focus();
      } else if (message.type === "exit") {
        exited = true;
        status.textContent = "Terminal process exited.";
      } else if (message.type === "error") {
        exited = true;
        status.textContent = `Terminal error: ${message.message}`;
      }
    };
    socket.onerror = () => { status.textContent = "Terminal connection failed."; };
    socket.onclose = () => {
      if (stopped || exited) return;
      if (!session) {
        status.textContent = "Terminal connection failed. Close and reopen to retry.";
        return;
      }
      status.textContent = "Terminal disconnected; reconnecting…";
      reconnectTimer = setTimeout(connect, 1000);
    };
  }
  connect();
  return {
    paste(text) { terminal.paste(text); terminal.focus(); },
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      observer.disconnect();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "close" }));
        socket.close();
      } else socket?.close();
      terminal.dispose();
    },
  };
}
