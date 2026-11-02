package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Autumn-27/artex/db"
)

const (
	maxTaskNameRunes           = 200
	maxTaskMetadataRequestSize = 16 << 10
	// Upper bound for a task-level wall-clock budget (30 days). 0 means unlimited.
	maxTaskTimeoutSeconds = 30 * 24 * 3600
)

// updateTaskMetadata changes list-only task metadata. It intentionally does not
// touch lifecycle state, scheduling, or the task's immutable description/goal.
func (s *Server) updateTaskMetadata(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("id")
	if _, ok := s.m.Task(taskID); !ok {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxTaskMetadataRequestSize)
	var request struct {
		Name           *string `json:"name"`
		Pinned         *bool   `json:"pinned"`
		PlanQuietMode  *bool   `json:"plan_quiet_mode"`
		TimeoutSeconds *int    `json:"timeout_seconds"`
	}
	if err := decode(r, &request); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeErr(w, http.StatusRequestEntityTooLarge, "request body too large")
		} else {
			writeErr(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	if request.Name == nil && request.Pinned == nil && request.PlanQuietMode == nil && request.TimeoutSeconds == nil {
		writeErr(w, http.StatusBadRequest, "at least one of name, pinned, plan_quiet_mode or timeout_seconds must be provided")
		return
	}
	if request.TimeoutSeconds != nil {
		// 0 clears the limit. The upper bound is a sanity check, not a policy: a task
		// that "runs for a year" is almost always a unit mistake (ms vs s).
		if *request.TimeoutSeconds < 0 || *request.TimeoutSeconds > maxTaskTimeoutSeconds {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("timeout_seconds must be between 0 (no limit) and %d", maxTaskTimeoutSeconds))
			return
		}
	}
	if request.Name != nil {
		name := strings.TrimSpace(*request.Name)
		if name == "" {
			writeErr(w, http.StatusBadRequest, "task name cannot be empty")
			return
		}
		if utf8.RuneCountInString(name) > maxTaskNameRunes {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("task name must be at most %d characters", maxTaskNameRunes))
			return
		}
		request.Name = &name
	}
	task, err := s.m.UpdateTaskMetadata(taskID, db.TaskPatch{Name: request.Name, Pinned: request.Pinned, PlanQuietMode: request.PlanQuietMode, TimeoutSeconds: request.TimeoutSeconds})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if task == nil {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	if request.TimeoutSeconds != nil {
		// The row (and the task's in-memory lifecycle) already carry the new budget;
		// the engine caches the absolute deadline, so it has to be told to re-read it.
		// This is what makes the change take effect without a restart.
		s.engine.rescheduleDeadline(task)
	}
	writeJSON(w, http.StatusOK, taskDTO(task, s.resolvedTaskStatus(task)))
}
