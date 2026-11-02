package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Autumn-27/artex/agent"
	"github.com/Autumn-27/artex/db"
	"github.com/Autumn-27/artex/intercept"
	"github.com/google/uuid"
)

// Chat admission controls.
//
// The console does not POST messages directly any more: it posts an *input* to
// /controls/inputs and polls /controls for the queue state. That is what makes queueing,
// steering, reordering and pausing possible — a plain message endpoint can only accept
// or reject.
//
// Two kinds of chat session share the same implementation:
//   - a conversation (/api/conversations/{id}/controls…), executed by runConversationSync
//   - a task's main-agent segment (/api/tasks/{id}/chat/controls?seg=N), executed by the
//     same MainAgent call the legacy POST /api/chat handler makes.
//
// The queue is persisted (db.chat_inputs, keyed by scope) so it survives a restart; a
// claimed row that never delivered is marked undelivered at boot. revision is monotonic
// per scope and bumps on every mutation, so the UI can reject stale drafts.

const chatControlMaxInputs = 50

// chatTarget is one resolved chat session plus everything the handlers need.
type chatTarget struct {
	Scope   db.ChatScope
	Conv    *db.Conversation
	Task    *Task
	BusyKey string
	Session map[string]any
}

func conversationChatTarget(c *db.Conversation) *chatTarget {
	return &chatTarget{
		Scope:   db.ConversationChatScope(c.ID),
		Conv:    c,
		BusyKey: "conv-" + strconv.FormatInt(c.ID, 10),
		Session: map[string]any{
			"conversation_id": strconv.FormatInt(c.ID, 10),
			"task_id":         "0",
			"exploration_id":  "0",
			"main_seg":        0,
		},
	}
}

func taskChatTarget(t *Task, mainSeg int) *chatTarget {
	taskID, _ := strconv.ParseInt(t.ID, 10, 64)
	return &chatTarget{
		Scope:   db.TaskChatScope(taskID, mainSeg),
		Task:    t,
		BusyKey: t.ID,
		Session: map[string]any{
			"conversation_id": "0",
			"task_id":         t.ID,
			"exploration_id":  strconv.FormatInt(t.ExpID, 10),
			"main_seg":        mainSeg,
		},
	}
}

// chatTargetFor resolves {id} to a conversation or a task chat segment, based on which
// route matched (r.Pattern carries the registered template).
func (s *Server) chatTargetFor(w http.ResponseWriter, r *http.Request) (*chatTarget, bool) {
	id := r.PathValue("id")
	if strings.Contains(r.Pattern, "/tasks/") {
		t := s.m.ResolveTask(id)
		if t == nil {
			writeErr(w, http.StatusNotFound, "task not found")
			return nil, false
		}
		seg := 0
		if raw := r.URL.Query().Get("seg"); raw != "" {
			if v, err := strconv.Atoi(raw); err == nil && v >= 0 {
				seg = v
			}
		}
		return taskChatTarget(t, seg), true
	}
	_, c, ok := s.convByID(w, r)
	if !ok {
		return nil, false
	}
	return conversationChatTarget(c), true
}

func (s *Server) chatBusyFor(key string) bool {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	return s.chatBusy[key]
}

func chatAdmissionDTO(in *db.ChatInput, session map[string]any) map[string]any {
	kind := "turn"
	if strings.EqualFold(in.Kind, "steer") {
		kind = "steer"
	}
	attachments := make([]any, 0, 4)
	if len(in.Attachments) > 0 {
		_ = json.Unmarshal(in.Attachments, &attachments)
	}
	return map[string]any{
		"id":                in.ID,
		"client_request_id": in.ClientRequestID,
		"kind":              kind,
		"target_run_id":     in.TargetRunID,
		"status":            in.Status,
		"session":           session,
		"prompt":            map[string]any{"text": in.Message, "attachments": attachments},
		"revision":          strconv.FormatInt(in.Revision, 10),
		"ordinal":           strconv.FormatInt(in.Ordinal, 10),
	}
}

// chatControlSnapshot builds the polled state. It is also the response of every
// mutating call that returns ChatControlState.
func (s *Server) chatControlSnapshot(target *chatTarget) (map[string]any, error) {
	ctl, err := s.m.pg.EnsureChatControl(target.Scope)
	if err != nil {
		return nil, err
	}
	inputs, err := s.m.pg.ListChatInputs(target.Scope, chatControlMaxInputs)
	if err != nil {
		return nil, err
	}
	admissions := make([]any, 0, len(inputs))
	var activeInput string
	for _, in := range inputs {
		admissions = append(admissions, chatAdmissionDTO(in, target.Session))
		if in.Status == db.ChatInputClaimed || in.Status == db.ChatInputDelivered {
			activeInput = in.ID
		}
	}

	running := s.chatBusyFor(target.BusyKey)
	var active any
	if running {
		active = map[string]any{
			"id":                "run-" + activeInput,
			"input_id":          activeInput,
			"turn_id":           activeInput,
			"transcript_id":     target.Scope.Key,
			"start_record_uuid": "",
			"status":            "running",
			"session":           target.Session,
			"history_revision":  strconv.FormatInt(ctl.Revision, 10),
			"prompt":            map[string]any{"text": "", "attachments": []any{}},
		}
	}

	latestStatus := ctl.LatestRunStatus
	if running {
		latestStatus = "running"
	} else if latestStatus == "running" {
		latestStatus = "idle"
	}

	return map[string]any{
		"session":           target.Session,
		"revision":          strconv.FormatInt(ctl.Revision, 10),
		"history_revision":  strconv.FormatInt(ctl.Revision, 10),
		"paused":            ctl.Paused,
		"active":            active,
		"inputs":            admissions,
		"latest_run_id":     ctl.LatestRunID,
		"latest_run_status": latestStatus,
		"capabilities": map[string]bool{
			"queue":    true,
			"steer":    true,
			"pause":    true,
			"reorder":  true,
			"edit":     true,
			"discard":  true,
			"followup": true,
		},
	}, nil
}

func (s *Server) chatControlsState(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	state, err := s.chatControlSnapshot(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// chatControlsSubmit accepts an input. mode=queue always parks it; send/steer dispatch
// immediately when the session is idle.
func (s *Server) chatControlsSubmit(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	var req struct {
		ClientRequestID string          `json:"client_request_id"`
		Mode            string          `json:"mode"`
		Message         string          `json:"message"`
		Attachments     json.RawMessage `json:"attachments"`
		TargetRunID     string          `json:"target_run_id"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" && len(req.Attachments) == 0 {
		writeErr(w, http.StatusBadRequest, "message cannot be empty")
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "send"
	}
	if mode != "send" && mode != "queue" && mode != "steer" {
		writeErr(w, http.StatusBadRequest, "mode must be send, queue or steer")
		return
	}
	kind := "turn"
	if mode == "steer" {
		kind = "steer"
	}

	if _, err := s.m.pg.EnsureChatControl(target.Scope); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	in, created, err := s.m.pg.CreateChatInput(target.Scope, uuid.NewString(), strings.TrimSpace(req.ClientRequestID),
		kind, strings.TrimSpace(req.TargetRunID), msg, req.Attachments)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, nil, "", ""); err != nil {
		log.Printf("[chat-controls] %s bump failed: %v", target.Scope.Key, err)
	}

	if mode == "steer" {
		// Steering means "stop what you are doing and do this instead".
		s.cancelChatRun(target)
	}
	if mode != "queue" {
		go s.dispatchChatQueue(target)
	}

	if !created {
		// Retried request: the input already exists, return it unchanged.
		w.Header().Set("X-Chat-Admission-Replayed", "1")
	}
	writeJSON(w, http.StatusOK, chatAdmissionDTO(in, target.Session))
}

func (s *Server) chatControlsEdit(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	var req struct {
		ExpectedRevision json.RawMessage `json:"expected_revision"`
		Text             string          `json:"text"`
		Message          string          `json:"message"`
		Attachments      json.RawMessage `json:"attachments"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	text := req.Text
	if strings.TrimSpace(text) == "" {
		text = req.Message
	}
	if strings.TrimSpace(text) == "" {
		writeErr(w, http.StatusBadRequest, "text cannot be empty")
		return
	}
	in, err := s.m.pg.UpdateChatInputMessage(r.PathValue("iid"), expectedRevision(req.ExpectedRevision), strings.TrimSpace(text), req.Attachments)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if in == nil {
		writeErr(w, http.StatusConflict, "input is no longer editable (already running, removed, or edited elsewhere)")
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, nil, "", ""); err != nil {
		log.Printf("[chat-controls] %s bump failed: %v", target.Scope.Key, err)
	}
	writeJSON(w, http.StatusOK, chatAdmissionDTO(in, target.Session))
}

// expectedRevision accepts either a JSON number or a JSON string (the DTO sends strings).
func expectedRevision(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		v, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
		return v
	}
	var n int64
	if json.Unmarshal(raw, &n) == nil {
		return n
	}
	return 0
}

func (s *Server) chatControlsDelete(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	removed, err := s.m.pg.DeleteChatInput(r.PathValue("iid"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !removed {
		writeErr(w, http.StatusConflict, "input already started or was removed")
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, nil, "", ""); err != nil {
		log.Printf("[chat-controls] %s bump failed: %v", target.Scope.Key, err)
	}
	s.writeChatSnapshot(w, target)
}

func (s *Server) chatControlsReorder(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	var req struct {
		IDs              []string        `json:"ids"`
		ExpectedRevision json.RawMessage `json:"expected_revision"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.m.pg.ReorderChatInputs(target.Scope, req.IDs); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, nil, "", ""); err != nil {
		log.Printf("[chat-controls] %s bump failed: %v", target.Scope.Key, err)
	}
	s.writeChatSnapshot(w, target)
}

func (s *Server) chatControlsPause(w http.ResponseWriter, r *http.Request) {
	s.setChatPaused(w, r, true)
}

func (s *Server) chatControlsResume(w http.ResponseWriter, r *http.Request) {
	s.setChatPaused(w, r, false)
}

func (s *Server) setChatPaused(w http.ResponseWriter, r *http.Request, paused bool) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	if _, err := s.m.pg.EnsureChatControl(target.Scope); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, &paused, "", ""); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !paused {
		go s.dispatchChatQueue(target)
	}
	s.writeChatSnapshot(w, target)
}

func (s *Server) writeChatSnapshot(w http.ResponseWriter, target *chatTarget) {
	state, err := s.chatControlSnapshot(target)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// chatControlsFollowup re-queues an input that failed or was never delivered.
func (s *Server) chatControlsFollowup(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	in, err := s.m.pg.GetChatInput(r.PathValue("iid"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if in == nil || in.ScopeKey != target.Scope.Key {
		writeErr(w, http.StatusNotFound, "input not found")
		return
	}
	if in.Status != db.ChatInputFailed && in.Status != db.ChatInputUndelivered {
		writeErr(w, http.StatusConflict, "only failed or undelivered inputs can be re-queued")
		return
	}
	if err := s.m.pg.SetChatInputStatus(in.ID, db.ChatInputQueued, ""); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, nil, "", ""); err != nil {
		log.Printf("[chat-controls] %s bump failed: %v", target.Scope.Key, err)
	}
	go s.dispatchChatQueue(target)
	in.Status = db.ChatInputQueued
	writeJSON(w, http.StatusOK, chatAdmissionDTO(in, target.Session))
}

// chatControlsDiscard drops an input whose delivery state is unknown.
func (s *Server) chatControlsDiscard(w http.ResponseWriter, r *http.Request) {
	target, ok := s.chatTargetFor(w, r)
	if !ok {
		return
	}
	in, err := s.m.pg.GetChatInput(r.PathValue("iid"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if in == nil || in.ScopeKey != target.Scope.Key {
		writeErr(w, http.StatusNotFound, "input not found")
		return
	}
	if err := s.m.pg.SetChatInputStatus(in.ID, db.ChatInputCancelled, "discarded by operator"); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.m.pg.BumpChatControl(target.Scope, nil, "", ""); err != nil {
		log.Printf("[chat-controls] %s bump failed: %v", target.Scope.Key, err)
	}
	s.writeChatSnapshot(w, target)
}

// cancelChatRun aborts the in-flight turn, if any (used by steer).
func (s *Server) cancelChatRun(target *chatTarget) {
	s.chatMu.Lock()
	cancel := s.chatCancel[target.BusyKey]
	s.chatMu.Unlock()
	if cancel != nil {
		cancel(fmt.Errorf("superseded by a steer input"))
		log.Printf("[chat-controls] %s current run cancelled by steer", target.Scope.Key)
	}
}

// dispatchChatQueue starts the head of the queue if the session is idle. Safe to call
// spuriously: it returns immediately when busy, paused or empty.
func (s *Server) dispatchChatQueue(target *chatTarget) {
	if target == nil {
		return
	}
	ctl, err := s.m.pg.GetChatControl(target.Scope)
	if err != nil || ctl == nil || ctl.Paused {
		return
	}
	s.chatMu.Lock()
	if s.chatBusy[target.BusyKey] {
		s.chatMu.Unlock()
		return
	}
	s.chatBusy[target.BusyKey] = true // reserve, so a concurrent caller loses
	s.chatMu.Unlock()

	in, err := s.m.pg.ClaimNextChatInput(target.Scope)
	if err != nil || in == nil {
		s.chatMu.Lock()
		delete(s.chatBusy, target.BusyKey)
		s.chatMu.Unlock()
		return
	}

	if err := s.m.pg.SetChatInputStatus(in.ID, db.ChatInputDelivered, ""); err != nil {
		log.Printf("[chat-controls] %s mark delivered: %v", target.Scope.Key, err)
	}
	_, _ = s.m.pg.BumpChatControl(target.Scope, nil, "input-"+in.ID, "running")

	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[chat-controls] %s run panicked: %v", target.Scope.Key, rec)
				_ = s.m.pg.SetChatInputStatus(in.ID, db.ChatInputFailed, fmt.Sprintf("panic: %v", rec))
				s.chatMu.Lock()
				delete(s.chatBusy, target.BusyKey)
				s.chatMu.Unlock()
			}
			time.Sleep(120 * time.Millisecond)
			go s.dispatchChatQueue(target)
		}()
		if err := s.runChatInputTurn(target, in); err != nil {
			_ = s.m.pg.SetChatInputStatus(in.ID, db.ChatInputFailed, err.Error())
			_, _ = s.m.pg.BumpChatControl(target.Scope, nil, "input-"+in.ID, "failed")
			return
		}
		_ = s.m.pg.SetChatInputStatus(in.ID, db.ChatInputCompleted, "")
		_, _ = s.m.pg.BumpChatControl(target.Scope, nil, "input-"+in.ID, "idle")
	}()
}

// runChatInputTurn executes one queued input and blocks until the turn ends.
func (s *Server) runChatInputTurn(target *chatTarget, in *db.ChatInput) error {
	attachments := decodeChatAttachments(in.Attachments)
	if target.Task != nil {
		return s.runTaskChatInput(target.Task, target.Scope.MainSeg, in.Message, attachments)
	}
	if target.Conv == nil {
		return fmt.Errorf("chat scope %s no longer exists", target.Scope.Key)
	}
	c := target.Conv
	ua := userActivityWithAttachments(c.AgentKey, in.Message, attachments)
	ua.Summary = firstLine(in.Message, 200)
	if ua.Detail == "" {
		ua.Detail = in.Message
	}
	if _, err := s.m.pg.AppendConvActivity(c.ID, ua); err != nil {
		log.Printf("[chat-controls] conv %d append user msg failed: %v", c.ID, err)
	}
	if c.Title == "" || c.Title == "New conversation" {
		title := firstLine(in.Message, 40)
		if title == "" {
			title = "Message with attachments"
		}
		_ = s.m.pg.RenameConversation(c.ID, title)
	}
	_ = s.m.pg.TouchConversation(c.ID)
	baseDir := filepath.Join(s.m.dir, "sessions", target.BusyKey)
	// runConversationSync keeps the busy marker we reserved and clears it on exit.
	s.runConversationSync(c, composeAgentMessage(in.Message, attachments, baseDir), target.BusyKey)
	return nil
}

// runTaskChatInput mirrors the execution half of the legacy POST /api/chat handler, but
// blocks until the turn finishes so the queue can advance.
func (s *Server) runTaskChatInput(t *Task, mainSeg int, message string, attachments []chatAttachment) error {
	if s.engine.IsDeleting(t.ID) {
		s.chatMu.Lock()
		delete(s.chatBusy, t.ID)
		s.chatMu.Unlock()
		return fmt.Errorf("task is being deleted")
	}
	ctx, cancel := s.conversationRunContextForTask(t.ID)
	seg := mainSeg
	segPtr := &seg

	humanTurn := userActivityWithAttachments("mainagent", message, attachments)
	humanTurn.MainSeg = segPtr
	s.engine.emitActivity(t, humanTurn)

	ma := (*agent.MainAgent)(nil)
	if s.taskRuntimeAvailable(t, "mainagent") {
		ma = s.agentsForTask(t).main
	}
	if ma == nil {
		reply := s.fallbackChat(t, message)
		s.engine.emitActivity(t, db.Activity{Worker: "mainagent", Kind: "text", Summary: reply, MainSeg: segPtr})
		s.finishTaskChat(t.ID, cancel)
		return nil
	}
	emit := func(rec db.Activity) {
		rec.MainSeg = segPtr
		s.engine.emitActivity(t, rec)
	}
	maTaskID, _ := strconv.ParseInt(t.ID, 10, 64)
	resume := func() { s.reviveTask(t) }
	taskDir := filepath.Join(s.m.dir, "tasks", t.ID)
	agentMsg := composeAgentMessage(message, attachments, taskDir)
	s.engine.BeginLLMCall(t.ID)
	_, err := ma.Chat(ctx, maTaskID, seg, s.m.Assets(), t.Store, t.Goal, agentMsg, emit, t.Notify, resume, t.NotifyGoal, t.NotifyHint)
	s.engine.EndLLMCall(t.ID)
	if err != nil && ctx.Err() == nil {
		s.engine.emitActivity(t, db.Activity{Worker: "mainagent", Kind: "text", IsError: true,
			Summary: "(main agent error: " + err.Error() + ")", MainSeg: segPtr})
	}
	s.finishTaskChat(t.ID, cancel)
	return err
}

// conversationRunContextForTask installs the cancel func for a task chat turn (the
// legacy handler builds it inline; the queue path needs the same registration, or a
// manual stop cannot reach a queued turn).
func (s *Server) conversationRunContextForTask(taskID string) (context.Context, context.CancelCauseFunc) {
	ctx, cancel := context.WithCancelCause(intercept.WithReviewContext(s.ctx, "",
		intercept.ReviewBackground{Source: intercept.BackgroundUserMessage}))
	s.chatMu.Lock()
	s.chatCancel[taskID] = cancel
	s.chatMu.Unlock()
	return ctx, cancel
}

func decodeChatAttachments(raw json.RawMessage) []chatAttachment {
	if len(raw) == 0 {
		return nil
	}
	var out []chatAttachment
	_ = json.Unmarshal(raw, &out)
	return out
}

// chatQueueLoop drains queues that were persisted by a previous process or left behind
// by a crash.
func (s *Server) chatQueueLoop() {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			scopes, err := s.m.pg.ScopesWithQueuedInputs()
			if err != nil || len(scopes) == 0 {
				continue
			}
			for _, scope := range scopes {
				target, ok := s.chatTargetForScope(scope)
				if !ok {
					continue
				}
				s.dispatchChatQueue(target)
			}
		}
	}
}

// chatTargetForScope rebuilds a target from a persisted scope key (queue drainer).
func (s *Server) chatTargetForScope(scope db.ChatScope) (*chatTarget, bool) {
	if scope.ConversationID > 0 {
		c, err := s.m.pg.GetConversation(scope.ConversationID)
		if err != nil || c == nil {
			return nil, false
		}
		return conversationChatTarget(c), true
	}
	if scope.TaskID > 0 {
		t := s.m.ResolveTask(strconv.FormatInt(scope.TaskID, 10))
		if t == nil {
			return nil, false
		}
		return taskChatTarget(t, scope.MainSeg), true
	}
	return nil, false
}
