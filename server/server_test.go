package server

import (
	"net/http"
	"net/http/httptest"
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
