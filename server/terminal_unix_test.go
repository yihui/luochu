//go:build !windows

package server

import (
	"strings"
	"testing"
	"time"
)

func TestTerminalControllingTTYAndExit(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
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
	command := `if [ "$(ps -o tpgid= -p $$ | tr -d ' ')" = "$(ps -o pgid= -p $$ | tr -d ' ')" ]; then printf 'tty-%s\n' ok; fi; printf 'last-%s\n' output; exit` + "\n"
	if _, err := session.pty.Write([]byte(command)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
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
	if !strings.Contains(output, "tty-ok") || !strings.Contains(output, "last-output") {
		t.Fatalf("missing controlling terminal or final output: %q", output)
	}
}
