package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Autumn-27/artex/db"
)

// Evidence screenshots.
//
// When a finding is demonstrably visible in a browser, a picture of the actual page is
// far harder to argue with than a paragraph. A scanner watches the findings table for
// new rows, decides whether the finding has a browser-visible manifestation, captures
// the live page through puppeteer (so cookies and XSS dialogs work), and drops the
// image into the step stream next to the intent that produced it.
//
// Everything is an observation of the real page. When a capture is impossible the step
// says why — a silently missing image is worse than a stated limitation.

// shotJob is one queued capture. The queue is deliberately serial: a headless Chrome
// costs ~150MB and the box also runs the agent workers.
type shotJob struct {
	taskID    int64
	intentID  int64
	findingID int64
	url       string
	kind      string // "xss" | "page"
}

var shotURLRe = regexp.MustCompile(`https?://[^\s"'<>()\[\]{}]+`)

// classifyShotTarget decides whether a finding has a browser-visible manifestation.
// Only things a person could see in a browser qualify; protocol-level findings (SQLi
// payload output, SSRF, TCP, command execution) keep their text evidence.
func classifyShotTarget(vulnclass, evidence string) string {
	lc := strings.ToLower(vulnclass + " " + evidence)
	xss := strings.Contains(lc, "xss") || strings.Contains(lc, "csrf") ||
		strings.Contains(lc, "clickjack") || strings.Contains(lc, "html injection") ||
		strings.Contains(lc, "dom-based")
	page := strings.Contains(lc, "<html") || strings.Contains(lc, "text/html") ||
		strings.Contains(lc, "页面") || strings.Contains(lc, "渲染") ||
		strings.Contains(lc, "弹窗")
	switch {
	case xss:
		return "xss"
	case page:
		return "page"
	}
	return ""
}

// extractEvidenceURL pulls the most likely proof URL out of the evidence text.
func extractEvidenceURL(evidence string) string {
	for _, raw := range shotURLRe.FindAllString(evidence, 6) {
		u := strings.TrimRight(raw, ".,;:)]}\\"+`'`)
		if strings.HasSuffix(strings.ToLower(u), ".json") {
			continue
		}
		return u
	}
	return ""
}

// shotScannerLoop watches for newly registered findings and queues captures for the
// ones that can be photographed. It starts from the current max id so a restart does
// not walk the whole history.
func (s *Server) shotScannerLoop() {
	last := int64(0)
	if err := s.m.pg.QueryRow(`SELECT COALESCE(MAX(id),0) FROM findings`).Scan(&last); err != nil {
		log.Printf("[shot] scanner disabled: %v", err)
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
		rows, err := s.m.pg.Query(`SELECT id, COALESCE(task_id,0), COALESCE(node_id,0),
			COALESCE(vulnclass,''), COALESCE(evidence,'')
			FROM findings WHERE id > $1 ORDER BY id LIMIT 20`, last)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id, taskID, nodeID int64
			var vulnclass, evidence string
			if err := rows.Scan(&id, &taskID, &nodeID, &vulnclass, &evidence); err != nil {
				continue
			}
			if id > last {
				last = id
			}
			kind := classifyShotTarget(vulnclass, evidence)
			url := extractEvidenceURL(evidence)
			if kind == "" || url == "" {
				continue
			}
			select {
			case s.shotQueue <- shotJob{taskID: taskID, intentID: nodeID, findingID: id, url: url, kind: kind}:
			default:
				log.Printf("[shot] queue full, dropping capture for finding %d", id)
			}
		}
		rows.Close()
	}
}

func (s *Server) shotQueueLoop() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case job := <-s.shotQueue:
			s.captureFindingShot(job)
		}
	}
}

func (s *Server) captureFindingShot(job shotJob) {
	t := s.m.ResolveTask(strconv.FormatInt(job.taskID, 10))
	if t == nil {
		return
	}
	name := fmt.Sprintf("finding-%d-%d.png", job.findingID, time.Now().Unix())
	dir := filepath.Join(s.m.dir, "shots", strconv.FormatInt(job.taskID, 10))
	out := filepath.Join(dir, name)
	_ = os.MkdirAll(dir, 0o755)

	ctx, cancel := context.WithTimeout(s.ctx, 75*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "/opt/sable/tools/shot/shot.js", job.url, out, "--wait", "2500")
	cmd.Env = append(os.Environ(), "HOME=/home/ubuntu")
	raw, err := cmd.Output()

	var result struct {
		OK     bool   `json:"ok"`
		Status int    `json:"status"`
		Title  string `json:"title"`
		Dialog string `json:"dialog"`
		Error  string `json:"error"`
	}
	line := strings.TrimSpace(string(raw))
	if i := strings.LastIndex(line, "\n"); i >= 0 {
		line = line[i+1:]
	}
	_ = json.Unmarshal([]byte(line), &result)
	if err != nil && result.Error == "" {
		result.Error = strings.TrimSpace(err.Error())
	}

	shotURL := fmt.Sprintf("/ning/api/shots/%d/%s", job.taskID, name)
	meta := "link: " + shotURL
	if result.Dialog != "" {
		meta += "\ndialog: " + result.Dialog
	}
	if result.OK {
		s.engine.emitActivity(t, db.Activity{
			Worker: "screenshot", Kind: "tool_result", Tool: "capture_screenshot",
			Summary: fmt.Sprintf("%s · HTTP %d · %s", truncate(job.url, 88), result.Status, truncate(result.Title, 56)),
			Detail:  "Evidence screenshot of the live page:\n\n![proof](" + shotURL + ")\n\n" + meta,
		})
		log.Printf("[shot] task %d finding %d captured %s", job.taskID, job.findingID, shotURL)
		return
	}
	reason := result.Error
	if reason == "" {
		reason = "capture produced no usable image"
	}
	s.engine.emitActivity(t, db.Activity{
		Worker: "screenshot", Kind: "tool_result", Tool: "capture_screenshot", IsError: true,
		Summary: "screenshot unavailable · " + truncate(job.url, 88),
		Detail: fmt.Sprintf("No browser-visible proof could be captured for this finding.\nurl: %s\nreason: %s\n"+
			"The finding keeps its textual evidence; this is not a missing step.", job.url, reason),
	})
	log.Printf("[shot] task %d finding %d failed: %s", job.taskID, job.findingID, reason)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
