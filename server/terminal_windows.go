//go:build windows

package server

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"syscall"

	"github.com/charmbracelet/x/xpty"
	"golang.org/x/sys/windows"
)

func terminalSupported() bool {
	return windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find() == nil
}

func terminalCloseOnExit() bool { return true }

func terminalShell() (string, []string, error) {
	shell := os.Getenv("COMSPEC")
	if shell == "" {
		shell = "cmd.exe"
	}
	path, err := exec.LookPath(shell)
	return path, nil, err
}

func startTerminal(pty xpty.Pty, cmd *exec.Cmd) error {
	// xpty v0.1.4's Start does not close the process handle returned by Spawn.
	pid, handle, err := pty.(*xpty.ConPty).Spawn(cmd.Path, cmd.Args, &syscall.ProcAttr{
		Dir: cmd.Dir, Env: cmd.Env, Sys: cmd.SysProcAttr,
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := windows.CloseHandle(windows.Handle(handle)); err != nil {
			log.Printf("could not close terminal process handle: %v", err)
		}
	}()
	cmd.Process, err = os.FindProcess(pid)
	if err != nil {
		return errors.Join(fmt.Errorf("find terminal process: %w", err),
			windows.TerminateProcess(windows.Handle(handle), 1))
	}
	return nil
}
