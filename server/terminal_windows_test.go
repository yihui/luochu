//go:build windows

package server

import (
	"strings"
	"testing"
	"time"
)

func TestTerminalWindowsExit(t *testing.T) {
	if !terminalSupported() {
		t.Fatal("Windows ConPTY is unavailable")
	}
	s, err := New(Config{Token: "test-token", ProjectRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	id, session, err := s.newTerminal()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.stop)
	if _, err := session.pty.Write([]byte("for /L %i in (1,1,1000) do @echo last-%i\r\nexit\r\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		s.terminalMu.Lock()
		_, exists := s.terminals[id]
		s.terminalMu.Unlock()
		if !exists {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("terminal did not exit")
		}
		time.Sleep(10 * time.Millisecond)
	}
	session.mu.Lock()
	output := string(session.history)
	session.mu.Unlock()
	if !strings.Contains(output, "last-1000") {
		t.Fatalf("missing final output: %q", output)
	}
}
