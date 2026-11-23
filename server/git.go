package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type gitChange struct {
	Path        string `json:"path"`
	Old         string `json:"old,omitempty"`
	XY          string `json:"xy"`
	ProjectPath string `json:"projectPath,omitempty"`
}

func gitAvailable() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func gitCommand(dir string, args ...string) ([]byte, error) {
	return runGit(dir, false, args...)
}

func runGit(dir string, diffExit bool, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"--no-pager", "-C", dir}, args...)...)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "GIT_LITERAL_PATHSPECS=1", "LC_ALL=C")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if diffExit && errors.As(err, &exit) && exit.ExitCode() == 1 {
			return out, nil
		}
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return out, fmt.Errorf("git: %s", detail)
		}
		return out, fmt.Errorf("git: %w", err)
	}
	return out, nil
}

func (s *Server) gitDirectory(path string) (string, error) {
	full, err := s.projectPath(path)
	if err != nil {
		return "", err
	}
	full, err = filepath.EvalSymlinks(full)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(s.projectRoot, full)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes project root")
	}
	info, err := os.Stat(full)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("path is not a directory")
	}
	return full, nil
}

func gitStatus(root string) ([]gitChange, error) {
	out, err := gitCommand(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	records := bytes.Split(out, []byte{0})
	changes := make([]gitChange, 0)
	for i := 0; i < len(records); i++ {
		record := records[i]
		if len(record) == 0 {
			continue
		}
		if len(record) < 4 || record[2] != ' ' || !utf8.Valid(record[3:]) {
			return nil, errors.New("invalid git status output")
		}
		change := gitChange{Path: string(record[3:]), XY: string(record[:2])}
		if record[0] == 'R' || record[0] == 'C' || record[1] == 'R' || record[1] == 'C' {
			i++
			if i >= len(records) || len(records[i]) == 0 || !utf8.Valid(records[i]) {
				return nil, errors.New("invalid git rename output")
			}
			change.Old = string(records[i])
		}
		changes = append(changes, change)
	}
	return changes, nil
}

func (s *Server) serveGit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	dir, err := s.gitDirectory(r.URL.Query().Get("dir"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := gitCommand(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		if strings.Contains(err.Error(), "not a git repository") {
			http.Error(w, "Not a Git repository", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	root := strings.TrimSuffix(strings.TrimSuffix(string(out), "\n"), "\r")
	changes, err := gitStatus(root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Get("file") == "" {
		branch, err := gitCommand(root, "branch", "--show-current")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		relative, err := filepath.Rel(s.projectRoot, root)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for i := range changes {
			path, err := filepath.Rel(s.projectRoot, filepath.Join(root, filepath.FromSlash(changes[i].Path)))
			if err == nil && path != ".." && !strings.HasPrefix(path, ".."+string(filepath.Separator)) {
				changes[i].ProjectPath = filepath.ToSlash(path)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"root": root, "relativeRoot": filepath.ToSlash(relative),
			"branch": strings.TrimSpace(string(branch)), "changes": changes,
		})
		return
	}
	var path, group, action string
	if r.Method == http.MethodPost {
		var input struct {
			Path   string `json:"path"`
			Group  string `json:"group"`
			Action string `json:"action"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		path, group, action = input.Path, input.Group, input.Action
	} else {
		path, group = r.URL.Query().Get("file"), r.URL.Query().Get("group")
	}
	var selected *gitChange
	for i := range changes {
		change := &changes[i]
		if change.Path == path && (group == "staged" && change.XY[0] != ' ' && change.XY != "??" ||
			group == "unstaged" && (change.XY[1] != ' ' || change.XY == "??")) {
			selected = change
			break
		}
	}
	if selected == nil {
		http.Error(w, "change no longer exists; refresh status", http.StatusConflict)
		return
	}
	paths := []string{selected.Path}
	if selected.Old != "" && group == "staged" {
		paths = append(paths, selected.Old)
	}
	if r.Method == http.MethodPost {
		var args []string
		switch {
		case action == "stage" && group == "unstaged":
			args = []string{"add", "-A", "--"}
		case action == "unstage" && group == "staged":
			args = []string{"reset", "-q", "--"}
		default:
			http.Error(w, "invalid action", http.StatusBadRequest)
			return
		}
		if _, err := gitCommand(root, append(args, paths...)...); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	args := []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv"}
	if selected.XY == "??" {
		// --no-index reports differences with exit status 1.
		out, err = runGit(root, true, "diff", "--no-index",
			"--no-color", "--no-ext-diff", "--no-textconv", "--", os.DevNull, selected.Path)
	} else {
		if group == "staged" {
			args = append(args, "--cached")
		}
		args = append(args, "--")
		out, err = gitCommand(root, append(args, paths...)...)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(out)
}
