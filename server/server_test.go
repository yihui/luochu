package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	s, err := New(Config{Token: "test-token", BasePath: "/proxy"})
	if err != nil {
		t.Fatal(err)
	}
	return s, "/proxy"
}

func request(s *Server, method, target, origin string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	req.Host = "127.0.0.1"
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestRequiresToken(t *testing.T) {
	s, prefix := testServer(t)
	rec := request(s, http.MethodGet, prefix+"/api/capabilities", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", rec.Code)
	}
}

func TestTokenQueryAndCapabilities(t *testing.T) {
	s, prefix := testServer(t)
	rec := request(s, http.MethodGet, prefix+"/api/capabilities?token=test-token", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

func TestExternalImagesKeepReferrerPrivate(t *testing.T) {
	s, prefix := testServer(t)
	rec := request(s, http.MethodGet, prefix+"/?token=test-token", "")
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "img-src 'self' http: https:") {
		t.Fatalf("external images missing from CSP: %s", csp)
	}
	if policy := rec.Header().Get("Referrer-Policy"); policy != "no-referrer" {
		t.Fatalf("referrer policy = %q", policy)
	}
}

func TestTokenBearer(t *testing.T) {
	s, prefix := testServer(t)
	req := httptest.NewRequest(http.MethodGet, prefix+"/api/capabilities", nil)
	req.Host = "127.0.0.1"
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
}

func TestOriginAndHostChecks(t *testing.T) {
	s, prefix := testServer(t)
	rec := request(s, http.MethodGet, prefix+"/api/capabilities?token=test-token", "https://attacker.example")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("origin: got %d, want 403", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, prefix+"/api/capabilities?token=test-token", nil)
	req.Host = "attacker.example"
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("host: got %d, want 400", rec.Code)
	}
}

func TestBasePrefix(t *testing.T) {
	s, prefix := testServer(t)
	rec := request(s, http.MethodGet, "/api/capabilities?token=test-token", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404 outside prefix", rec.Code)
	}
	rec = request(s, http.MethodGet, prefix+"/?token=test-token", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200 at prefix", rec.Code)
	}
}

func TestTraversalOutsideStaticMount(t *testing.T) {
	s, prefix := testServer(t)
	rec := request(s, http.MethodGet, prefix+"/assets/../AGENTS.md?token=test-token", "")
	if rec.Code == http.StatusOK {
		t.Fatal("traversal unexpectedly served static content")
	}
}

func TestGenerateToken(t *testing.T) {
	a, err := GenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := GenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(a) < 40 || a == b {
		t.Fatalf("tokens not random/long: %q %q", a, b)
	}
}

func fileRequest(s *Server, method, target string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	req.Host = "127.0.0.1"
	req.URL.RawQuery += "&token=test-token"
	if body != nil {
		req.Header.Set("Content-Type", "text/plain")
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestProjectFileReadWriteConflictAndRename(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "one.dj"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Token: "test-token", ProjectRoot: root})
	if err != nil {
		t.Fatal(err)
	}

	rec := fileRequest(s, http.MethodGet, "/api/file?path=one.dj", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "hello" {
		t.Fatalf("read: got %d %q", rec.Code, rec.Body.String())
	}
	hash := rec.Header().Get("X-Luochu-Hash")

	rec = fileRequest(s, http.MethodPut, "/api/file?path=one.dj", strings.NewReader("hello"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("write: got %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodPut, "/api/file?path=one.dj&token=test-token", strings.NewReader("other"))
	req.Host = "127.0.0.1"
	req.Header.Set("If-Match", "definitely-not-current")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflict: got %d, want 409", rec.Code)
	}

	if hash == "" {
		t.Fatal("read response did not include content hash")
	}
	rec = fileRequest(s, http.MethodPatch, "/api/file?from=one.dj&to=two.dj", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("rename status: got %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(root, "two.dj")); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
}

func TestProjectTraversalRejected(t *testing.T) {
	root := t.TempDir()
	s, err := New(Config{Token: "test-token", ProjectRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	rec := fileRequest(s, http.MethodGet, "/api/file?path=../outside.dj", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

func TestProxyPrefixWithoutBasePath(t *testing.T) {
	s, err := New(Config{Token: "test-token"})
	if err != nil {
		t.Fatal(err)
	}
	const base = "/s/f6bd/p/b02a"
	rec := request(s, http.MethodGet, base+"/?token=test-token", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("index: got %d, want 200", rec.Code)
	}
	if cookie := rec.Result().Cookies(); len(cookie) != 1 || cookie[0].Path != base+"/" {
		t.Fatalf("cookie: got %+v, want Path %s/", cookie, base)
	}
	rec = request(s, http.MethodGet, base+"/api/capabilities?token=test-token", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("api: got %d, want 200", rec.Code)
	}
	rec = request(s, http.MethodGet, base+"/api/capabilities", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d, want 401", rec.Code)
	}
	rec = request(s, http.MethodGet, base+"?token=test-token", "")
	if rec.Code != http.StatusPermanentRedirect || rec.Header().Get("Location") != base+"/?token=test-token" {
		t.Fatalf("bare prefix: got %d %q, want 308 to trailing slash", rec.Code, rec.Header().Get("Location"))
	}
	rec = request(s, http.MethodGet, base+"/api/capabilities?token=test-token", "https://attacker.example")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("origin: got %d, want 403", rec.Code)
	}
}

func TestConfiguredOriginKeepsSameHostOrigin(t *testing.T) {
	s, err := New(Config{Token: "test-token", Origins: []string{"https://rstudio.example"}})
	if err != nil {
		t.Fatal(err)
	}
	rec := request(s, http.MethodGet, "/api/capabilities?token=test-token", "http://127.0.0.1")
	if rec.Code != http.StatusOK {
		t.Fatalf("same host: got %d, want 200", rec.Code)
	}
	rec = request(s, http.MethodGet, "/api/capabilities?token=test-token", "https://rstudio.example")
	if rec.Code != http.StatusOK {
		t.Fatalf("configured: got %d, want 200", rec.Code)
	}
	rec = request(s, http.MethodGet, "/api/capabilities?token=test-token", "https://attacker.example")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("other: got %d, want 403", rec.Code)
	}
}
