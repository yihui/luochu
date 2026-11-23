package main

import "testing"

// Vectors from RStudio's UrlPortsTests.cpp.
func TestTransformPortMatchesRStudio(t *testing.T) {
	const token = "fb7559983669"
	tests := map[int]string{4991: "1235cc15", 5990: "1a2be938", 5252: "d4167a28", 6600: "f2094b4e"}
	for port, want := range tests {
		got, ok := transformPort(token, port)
		if !ok || got != want {
			t.Errorf("transformPort(%d) = %q, %v; want %q", port, got, ok, want)
		}
	}
}

func TestTransformPortRejectsBadToken(t *testing.T) {
	for _, token := range []string{"", "fb75599836", "zz7559983669"} {
		if _, ok := transformPort(token, 4991); ok {
			t.Errorf("transformPort accepted token %q", token)
		}
	}
}

func TestWorkbenchURL(t *testing.T) {
	env := map[string]string{
		"RS_SERVER_ADDRESS": "https://rstudio.example",
		"RS_SESSION_URL":    "/s/f6bd/",
		"RS_PORT_TOKEN":     "fb7559983669",
	}
	getenv := func(name string) string { return env[name] }
	if got := workbenchURL(6600, getenv); got != "https://rstudio.example/s/f6bd/p/f2094b4e/" {
		t.Errorf("workbenchURL = %q", got)
	}
	env["RS_PORT_TOKEN"] = ""
	if got := workbenchURL(6600, getenv); got != "" {
		t.Errorf("without token: got %q, want empty", got)
	}
}
