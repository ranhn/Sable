package server

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Autumn-27/artex/db"
)

// Word export for finding reports.
//
// The Markdown report stays the source of truth; Word is a rendering of it. python-docx
// is used because it lays out tables/code/images the way the reference reports do
// (which the browser print-to-PDF path cannot match), and it resolves the inline
// screenshot links back to files on disk so each image lands in the step it belongs to.
//
// SHOTS_ROOT is handed to the script through the environment so the converter never
// has to guess where the data dir is.

const docxConverter = "/opt/sable/tools/docx/md2docx.py"

func (s *Server) renderFindingDocx(mdPath, outPath string) error {
	ctx, cancel := context.WithTimeout(s.ctx, 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", docxConverter, mdPath, outPath)
	cmd.Env = append(os.Environ(), "SHOTS_ROOT="+filepath.Join(s.m.dir, "shots"))
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docx conversion failed: %v: %s", err, strings.TrimSpace(string(out)))
	}
	if st, err := os.Stat(outPath); err != nil || st.Size() == 0 {
		return fmt.Errorf("docx conversion produced no output")
	}
	return nil
}

// safeDocxName turns a finding title into a filename that survives Windows/macOS.
func safeDocxName(id int64, name string) string {
	rep := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "", "\"", "", "<", "", ">", "", "|", "-", "\n", " ", "\t", " ")
	base := strings.TrimSpace(rep.Replace(name))
	if base == "" {
		base = "finding"
	}
	if r := []rune(base); len(r) > 60 {
		base = string(r[:60])
	}
	return fmt.Sprintf("%d-%s.docx", id, base)
}

// findingDocx renders one finding report to Word.
func (s *Server) findingDocx(id int64) (string, string, error) {
	fs, err := s.m.pg.ListFindingsForExport(db.FindingFilter{}, []int64{id})
	if err != nil {
		return "", "", err
	}
	if len(fs) == 0 {
		return "", "", fmt.Errorf("finding not found")
	}
	f := fs[0]
	if strings.TrimSpace(f.Report) == "" {
		return "", "", fmt.Errorf("finding has no report yet")
	}
	dir, err := os.MkdirTemp("", "ning-docx-")
	if err != nil {
		return "", "", err
	}
	mdPath := filepath.Join(dir, "report.md")
	if err := os.WriteFile(mdPath, []byte(f.Report), 0o644); err != nil {
		return "", "", err
	}
	outPath := filepath.Join(dir, "report.docx")
	if err := s.renderFindingDocx(mdPath, outPath); err != nil {
		return "", "", err
	}
	return outPath, safeDocxName(f.ID, f.Name), nil
}

// exportFindingDocx serves GET /api/findings/{id}/report.docx
func (s *Server) exportFindingDocx(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad finding id")
		return
	}
	path, name, err := s.findingDocx(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	defer os.RemoveAll(filepath.Dir(path))
	file, err := os.Open(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer file.Close()
	st, _ := file.Stat()
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, "finding.docx", urlEscape(name)))
	http.ServeContent(w, r, name, st.ModTime(), file)
}

// buildFindingDocxZip renders every finding in fs to .docx and packs them.
func (s *Server) buildFindingDocxZip(dest string, fs []*db.DBFinding) error {
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	zw := zip.NewWriter(out)
	defer zw.Close()

	stage, err := os.MkdirTemp("", "ning-docx-zip-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)

	for i, f := range fs {
		if strings.TrimSpace(f.Report) == "" {
			continue
		}
		mdPath := filepath.Join(stage, fmt.Sprintf("f%d.md", i))
		if err := os.WriteFile(mdPath, []byte(f.Report), 0o644); err != nil {
			return err
		}
		docxPath := filepath.Join(stage, fmt.Sprintf("f%d.docx", i))
		if err := s.renderFindingDocx(mdPath, docxPath); err != nil {
			return fmt.Errorf("finding %d: %w", f.ID, err)
		}
		entry, err := zw.Create(safeDocxName(f.ID, f.Name))
		if err != nil {
			return err
		}
		src, err := os.Open(docxPath)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(entry, src)
		src.Close()
		if copyErr != nil {
			return copyErr
		}
	}
	return nil
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(fmt.Sprintf("%02x", c)))
		}
	}
	return b.String()
}
