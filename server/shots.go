package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// serveShot serves a screenshot captured during a run.
//
// The worker takes them with `google-chrome --headless --screenshot=<dir>/<name>.png`
// and pastes `![proof](/sable/api/shots/<task>/<name>.png)` into the step output, so the
// transcript can render the image right next to the command that produced it.
//
// Resolution is confined to <data>/shots: both sides are made absolute and the result
// must stay under the root, so "../../etc/passwd" and absolute paths are rejected
// rather than passed to http.ServeFile and left to its own checks.
func (s *Server) serveShot(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.PathValue("path"), "/")
	if rel == "" {
		writeErr(w, http.StatusNotFound, "screenshot not found")
		return
	}
	root, err := filepath.Abs(filepath.Join(s.m.dir, "shots"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	full, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil || !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		writeErr(w, http.StatusForbidden, "invalid screenshot path")
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		writeErr(w, http.StatusNotFound, "screenshot not found")
		return
	}
	// Screenshots are immutable once written (name carries a timestamp), so a long
	// cache is safe and keeps the transcript from re-fetching them on every poll.
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, full)
}
