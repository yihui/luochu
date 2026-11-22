package server

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTerminalAgentKeepsDefaultPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY is not supported on Windows")
	}
	dir := t.TempDir()
	for _, name := range []string{"claude", "copilot"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\nprintf 'argument-count:%s\\n' \"$#\"\nread line\n"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	s, err := New(Config{Token: "test-token", ProjectRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	for _, name := range []string{"claude", "copilot"} {
		t.Run(name, func(t *testing.T) {
			_, session, err := s.newTerminal(name)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(session.stop)
			client, history, err := session.attach(nil)
			if err != nil {
				t.Fatal(err)
			}
			defer session.detach(client)
			output := string(history)
			timer := time.NewTimer(5 * time.Second)
			defer timer.Stop()
			for !strings.Contains(output, "argument-count:0") {
				select {
				case chunk, ok := <-client:
					if !ok {
						t.Fatalf("agent exited early: %q", output)
					}
					output += string(chunk)
				case <-timer.C:
					t.Fatalf("agent did not report default arguments: %q", output)
				}
			}
		})
	}
}
