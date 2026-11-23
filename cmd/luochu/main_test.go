package main

import (
	"flag"
	"os"
	"testing"
)

func testBrowserFlag(t *testing.T, stdin *os.File, defaultOpen bool) {
	t.Helper()
	for _, tt := range []struct {
		name string
		args []string
		want bool
	}{
		{"default", nil, defaultOpen},
		{"open", []string{"-open"}, true},
		{"no open", []string{"-open=false"}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			flags := flag.NewFlagSet("test", flag.ContinueOnError)
			open := browserFlag(flags, stdin)
			if err := flags.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			if *open != tt.want {
				t.Errorf("open = %v, want %v", *open, tt.want)
			}
		})
	}
}

func TestBrowserFlagNonTerminal(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	testBrowserFlag(t, reader, false)
}

func TestWorkbenchOrigins(t *testing.T) {
	tests := map[string][]string{
		"https://rstudio.example":         {"https://rstudio.example"},
		" https://rstudio.example:8787/ ": {"https://rstudio.example:8787"},
		"":                                nil,
		"javascript://x":                  nil,
		"rstudio.example":                 nil,
	}
	for address, want := range tests {
		got := workbenchOrigins(address)
		if len(got) != len(want) || (len(got) == 1 && got[0] != want[0]) {
			t.Errorf("workbenchOrigins(%q) = %v, want %v", address, got, want)
		}
	}
}
