package main

import "testing"

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
