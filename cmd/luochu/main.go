package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/yihui/luochu/server"
)

func main() {
	var (
		host        = flag.String("host", "127.0.0.1", "HTTP listen host")
		port        = flag.Int("port", 0, "HTTP listen port; 0 chooses an available port")
		prefix      = flag.String("base-path", "", "URL prefix, for example /p/1234")
		origins     = flag.String("allow-origin", "", "comma-separated browser origins")
		project     = flag.String("project", ".", "local project root")
		openBrowser = flag.Bool("open", false, "open Luochu in the default browser")
	)
	flag.Parse()

	basePath := strings.TrimSpace(*prefix)
	if basePath != "" && basePath != "/" {
		basePath = "/" + strings.Trim(basePath, "/")
	}

	if basePath == "/" {
		basePath = ""
	}

	originList := workbenchOrigins(os.Getenv("RS_SERVER_ADDRESS"))
	if strings.TrimSpace(*origins) != "" {
		for _, origin := range strings.Split(*origins, ",") {
			if origin = strings.TrimSpace(origin); origin != "" {
				originList = append(originList, origin)
			}
		}
	}

	token, err := server.GenerateToken()
	if err != nil {
		log.Fatal(err)
	}
	handler, err := server.New(server.Config{
		BasePath:    basePath,
		Token:       token,
		Origins:     originList,
		ProjectRoot: *project,
	})
	if err != nil {
		log.Fatal(err)
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", *host, *port))
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()

	addr := listener.Addr().(*net.TCPAddr)
	portURL := addr.Port
	url := fmt.Sprintf("http://%s:%d%s/?token=%s", *host, portURL, basePath, token)
	log.Printf("Luochu listening on %s", url)
	if public := workbenchURL(portURL, os.Getenv); public != "" {
		log.Printf("Open in Posit Workbench: %s?token=%s", public, token)
	}
	log.Printf("The token is printed once and is required for every HTTP and WebSocket request")
	if *openBrowser {
		go openURL(url)
	}

	if err := http.Serve(listener, handler); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func openURL(url string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", url)
	case "linux":
		command = exec.Command("xdg-open", url)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return
	}
	_ = command.Start()
}

// workbenchOrigins returns the browser origin behind a Posit Workbench proxy.
// The Workbench server sets RS_SERVER_ADDRESS, so this is trusted config rather
// than request headers. Only scheme and host are kept; the path varies per session.
func workbenchOrigins(address string) []string {
	parsed, err := url.Parse(strings.TrimSpace(address))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil
	}
	return []string{parsed.Scheme + "://" + parsed.Host}
}
