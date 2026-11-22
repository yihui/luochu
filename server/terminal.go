package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/charmbracelet/x/xpty"
	"github.com/gorilla/websocket"
)

const terminalHistory = 256 * 1024
const terminalGrace = 2 * time.Minute

type terminalSession struct {
	mu        sync.Mutex
	closeOnce sync.Once
	pty       xpty.Pty
	cmd       *exec.Cmd
	history   []byte
	client    chan []byte
	conn      *websocket.Conn
	timer     *time.Timer
	exited    bool
	stopping  bool
}

func (s *Server) newTerminal() (string, *terminalSession, error) {
	shell, args, err := terminalShell()
	if err != nil {
		return "", nil, err
	}
	id, err := GenerateToken()
	if err != nil {
		return "", nil, err
	}
	cmd := exec.Command(shell, args...)
	cmd.Dir = s.projectRoot
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	file, err := xpty.NewPty(80, 24)
	if err != nil {
		return "", nil, err
	}
	if err := startTerminal(file, cmd); err != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = xpty.WaitProcess(context.Background(), cmd)
		}
		_ = file.Close()
		return "", nil, err
	}
	session := &terminalSession{pty: file, cmd: cmd}
	s.terminalMu.Lock()
	s.terminals[id] = session
	s.terminalMu.Unlock()
	wait := make(chan error, 1)
	go func() {
		err := xpty.WaitProcess(context.Background(), cmd)
		if terminalCloseOnExit() {
			// ConPTY retains its output pipe until the console is closed.
			session.closePTY()
		}
		wait <- err
	}()
	go s.readTerminal(id, session, wait)
	return id, session, nil
}

func (s *Server) readTerminal(id string, session *terminalSession, wait <-chan error) {
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
	if err := <-wait; err != nil {
		log.Printf("terminal process exited: %v", err)
	}
	session.closePTY()
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
	if session.exited || session.stopping {
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
		if session.client == nil && !session.exited {
			session.stopping = true
			session.mu.Unlock()
			session.stop()
			return
		}
		session.mu.Unlock()
	})
}

func (session *terminalSession) closePTY() {
	session.closeOnce.Do(func() { _ = session.pty.Close() })
}

func (session *terminalSession) stop() {
	session.mu.Lock()
	session.stopping = true
	session.mu.Unlock()
	if err := session.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		log.Printf("could not stop terminal: %v", err)
	}
	session.closePTY()
}

func (s *Server) serveTerminal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.projectRoot == "" || !terminalSupported() {
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
			if err := session.pty.Resize(int(message.Cols), int(message.Rows)); err != nil {
				log.Printf("terminal resize failed: %v", err)
				return
			}
		}
	}
}
