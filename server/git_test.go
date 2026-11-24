package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func testGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestGitStatusDiffAndStageAcrossRepositories(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git unavailable")
	}
	root := t.TempDir()
	for _, name := range []string{"one", "two"} {
		dir := filepath.Join(root, name)
		if err := os.Mkdir(dir, 0755); err != nil {
			t.Fatal(err)
		}
		testGit(t, dir, "init", "-q")
		testGit(t, dir, "config", "user.name", "Test")
		testGit(t, dir, "config", "user.email", "test@example.com")
		if err := os.WriteFile(filepath.Join(dir, "tracked.txt"), []byte("before\n"), 0644); err != nil {
			t.Fatal(err)
		}
		testGit(t, dir, "add", "tracked.txt")
		testGit(t, dir, "commit", "-qm", "initial")
	}
	one := filepath.Join(root, "one")
	if err := os.WriteFile(filepath.Join(one, "tracked.txt"), []byte("after\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(one, "odd [name].txt"), []byte("new file\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(one, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Token: "test-token", ProjectRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	t.Setenv("GIT_DIR", filepath.Join(root, "two", ".git"))
	t.Setenv("GIT_WORK_TREE", filepath.Join(root, "two"))
	status := func(dir string) []gitChange {
		t.Helper()
		rec := fileRequest(s, http.MethodGet, "/api/git?dir="+url.QueryEscape(dir), nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %s: %d %s", dir, rec.Code, rec.Body.String())
		}
		var data struct {
			Root    string      `json:"root"`
			Changes []gitChange `json:"changes"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if filepath.Base(data.Root) != strings.Split(dir, "/")[0] {
			t.Fatalf("unexpected root %q for %q", data.Root, dir)
		}
		return data.Changes
	}
	changes := status("one/nested")
	if len(changes) != 2 || len(status("two")) != 0 {
		t.Fatalf("wrong repository changes: %+v", changes)
	}
	diff := func(path, group string) string {
		t.Helper()
		rec := fileRequest(s, http.MethodGet, "/api/git?dir=one&file="+url.QueryEscape(path)+"&group="+group, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("diff: %d %s", rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}
	if !strings.Contains(diff("tracked.txt", "unstaged"), "+after") ||
		!strings.Contains(diff("odd [name].txt", "unstaged"), "+new file") {
		t.Fatal("missing diff")
	}
	action := func(path, group, action string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"path": path, "group": group, "action": action})
		rec := fileRequest(s, http.MethodPost, "/api/git?dir=one", strings.NewReader(string(body)))
		if rec.Code != http.StatusNoContent {
			t.Fatalf("%s: %d %s", action, rec.Code, rec.Body.String())
		}
	}
	action("odd [name].txt", "unstaged", "stage")
	action("tracked.txt", "unstaged", "stage")
	if !strings.Contains(diff("tracked.txt", "staged"), "+after") {
		t.Fatal("missing staged diff")
	}
	if err := os.WriteFile(filepath.Join(one, "tracked.txt"), []byte("after\nmodified again\n"), 0644); err != nil {
		t.Fatal(err)
	}
	changes = status("one")
	if len(changes) != 2 || changes[1].Path != "tracked.txt" || changes[1].XY != "MM" ||
		!strings.Contains(diff("tracked.txt", "staged"), "+after") ||
		!strings.Contains(diff("tracked.txt", "unstaged"), "+modified again") {
		t.Fatalf("partially staged changes: %+v", changes)
	}
	action("tracked.txt", "unstaged", "stage")
	changes = status("one")
	if changes[1].XY != "M " || !strings.Contains(diff("tracked.txt", "staged"), "+modified again") {
		t.Fatalf("staging remaining changes: %+v", changes)
	}
	action("odd [name].txt", "staged", "unstage")
	action("tracked.txt", "staged", "unstage")
	changes = status("one")
	if len(changes) != 2 || changes[0].XY != " M" || changes[1].XY != "??" {
		t.Fatalf("unstage lost changes: %+v", changes)
	}
	rec := fileRequest(s, http.MethodGet, "/api/git?dir=one&file=../two/tracked.txt&group=unstaged", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("unexpected diff access: %d", rec.Code)
	}
	rec = fileRequest(s, http.MethodGet, "/api/git?dir=..", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unexpected directory access: %d", rec.Code)
	}
	rec = fileRequest(s, http.MethodGet, "/api/git?dir=", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("non-repository: %d %s", rec.Code, rec.Body.String())
	}
}

func TestGitDetectsAncestorAndNestedRepositories(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git unavailable")
	}
	root := t.TempDir()
	testGit(t, root, "init", "-q")
	project := filepath.Join(root, "project")
	nested := filepath.Join(project, " nested ")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	testGit(t, nested, "init", "-q")
	for _, path := range []string{
		filepath.Join(root, "outside.txt"), filepath.Join(project, "inside.txt"), filepath.Join(nested, "nested.txt"),
	} {
		if err := os.WriteFile(path, []byte("content\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := New(Config{Token: "test-token", ProjectRoot: project})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	for _, tc := range []struct{ dir, want, relative string }{
		{"", root, ".."}, {" nested ", nested, " nested "},
	} {
		rec := fileRequest(s, http.MethodGet, "/api/git?dir="+url.QueryEscape(tc.dir), nil)
		var data struct {
			Root         string      `json:"root"`
			RelativeRoot string      `json:"relativeRoot"`
			Changes      []gitChange `json:"changes"`
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &data) != nil {
			t.Fatalf("status %s: %d %s", tc.dir, rec.Code, rec.Body.String())
		}
		actual, _ := filepath.EvalSymlinks(data.Root)
		expected, _ := filepath.EvalSymlinks(tc.want)
		if actual != expected {
			t.Fatalf("directory %q: got %q, want %q", tc.dir, actual, expected)
		}
		if data.RelativeRoot != tc.relative {
			t.Fatalf("directory %q: relative root = %q, want %q", tc.dir, data.RelativeRoot, tc.relative)
		}
		wantPaths := map[string]string{"outside.txt": "", "project/inside.txt": "inside.txt"}
		if tc.dir != "" {
			wantPaths = map[string]string{"nested.txt": " nested /nested.txt"}
		}
		for _, change := range data.Changes {
			if want, ok := wantPaths[change.Path]; ok {
				if change.ProjectPath != want {
					t.Fatalf("%q project path = %q, want %q", change.Path, change.ProjectPath, want)
				}
				delete(wantPaths, change.Path)
			}
		}
		if len(wantPaths) != 0 {
			t.Fatalf("missing changes: %+v", wantPaths)
		}
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(project, "outside")); err == nil {
		rec := fileRequest(s, http.MethodGet, "/api/git?dir=outside", nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("symlink escape: %d %s", rec.Code, rec.Body.String())
		}
	}
}

func TestGitCommitBranchesLogAndPush(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git unavailable")
	}
	root := t.TempDir()
	testGit(t, root, "init", "-q")
	testGit(t, root, "config", "user.name", "Test")
	testGit(t, root, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("first\n"), 0644); err != nil {
		t.Fatal(err)
	}
	testGit(t, root, "add", "tracked.txt")
	testGit(t, root, "commit", "-qm", "initial")
	branchOut, err := gitCommand(root, "branch", "--show-current")
	if err != nil {
		t.Fatal(err)
	}
	mainBranch := strings.TrimSpace(string(branchOut))

	remote := filepath.Join(t.TempDir(), "remote.git")
	testGit(t, t.TempDir(), "init", "--bare", remote)
	testGit(t, root, "remote", "add", "origin", remote)

	s, err := New(Config{Token: "test-token", ProjectRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	post := func(body string, want int) {
		t.Helper()
		rec := fileRequest(s, http.MethodPost, "/api/git?dir=", strings.NewReader(body))
		if rec.Code != want {
			t.Fatalf("POST %s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	post(`{"action":"commit","message":"no staged changes"}`, http.StatusConflict)
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("second\n"), 0644); err != nil {
		t.Fatal(err)
	}
	testGit(t, root, "add", "tracked.txt")
	post(`{"action":"commit","message":"second change"}`, http.StatusNoContent)

	testGit(t, root, "switch", "-c", "feature")
	post(`{"action":"switch","name":"`+mainBranch+`"}`, http.StatusNoContent)
	post(`{"action":"cleanup","base":"`+mainBranch+`","local":["feature"],"remoteBranches":[],"worktrees":[],"removeWorktrees":false}`, http.StatusNoContent)
	post(`{"action":"push"}`, http.StatusNoContent)
	post(`{"action":"pull"}`, http.StatusNoContent)

	rec := fileRequest(s, http.MethodGet, "/api/git?dir=", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
	}
	var data struct {
		Branch   string        `json:"branch"`
		Branches []string      `json:"branches"`
		Remotes  []string      `json:"remotes"`
		Upstream string        `json:"upstream"`
		Log      []gitLogEntry `json:"log"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.Branch != mainBranch || len(data.Branches) != 1 || data.Branches[0] != mainBranch ||
		len(data.Remotes) != 1 || data.Remotes[0] != "origin" ||
		data.Upstream != "origin/"+mainBranch || len(data.Log) != 2 {
		t.Fatalf("unexpected Git info: %+v", data)
	}
	rec = fileRequest(s, http.MethodGet, "/api/git?dir=&sha="+url.QueryEscape(data.Log[0].Hash), nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "+second") ||
		!strings.Contains(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("commit diff: %d %s", rec.Code, rec.Body.String())
	}
	rec = fileRequest(s, http.MethodGet, "/api/git?dir=&sha=--help", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid commit ID: %d %s", rec.Code, rec.Body.String())
	}
}

func TestGitUnstageUnbornAndRename(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git unavailable")
	}
	root := t.TempDir()
	testGit(t, root, "init", "-q")
	testGit(t, root, "config", "user.name", "Test")
	testGit(t, root, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(root, "old"), []byte("file\n"), 0644); err != nil {
		t.Fatal(err)
	}
	testGit(t, root, "add", "old")
	s, err := New(Config{Token: "test-token", ProjectRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.watcher.Close() })
	status := fileRequest(s, http.MethodGet, "/api/git?dir=", nil)
	var info struct {
		RelativeRoot string `json:"relativeRoot"`
	}
	if status.Code != http.StatusOK || json.Unmarshal(status.Body.Bytes(), &info) != nil || info.RelativeRoot != "." {
		t.Fatalf("repository at project root: %d %s", status.Code, status.Body.String())
	}
	rec := fileRequest(s, http.MethodPost, "/api/git?dir=", strings.NewReader(`{"path":"old","group":"staged","action":"unstage"}`))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unborn unstage: %d %s", rec.Code, rec.Body.String())
	}
	testGit(t, root, "add", "old")
	testGit(t, root, "commit", "-qm", "initial")
	testGit(t, root, "mv", "old", "new")
	rec = fileRequest(s, http.MethodPost, "/api/git?dir=", strings.NewReader(`{"path":"new","group":"staged","action":"unstage"}`))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("rename unstage: %d %s", rec.Code, rec.Body.String())
	}
	changes, err := gitStatus(root)
	if err != nil || len(changes) != 2 || changes[0].XY != " D" || changes[1].XY != "??" {
		t.Fatalf("rename unstage: %+v %v", changes, err)
	}
	testGit(t, root, "add", "-A")
	testGit(t, root, "commit", "-qm", "rename")
	testGit(t, root, "rm", "-q", "--", "new")
	if err := os.WriteFile(filepath.Join(root, "new"), []byte("replacement\n"), 0644); err != nil {
		t.Fatal(err)
	}
	changes, err = gitStatus(root)
	if err != nil || len(changes) != 2 || changes[0].Path != "new" || changes[0].XY != "D " ||
		changes[1].Path != "new" || changes[1].XY != "??" {
		t.Fatalf("staged deletion and recreated file: %+v %v", changes, err)
	}
	rec = fileRequest(s, http.MethodPost, "/api/git?dir=", strings.NewReader(`{"path":"new","group":"unstaged","action":"stage"}`))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("stage recreated file: %d %s", rec.Code, rec.Body.String())
	}
	changes, err = gitStatus(root)
	if err != nil || len(changes) != 1 || changes[0].XY != "M " {
		t.Fatalf("staging recreated file: %+v %v", changes, err)
	}
}
