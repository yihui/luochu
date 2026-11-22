//go:build !windows

package server

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/charmbracelet/x/xpty"
)

func terminalSupported() bool { return true }

func terminalCloseOnExit() bool { return false }

func terminalShell() (string, []string, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	path, err := exec.LookPath(shell)
	return path, []string{"-i"}, err
}

func startTerminal(pty xpty.Pty, cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}
	if err := pty.Start(cmd); err != nil {
		return err
	}
	// xpty retains the slave in the parent, preventing EOF after shell exit.
	return pty.(*xpty.UnixPty).Slave().Close()
}
