package server

import (
	"bytes"
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
	"sync"
	"time"
	"unicode/utf8"

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
	terminalMu  sync.Mutex
	terminals   map[string]*terminalSession
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
	s := &Server{config: config, static: static, projectRoot: root, changes: make(chan string, 128),
		terminals: make(map[string]*terminalSession)}
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

	prefix, path, ok := s.splitRoute(r.URL.Path)
	if !ok {
		// A bare prefix needs its trailing slash so relative asset URLs resolve.
		if r.URL.Path == s.config.BasePath || (s.config.BasePath == "" && !strings.HasSuffix(r.URL.Path, "/")) {
			redirectTrailingSlash(w, r)
			return
		}
		http.NotFound(w, r)
		return
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
	case path == "/api/git":
		s.serveGit(w, r)
	case path == "/api/terminal":
		s.serveTerminal(w, r)
	case strings.HasPrefix(path, "/assets/"):
		s.serveAsset(w, r, strings.TrimPrefix(path, "/"))
	default:
		http.NotFound(w, r)
	}
}

// appRoutes are the fixed API routes; anything else under the proxy prefix is
// the index or an asset.
var appRoutes = []string{"/api/capabilities", "/api/files", "/api/file", "/api/watch", "/api/git", "/api/terminal"}

// splitRoute separates the proxy prefix from the app route. A configured
// BasePath must match exactly. Without one, the route is recognized by suffix,
// so Workbench-style prefixes (which change per session) work unchanged.
// Prefix only selects routing; token, Host and Origin checks still apply.
func (s *Server) splitRoute(path string) (prefix, route string, ok bool) {
	if base := s.config.BasePath; base != "" {
		if !strings.HasPrefix(path, base+"/") {
			return "", "", false
		}
		return base, strings.TrimPrefix(path, base), true
	}
	for _, name := range appRoutes {
		if strings.HasSuffix(path, name) {
			return strings.TrimSuffix(path, name), name, true
		}
	}
	if i := strings.LastIndex(path, "/assets/"); i >= 0 {
		if name := path[i+len("/assets/"):]; name != "" && !strings.Contains(name, "/") {
			return path[:i], path[i:], true
		}
	}
	if strings.HasSuffix(path, "/") {
		return strings.TrimSuffix(path, "/"), "/", true
	}
	return "", "", false
}

func redirectTrailingSlash(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Path + "/"
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	http.Redirect(w, r, target, http.StatusPermanentRedirect)
}

func prefixOrSlash(prefix string) string {
	if prefix == "" {
		return "/"
	}
	return prefix + "/"
}

func (s *Server) securityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' http: https:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
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
	// The same-host origin always works; Host was already checked against loopback.
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if origin == scheme+"://"+r.Host {
		return true
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
	terminal := s.projectRoot != "" && terminalSupported()
	if terminal {
		_, _, err := terminalShell()
		terminal = err == nil
	}
	writeJSONNoStore(w, map[string]any{
		"server":   true,
		"basePath": s.config.BasePath,
		"capabilities": map[string]bool{
			"files":     s.projectRoot != "",
			"watch":     s.watcher != nil,
			"git":       s.projectRoot != "" && gitAvailable(),
			"terminal":  terminal,
			"nativeRun": false,
			"wasmRun":   false,
		},
	})
}

func writeJSONNoStore(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
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
	if requestPath == "" {
		requestPath = "."
	}
	if filepath.IsAbs(requestPath) {
		return "", errors.New("absolute project paths are not allowed")
	}
	full := filepath.Join(s.projectRoot, filepath.FromSlash(requestPath))
	if !pathWithin(s.projectRoot, full) {
		return "", errors.New("path escapes project root")
	}
	return full, nil
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

var (
	errBinaryFile  = errors.New("binary file")
	errInvalidUTF8 = errors.New("not UTF-8 text")
)

func readEditable(r io.Reader) ([]byte, error) {
	sample, err := io.ReadAll(io.LimitReader(r, 512))
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(http.DetectContentType(sample), "text/") {
		return nil, errBinaryFile
	}
	data, err := io.ReadAll(io.MultiReader(bytes.NewReader(sample), r))
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(data) {
		return nil, errInvalidUTF8
	}
	for _, b := range data {
		if b < 32 && b != '\t' && b != '\n' && b != '\r' && b != '\f' || b == 127 {
			return nil, errBinaryFile
		}
	}
	return data, nil
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
		var data []byte
		var info os.FileInfo
		if r.URL.Query().Get("text") == "1" {
			file, err := os.Open(full)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			defer file.Close()
			info, err = file.Stat()
			if err != nil || info.IsDir() {
				http.Error(w, "file unavailable", http.StatusNotFound)
				return
			}
			data, err = readEditable(file)
			if err != nil {
				status := http.StatusInternalServerError
				if errors.Is(err, errBinaryFile) || errors.Is(err, errInvalidUTF8) {
					status = http.StatusUnsupportedMediaType
				}
				http.Error(w, err.Error(), status)
				return
			}
		} else {
			data, err = os.ReadFile(full)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			info, err = os.Stat(full)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
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
			if !pathWithin(s.projectRoot, resolvedParent) {
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
