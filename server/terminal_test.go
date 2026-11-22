package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTerminalAuthenticationAndReconnect(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY is not supported on Windows")
	}
	t.Setenv("SHELL", "/bin/sh")
	s, err := New(Config{Token: "test-token", BasePath: "/proxy", ProjectRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.newTerminal("arbitrary"); err == nil {
		t.Fatal("arbitrary terminal command was accepted")
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	server := httptest.NewServer(s)
	defer server.Close()
	host, _ := url.Parse(server.URL)
	base := "ws://" + host.Host + "/proxy/api/terminal"
	origin := http.Header{"Origin": []string{server.URL}}
	for _, test := range []struct {
		target string
		header http.Header
		status int
	}{
		{base + "?command=shell", origin, http.StatusUnauthorized},
		{base + "?token=test-token&command=shell", http.Header{"Origin": []string{"https://attacker.invalid"}}, http.StatusForbidden},
		{base + "?token=test-token&command=shell", nil, http.StatusForbidden},
		{base + "?token=test-token&command=shell", http.Header{"Origin": []string{server.URL}, "Host": []string{"attacker.invalid"}}, http.StatusBadRequest},
		{"ws://" + host.Host + "/api/terminal?token=test-token", origin, http.StatusNotFound},
	} {
		conn, response, err := websocket.DefaultDialer.Dial(test.target, test.header)
		if conn != nil {
			_ = conn.Close()
		}
		if err == nil || response == nil || response.StatusCode != test.status {
			t.Fatalf("bad upgrade %s: response %v, error %v", test.target, response, err)
		}
		_ = response.Body.Close()
	}

	connect := func(target string) *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.DefaultDialer.Dial(target, origin)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		return conn
	}
	readSession := func(conn *websocket.Conn) string {
		t.Helper()
		var message struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := conn.ReadJSON(&message); err != nil || message.Type != "session" || message.ID == "" {
			t.Fatalf("session handshake: %+v, %v", message, err)
		}
		return message.ID
	}
	readUntil := func(conn *websocket.Conn, text string) {
		t.Helper()
		var output strings.Builder
		for !strings.Contains(output.String(), text) {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				t.Fatalf("waiting for %q: %v; output %q", text, err, output.String())
			}
			if kind == websocket.BinaryMessage {
				output.Write(data)
			}
		}

	}
	conn := connect(base + "?token=test-token&command=shell")
	id := readSession(conn)
	if err := conn.WriteMessage(websocket.BinaryMessage,
		[]byte("export LUOCHU_TEST_STATE=kept; printf 'ready:%s\\n' \"$LUOCHU_TEST_STATE\"\n")); err != nil {
		t.Fatal(err)
	}

	readUntil(conn, "ready:kept")
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("printf 'cwd=%s\\n' \"$PWD\"\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(conn, "cwd="+s.projectRoot)
	if err := conn.WriteJSON(map[string]any{"type": "resize", "cols": 91, "rows": 33}); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("stty size\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(conn, "33 91")
	_ = conn.Close()

	s.terminalMu.Lock()
	session := s.terminals[id]
	s.terminalMu.Unlock()
	if session == nil {
		t.Fatal("terminal exited on disconnect")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		session.mu.Lock()
		detached := session.client == nil
		session.mu.Unlock()
		if detached {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not detach")
		}
		time.Sleep(10 * time.Millisecond)
	}
	conn = connect(fmt.Sprintf("%s?token=test-token&session=%s", base, url.QueryEscape(id)))
	if got := readSession(conn); got != id {
		t.Fatalf("reconnected to %s, expected %s", got, id)
	}
	readUntil(conn, "ready:kept")
	if err := conn.WriteMessage(websocket.BinaryMessage,
		[]byte("printf 'persist:%s\\n' \"$LUOCHU_TEST_STATE\"\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(conn, "persist:kept")
	closeMessage, _ := json.Marshal(map[string]string{"type": "close"})
	if err := conn.WriteMessage(websocket.TextMessage, closeMessage); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	deadline = time.Now().Add(5 * time.Second)
	for {
		s.terminalMu.Lock()
		_, exists := s.terminals[id]
		s.terminalMu.Unlock()
		if !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closed terminal was not cleaned up")
		}
		time.Sleep(10 * time.Millisecond)
	}
	conn = connect(base + "?token=test-token&command=shell")
	badID := readSession(conn)
	s.terminalMu.Lock()
	badSession := s.terminals[badID]
	s.terminalMu.Unlock()
	if badSession == nil {
		t.Fatal("terminal exited before invalid message test")
	}
	t.Cleanup(badSession.stop)
	if err := conn.WriteMessage(websocket.TextMessage, []byte("not json")); err != nil {
		t.Fatal(err)
	}
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		if !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
			t.Fatalf("invalid message close: %v", err)
		}
		break
	}
	_ = conn.Close()
}
