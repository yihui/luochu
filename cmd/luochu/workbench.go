package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Posit Workbench routes /p/<id> to a session port. The id is RStudio Server's
// port transform (src/cpp/server_core/UrlPorts.cpp) keyed by RS_PORT_TOKEN:
// a 4-hex multiplier and an 8-hex key.
var portTokenPattern = regexp.MustCompile(`^[0-9a-fA-F]{12}$`)

func transformPort(token string, port int) (string, bool) {
	if !portTokenPattern.MatchString(token) {
		return "", false
	}
	multiplier, _ := strconv.ParseUint(token[:4], 16, 32)
	key, _ := strconv.ParseUint(token[4:], 16, 32)
	scaled := (uint64(port) * 8854) % 65535
	return fmt.Sprintf("%08x", (scaled*multiplier)^key), true
}

// workbenchURL returns the browser URL for a local port behind the Workbench
// port proxy, or "" outside Workbench. getenv is injected for tests.
func workbenchURL(port int, getenv func(string) string) string {
	origins := workbenchOrigins(getenv("RS_SERVER_ADDRESS"))
	session := getenv("RS_SESSION_URL")
	id, ok := transformPort(getenv("RS_PORT_TOKEN"), port)
	if len(origins) == 0 || !ok || !strings.HasPrefix(session, "/") {
		return ""
	}
	return origins[0] + strings.TrimSuffix(session, "/") + "/p/" + id + "/"
}
