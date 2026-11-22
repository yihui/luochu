package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/yihui/luochu/server"
)

func main() {
	var (
		host    = flag.String("host", "127.0.0.1", "HTTP listen host")
		port    = flag.Int("port", 0, "HTTP listen port; 0 chooses an available port")
		prefix  = flag.String("base-path", "", "URL prefix, for example /p/1234")
		origins = flag.String("allow-origin", "", "comma-separated browser origins")
	)
	flag.Parse()

	basePath := strings.TrimSpace(*prefix)
	if basePath != "" && basePath != "/" {
		basePath = "/" + strings.Trim(basePath, "/")
	}
	if basePath == "/" {
		basePath = ""
	}

	originList := []string{}
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
		BasePath: basePath,
		Token:    token,
		Origins:  originList,
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
	log.Printf("Luochu listening on http://%s:%d%s/?token=%s", *host, portURL, basePath, token)
	log.Printf("The token is printed once and is required for every HTTP and WebSocket request")

	if err := http.Serve(listener, handler); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
