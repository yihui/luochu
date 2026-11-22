package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const terminalHistory = 256 * 1024
const terminalGrace = 2 * time.Minute

type terminalSession struct {
	mu      sync.Mutex
	pty     *os.File
	cmd     *exec.Cmd
	history []byte
	client  chan []byte
	conn    *websocket.Conn
	timer   *time.Timer
	exited  bool
}

func terminalShell() (string, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return exec.LookPath(shell)
}

func (s *Server) newTerminal() (string, *terminalSession, error) {
	shell, err := terminalShell()
	if err != nil {
		return "", nil, err
	}
	id, err := GenerateToken()
	if err != nil {
		return "", nil, err
	}
	cmd := exec.Command(shell, "-i")
	cmd.Dir = s.projectRoot
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 24, Cols: 80})
	if err != nil {
		return "", nil, err
	}
	session := &terminalSession{pty: file, cmd: cmd}
	s.terminalMu.Lock()
	s.terminals[id] = session
	s.terminalMu.Unlock()
	go s.readTerminal(id, session)
	return id, session, nil
}

func (s *Server) readTerminal(id string, session *terminalSession) {
	buffer := make([]byte, 8192)
	for {
		n, err := session.pty.Read(buffer)
		if n > 0 {
			session.mu.Lock()
			session.history = append(session.history, buffer[:n]...)
			if len(session.history) > terminalHistory {
				session.history = append([]byte(nil), session.history[len(session.history)-terminalHistory:]...)
			}
			if session.client != nil {
				select {
				case session.client <- append([]byte(nil), buffer[:n]...):
				default:
					close(session.client)
					session.client = nil
					if session.conn != nil {
						_ = session.conn.Close()
						session.conn = nil
					}
					session.expireAfterGrace()
					log.Print("terminal client too slow; reconnecting")
				}
			}
			session.mu.Unlock()
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
				// PTYs commonly return EIO when the slave closes.
				log.Printf("terminal output closed: %v", err)
			}
			break
		}
	}
	if err := session.cmd.Wait(); err != nil {
		log.Printf("terminal process exited: %v", err)
	}
	_ = session.pty.Close()
	session.mu.Lock()
	session.exited = true
	if session.timer != nil {
		session.timer.Stop()
	}
	if session.client != nil {
		close(session.client)
		session.client = nil
	}
	session.mu.Unlock()
	s.terminalMu.Lock()
	delete(s.terminals, id)
	s.terminalMu.Unlock()
}

func (session *terminalSession) attach(conn *websocket.Conn) (chan []byte, []byte, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.exited {
		return nil, nil, errors.New("terminal has exited")
	}
	if session.client != nil {
		close(session.client)
		if session.conn != nil {
			_ = session.conn.Close()
		}
	}
	if session.timer != nil {
		session.timer.Stop()
		session.timer = nil
	}
	client := make(chan []byte, 64)
	session.client = client
	session.conn = conn
	return client, append([]byte(nil), session.history...), nil
}

func (session *terminalSession) detach(client chan []byte) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.client != client {
		return
	}
	session.client = nil
	session.conn = nil
	close(client)
	if !session.exited {
		session.expireAfterGrace()
	}
}

func (session *terminalSession) expireAfterGrace() {
	session.timer = time.AfterFunc(terminalGrace, func() {
		session.mu.Lock()
		defer session.mu.Unlock()
		if session.client == nil && !session.exited {
			session.stop()
		}
	})
}

func (session *terminalSession) stop() {
	if err := session.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		log.Printf("could not stop terminal: %v", err)
	}
	_ = session.pty.Close()
}

func (s *Server) serveTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.projectRoot == "" || runtime.GOOS == "windows" {
		http.Error(w, "terminal unavailable", http.StatusNotFound)
		return
	}
	if r.Header.Get("Origin") == "" || !s.validOrigin(r) {
		http.Error(w, "invalid Origin", http.StatusForbidden)
		return
	}
	if r.URL.Query().Has("command") {
		http.Error(w, "command selection is not supported", http.StatusBadRequest)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("terminal upgrade failed: %v", err)
		return
	}
	defer conn.Close()
	id := r.URL.Query().Get("session")
	var session *terminalSession
	if id == "" {
		id, session, err = s.newTerminal()
	} else {
		s.terminalMu.Lock()
		session = s.terminals[id]
		s.terminalMu.Unlock()
		if session == nil {
			err = errors.New("terminal session not found")
		}
	}
	if err != nil {
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": err.Error()})
		return
	}
	client, history, err := session.attach(conn)
	if err != nil {
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": err.Error()})
		return
	}
	defer session.detach(client)
	if err := conn.WriteJSON(map[string]string{"type": "session", "id": id}); err != nil {
		return
	}
	go func() {
		defer conn.Close()
		if len(history) > 0 {
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, history); err != nil {
				return
			}
		}
		for output := range client {
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, output); err != nil {
				return
			}
		}
		session.mu.Lock()
		exited := session.exited
		session.mu.Unlock()
		if exited {
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			_ = conn.WriteJSON(map[string]string{"type": "exit"})
		}
	}()
	conn.SetReadLimit(1024 * 1024)
	for {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch kind {
		case websocket.BinaryMessage:
			if _, err := session.pty.Write(data); err != nil {
				log.Printf("terminal input failed: %v", err)
				return
			}
		case websocket.TextMessage:
			var message struct {
				Type string `json:"type"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if err := json.Unmarshal(data, &message); err != nil {
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "invalid terminal message"),
					time.Now().Add(time.Second))
				return
			}
			if message.Type == "close" {
				session.stop()
				return
			}
			if message.Type != "resize" || message.Cols == 0 || message.Rows == 0 ||
				message.Cols > 1000 || message.Rows > 1000 {
				_ = conn.WriteControl(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "invalid terminal message"),
					time.Now().Add(time.Second))
				return
			}
			if err := pty.Setsize(session.pty, &pty.Winsize{Rows: message.Rows, Cols: message.Cols}); err != nil {
				log.Printf("terminal resize failed: %v", err)
				return
			}
		}
	}
}
