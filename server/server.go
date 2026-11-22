package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"time"

	"embed"
)

//go:embed static/*
var staticFiles embed.FS

type Config struct {
	BasePath string
	Token    string
	Origins  []string
	Hosts    []string
}

type Server struct {
	config Config
	static fs.FS
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
	return &Server{config: config, static: static}, nil
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
			"files":     false,
			"watch":     false,
			"git":       false,
			"terminal":  false,
			"nativeRun": false,
			"wasmRun":   false,
		},
	})
}
