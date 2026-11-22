package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"embed"

	"github.com/fsnotify/fsnotify"
)

//go:embed static/*
var staticFiles embed.FS

type Config struct {
	BasePath    string
	Token       string
	Origins     []string
	Hosts       []string
	ProjectRoot string
}

type Server struct {
	config      Config
	static      fs.FS
	projectRoot string
	watcher     *fsnotify.Watcher
	changes     chan string
}

func GenerateToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func New(config Config) (*Server, error) {
	if config.Token == "" {
		return nil, errors.New("server token is required")
	}
	if config.BasePath != "" {
		config.BasePath = "/" + strings.Trim(config.BasePath, "/")
	}
	static, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return nil, err
	}
	if len(config.Hosts) == 0 {
		config.Hosts = []string{"127.0.0.1", "localhost"}
	}
	root := ""
	if config.ProjectRoot != "" {
		var err error
		root, err = filepath.Abs(config.ProjectRoot)
		if err != nil {
			return nil, err
		}
		root, err = filepath.EvalSymlinks(root)
		if err != nil {
			return nil, err
		}
	}
	s := &Server{config: config, static: static, projectRoot: root, changes: make(chan string, 128)}
	if root != "" {
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return nil, err
		}
		s.watcher = watcher
		go s.watch(root)
	}
	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.securityHeaders(w)
	if !s.validHost(r) {
		http.Error(w, "invalid Host", http.StatusBadRequest)
		return
	}
	if r.Header.Get("Origin") != "" && !s.validOrigin(r) {
		http.Error(w, "invalid Origin", http.StatusForbidden)
		return
	}
	if !s.validToken(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	path := r.URL.Path
	prefix := s.config.BasePath
	if prefix != "" {
		if path == prefix {
			http.Redirect(w, r, prefix+"/", http.StatusPermanentRedirect)
			return
		}
		if !strings.HasPrefix(path, prefix+"/") {
			http.NotFound(w, r)
			return
		}
		path = strings.TrimPrefix(path, prefix)
	}
	if path == "" {
		path = "/"
	}

	switch {
	case path == "/":
		if r.URL.Query().Get("token") == s.config.Token {
			http.SetCookie(w, &http.Cookie{
				Name:     "luochu_token",
				Value:    s.config.Token,
				Path:     prefixOrSlash(prefix),
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
				Secure:   r.TLS != nil,
			})
		}
		s.serveIndex(w, r)
	case path == "/api/capabilities":
		s.serveCapabilities(w)
	case path == "/api/files":
		s.serveFiles(w, r)
	case path == "/api/file":
		s.serveFile(w, r)
	case path == "/api/watch":
		s.serveWatch(w, r)
	case strings.HasPrefix(path, "/assets/"):
		s.serveAsset(w, r, strings.TrimPrefix(path, "/"))
	default:
		http.NotFound(w, r)
	}
}

func prefixOrSlash(prefix string) string {
	if prefix == "" {
		return "/"
	}
	return prefix + "/"
}

func (s *Server) securityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
}

func (s *Server) validHost(r *http.Request) bool {
	host := r.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	host = strings.Trim(host, "[]")
	for _, allowed := range s.config.Hosts {
		if strings.EqualFold(host, allowed) {
			return true
		}
	}
	return false
}

func (s *Server) validOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if len(s.config.Origins) == 0 {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		host := r.Host
		return origin == scheme+"://"+host
	}
	for _, allowed := range s.config.Origins {
		if origin == strings.TrimRight(allowed, "/") {
			return true
		}
	}
	return false
}

func (s *Server) validToken(r *http.Request) bool {
	if r.URL.Query().Get("token") == s.config.Token {
		return true
	}
	if cookie, err := r.Cookie("luochu_token"); err == nil && cookie.Value == s.config.Token {
		return true
	}
	authorization := r.Header.Get("Authorization")
	return authorization == "Bearer "+s.config.Token
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	content, err := fs.ReadFile(s.static, "index.html")
	if err != nil {
		http.Error(w, "missing UI", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(content)
}

func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request, name string) {
	name = strings.TrimPrefix(name, "/")
	if name == "" || strings.Contains(name, "\\") {
		http.NotFound(w, r)
		return
	}
	asset, err := fs.ReadFile(s.static, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, name, time.Time{}, strings.NewReader(string(asset)))
}

func (s *Server) serveCapabilities(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"server":   true,
		"basePath": s.config.BasePath,
		"capabilities": map[string]bool{
			"files":     s.projectRoot != "",
			"watch":     s.watcher != nil,
			"git":       false,
			"terminal":  false,
			"nativeRun": false,
			"wasmRun":   false,
		},
	})
}

type fileInfo struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	ModTime string `json:"mtime"`
	Hash    string `json:"hash,omitempty"`
}

func (s *Server) projectPath(requestPath string) (string, error) {
	if s.projectRoot == "" {
		return "", errors.New("project root is not configured")
	}
	requestPath = strings.TrimSpace(requestPath)
	if requestPath == "" {
		requestPath = "."
	}
	if filepath.IsAbs(requestPath) {
		return "", errors.New("absolute project paths are not allowed")
	}
	full := filepath.Join(s.projectRoot, filepath.FromSlash(requestPath))
	relative, err := filepath.Rel(s.projectRoot, full)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes project root")
	}
	return full, nil
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Server) serveFiles(w http.ResponseWriter, r *http.Request) {
	if s.projectRoot == "" {
		http.Error(w, "project root is not configured", http.StatusNotFound)
		return
	}
	requestPath := r.URL.Query().Get("path")
	full, err := s.projectPath(requestPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		entries, err := os.ReadDir(full)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		result := make([]fileInfo, 0, len(entries))
		for _, entry := range entries {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			entryType := "file"
			if entry.IsDir() {
				entryType = "directory"
			}
			relative, _ := filepath.Rel(s.projectRoot, filepath.Join(full, entry.Name()))
			result = append(result, fileInfo{
				Path:    filepath.ToSlash(relative),
				Name:    entry.Name(),
				Type:    entryType,
				Size:    info.Size(),
				ModTime: info.ModTime().UTC().Format(time.RFC3339Nano),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	case http.MethodPost:
		if err := os.Mkdir(full, 0755); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusCreated)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request) {
	full, err := s.projectPath(r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		data, err := os.ReadFile(full)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		info, err := os.Stat(full)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		relative, _ := filepath.Rel(s.projectRoot, full)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Luochu-Hash", hashBytes(data))
		w.Header().Set("X-Luochu-Mtime", info.ModTime().UTC().Format(time.RFC3339Nano))
		w.Header().Set("X-Luochu-Path", filepath.ToSlash(relative))
		_, _ = w.Write(data)
	case http.MethodPut:
		data, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if expected := r.Header.Get("If-Match"); expected != "" {
			current, err := os.ReadFile(full)
			if err == nil && hashBytes(current) != expected {
				http.Error(w, "conflict: file changed on disk", http.StatusConflict)
				return
			}
		}
		parent := filepath.Dir(full)
		resolvedParent, err := filepath.EvalSymlinks(parent)
		if err == nil {
			relative, relErr := filepath.Rel(s.projectRoot, resolvedParent)
			if relErr != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				http.Error(w, "path escapes project root", http.StatusBadRequest)
				return
			}
		}
		if err := os.WriteFile(full, data, 0644); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.Header().Set("X-Luochu-Hash", hashBytes(data))
		w.WriteHeader(http.StatusNoContent)
	case http.MethodPatch:
		from, err := s.projectPath(r.URL.Query().Get("from"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		to, err := s.projectPath(r.URL.Query().Get("to"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := os.Rename(from, to); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		if err := os.Remove(full); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, PUT, PATCH, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) watch(root string) {
	_ = s.watcher.Add(root)
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			relative, err := filepath.Rel(root, event.Name)
			if err == nil {
				select {
				case s.changes <- filepath.ToSlash(relative):
				default:
				}
			}
		case _, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
		}
	}
}

func (s *Server) serveWatch(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusNotImplemented)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case path := <-s.changes:
			_, _ = w.Write([]byte("event: change\ndata: " + path + "\n\n"))
			flusher.Flush()
		case <-ticker.C:
			_, _ = w.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
