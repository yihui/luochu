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
	"sort"
	"strings"
	"unicode/utf8"
)

type gitChange struct {
	Path        string `json:"path"`
	Old         string `json:"old,omitempty"`
	XY          string `json:"xy"`
	ProjectPath string `json:"projectPath,omitempty"`
}

type gitLogEntry struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
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
	if !pathWithin(s.projectRoot, full) {
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

func gitBranches(root string) ([]string, error) {
	return gitLines(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")
}

func gitRemotes(root string) ([]string, error) {
	return gitLines(root, "remote")
}

func gitLines(root string, args ...string) ([]string, error) {
	out, err := gitCommand(root, args...)
	if err != nil {
		return nil, err
	}
	lines := make([]string, 0)
	for _, name := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if name != "" {
			lines = append(lines, name)
		}
	}
	return lines, nil
}

func gitLog(root string) ([]gitLogEntry, error) {
	out, err := gitCommand(root, "log", "-n", "50", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI")
	if err != nil {
		if strings.Contains(err.Error(), "does not have any commits yet") {
			return []gitLogEntry{}, nil
		}
		return nil, err
	}
	entries := make([]gitLogEntry, 0)
	for _, line := range strings.Split(strings.TrimSuffix(string(out), "\n"), "\n") {
		parts := strings.SplitN(line, "\x1f", 5)
		if len(parts) != 5 {
			continue
		}
		entries = append(entries, gitLogEntry{Hash: parts[0], Short: parts[1], Subject: parts[2],
			Author: parts[3], Date: parts[4]})
	}
	return entries, nil
}

func cleanupPreview(root, base string) (map[string]any, error) {
	if base == "" {
		branches, err := gitBranches(root)
		if err != nil {
			return nil, err
		}
		found := make(map[string]bool)
		for _, branch := range branches {
			found[branch] = true
		}
		if found["main"] {
			base = "main"
		} else if found["master"] {
			base = "master"
		} else {
			out, err := gitCommand(root, "branch", "--show-current")
			if err != nil {
				return nil, err
			}
			base = strings.TrimSpace(string(out))
		}
	}
	fetchNote := ""
	if _, err := gitCommand(root, "fetch", "--all", "--prune"); err != nil {
		fetchNote = err.Error()
	}
	mergedOut, err := gitCommand(root, "branch", "--merged", base, "--format=%(refname:short)")
	if err != nil {
		return nil, err
	}
	goneOut, err := gitCommand(root, "for-each-ref",
		"--format=%(refname:short)%09%(upstream:track)", "refs/heads")
	if err != nil {
		return nil, err
	}
	currentOut, _ := gitCommand(root, "branch", "--show-current")
	current := strings.TrimSpace(string(currentOut))
	localBranches, err := gitBranches(root)
	if err != nil {
		return nil, err
	}
	localSet := make(map[string]bool)
	for _, name := range localBranches {
		localSet[name] = true
	}
	candidates := make(map[string]string)
	for _, name := range strings.Split(strings.TrimSpace(string(mergedOut)), "\n") {
		name = strings.TrimSpace(name)
		if name != "" && name != base && name != current {
			candidates[name] = "merged"
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(string(goneOut)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) == 2 && strings.Contains(parts[1], "gone") {
			name := strings.TrimSpace(parts[0])
			if name != "" && name != base && name != current {
				candidates[name] = "remote branch deleted"
			}
		}
	}
	if _, err := exec.LookPath("gh"); err == nil {
		for _, state := range []string{"merged", "closed"} {
			cmd := exec.Command("gh", "pr", "list", "--state", state,
				"--json", "headRefName", "--limit", "100")
			cmd.Dir = root
			cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1")
			out, err := cmd.Output()
			if err != nil {
				continue
			}
			var prs []struct {
				HeadRefName string `json:"headRefName"`
			}
			if json.Unmarshal(out, &prs) != nil {
				continue
			}
			for _, pr := range prs {
				name := strings.TrimSpace(pr.HeadRefName)
				if name != "" && name != base && name != current && localSet[name] {
					if _, exists := candidates[name]; !exists {
						candidates[name] = state + " PR"
					}
				}
			}
		}
	}
	local := make([]map[string]string, 0)
	for name, reason := range candidates {
		if !localSet[name] {
			continue
		}
		local = append(local, map[string]string{"name": name, "reason": reason})
	}
	sort.Slice(local, func(i, j int) bool { return local[i]["name"] < local[j]["name"] })
	worktrees := make([]map[string]any, 0)
	if out, err := gitCommand(root, "worktree", "list", "--porcelain"); err == nil {
		var path, branch string
		for _, line := range append(strings.Split(string(out), "\n"), "") {
			if line == "" {
				if branch != "" {
					if _, exists := candidates[branch]; exists {
						worktrees = append(worktrees, map[string]any{"path": path, "branch": branch})
					}
				}
				path, branch = "", ""
			} else if strings.HasPrefix(line, "worktree ") {
				path = strings.TrimPrefix(line, "worktree ")
			} else if strings.HasPrefix(line, "branch refs/heads/") {
				branch = strings.TrimPrefix(line, "branch refs/heads/")
			}
		}
	}
	return map[string]any{"base": base, "local": local, "worktrees": worktrees, "fetchNote": fetchNote}, nil
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
	if r.Method == http.MethodGet && r.URL.Query().Get("file") == "" && r.URL.Query().Get("sha") == "" {
		branch, err := gitCommand(root, "branch", "--show-current")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		branches, err := gitBranches(root)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		remotes, err := gitRemotes(root)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logEntries, err := gitLog(root)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		upstreamOut, upstreamErr := gitCommand(root, "rev-parse", "--abbrev-ref", "@{upstream}")
		upstream := ""
		ahead, behind := 0, 0
		if upstreamErr == nil {
			upstream = strings.TrimSpace(string(upstreamOut))
			countOut, countErr := gitCommand(root, "rev-list", "--left-right", "--count", "HEAD..."+upstream)
			if countErr == nil {
				fields := strings.Fields(string(countOut))
				if len(fields) == 2 {
					_, _ = fmt.Sscanf(fields[0], "%d", &ahead)
					_, _ = fmt.Sscanf(fields[1], "%d", &behind)
				}
			}
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
		writeJSONNoStore(w, map[string]any{
			"root": root, "relativeRoot": filepath.ToSlash(relative),
			"branch": strings.TrimSpace(string(branch)), "branches": branches, "remotes": remotes,
			"upstream": upstream, "ahead": ahead, "behind": behind, "log": logEntries,
			"changes": changes,
		})
		return
	}
	var path, group, action, message, name, remote, base string
	var localNames []string
	var worktreePaths []string
	if r.Method == http.MethodPost {
		var input struct {
			Path      string   `json:"path"`
			Group     string   `json:"group"`
			Action    string   `json:"action"`
			Message   string   `json:"message"`
			Name      string   `json:"name"`
			Remote    string   `json:"remote"`
			Base      string   `json:"base"`
			Local     []string `json:"local"`
			Worktrees []string `json:"worktrees"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		path, group, action = input.Path, input.Group, input.Action
		message, name, remote = input.Message, input.Name, input.Remote
		base, localNames = input.Base, input.Local
		worktreePaths = input.Worktrees
	} else {
		path, group = r.URL.Query().Get("file"), r.URL.Query().Get("group")
	}
	if r.Method == http.MethodPost {
		switch action {
		case "commit":
			message = strings.TrimSpace(message)
			if message == "" {
				http.Error(w, "commit message is required", http.StatusBadRequest)
				return
			}
			staged, err := gitCommand(root, "diff", "--cached", "--name-only")
			if err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			if len(bytes.TrimSpace(staged)) == 0 {
				http.Error(w, "No staged changes", http.StatusConflict)
				return
			}
			if _, err := gitCommand(root, "commit", "-m", message); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		case "switch":
			name = strings.TrimSpace(name)
			if name == "" {
				http.Error(w, "branch name is required", http.StatusBadRequest)
				return
			}
			if _, err := gitCommand(root, "switch", name); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		case "pull":
			if _, err := gitCommand(root, "pull", "--ff-only"); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		case "cleanup-preview":
			data, err := cleanupPreview(root, strings.TrimSpace(base))
			if err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			writeJSONNoStore(w, data)
			return
		case "cleanup":
			for _, wt := range worktreePaths {
				wt = strings.TrimSpace(wt)
				if wt == "" {
					continue
				}
				if out, err := gitCommand(wt, "status", "--porcelain"); err != nil {
					http.Error(w, err.Error(), http.StatusConflict)
					return
				} else if len(bytes.TrimSpace(out)) > 0 {
					http.Error(w, "Refusing to remove dirty worktree: "+wt, http.StatusConflict)
					return
				}
				if _, err := gitCommand(root, "worktree", "remove", wt); err != nil {
					http.Error(w, err.Error(), http.StatusConflict)
					return
				}
			}
			for _, name := range localNames {
				name = strings.TrimSpace(name)
				if name == "" || name == base {
					continue
				}
				if _, err := gitCommand(root, "branch", "-D", name); err != nil {
					http.Error(w, err.Error(), http.StatusConflict)
					return
				}
			}
			w.WriteHeader(http.StatusNoContent)
			return
		case "push":
			remotes, err := gitRemotes(root)
			if err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			upstreamOut, upstreamErr := gitCommand(root, "rev-parse", "--abbrev-ref", "@{upstream}")
			if upstreamErr == nil {
				upstreamParts := strings.SplitN(strings.TrimSpace(string(upstreamOut)), "/", 2)
				if len(upstreamParts) == 2 {
					remote = upstreamParts[0]
				}
			}
			if remote == "" {
				remote = strings.TrimSpace(remote)
				if remote == "" && len(remotes) > 0 {
					remote = remotes[0]
				}
			}
			if remote == "" {
				http.Error(w, "No Git remote configured", http.StatusConflict)
				return
			}
			branchOut, err := gitCommand(root, "branch", "--show-current")
			if err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			branchName := strings.TrimSpace(string(branchOut))
			if branchName == "" {
				http.Error(w, "Detached HEAD cannot be pushed", http.StatusConflict)
				return
			}
			args := []string{"push"}
			if upstreamErr != nil {
				args = append(args, "--set-upstream")
			}
			args = append(args, remote, branchName)
			if _, err := gitCommand(root, args...); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	if r.Method == http.MethodGet {
		if sha := strings.TrimSpace(r.URL.Query().Get("sha")); sha != "" {
			if len(sha) != 40 && len(sha) != 64 || strings.Trim(sha, "0123456789abcdefABCDEF") != "" {
				http.Error(w, "invalid commit ID", http.StatusBadRequest)
				return
			}
			out, err := gitCommand(root, "show", "--no-color", "--no-ext-diff", "--no-textconv", sha+"^{commit}", "--")
			if err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			writeGitText(w, out)
			return
		}
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
	writeGitText(w, out)
}

func writeGitText(w http.ResponseWriter, out []byte) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(out)
}
