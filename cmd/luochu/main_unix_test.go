//go:build !windows

package main

import (
	"testing"

	"github.com/charmbracelet/x/xpty"
)

func TestBrowserFlagTerminal(t *testing.T) {
	pty, err := xpty.NewUnixPty(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer pty.Close()
	testBrowserFlag(t, pty.Slave(), true)
}
