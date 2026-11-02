package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Chat admission queue.
//
// The console posts a message to /controls/inputs and the backend decides whether to
// run it immediately or park it: a chat session can only run one turn at a time, and
// the UI offers queue / steer / reorder. The queue therefore has to outlive the HTTP
// request and survive a restart, which is why it lives in PostgreSQL.
//
// A queue belongs to a *scope*: either one conversation (the standalone chat page) or
// one task main-agent segment (the chat inside a task). Both share this table; the
// scope_key string keeps the queries identical and the ON CONFLICT targets simple.

// Chat input status values.
const (
	ChatInputQueued      = "queued"      // waiting for its turn
	ChatInputClaimed     = "claimed"     // a runner took it and is about to execute
	ChatInputDelivered   = "delivered"   // handed to the agent
	ChatInputCompleted   = "completed"   // the turn finished
	ChatInputFailed      = "failed"      // the turn ended with an error
	ChatInputCancelled   = "cancelled"   // removed or superseded before running
	ChatInputUndelivered = "undelivered" // claimed but the runner died before delivery
)

// ChatScope identifies one chat session: a conversation, or a task main-agent segment.
type ChatScope struct {
	Key            string // "conv:25" or "task:10:0"
	ConversationID int64  // 0 for task scopes
	TaskID         int64  // 0 for conversation scopes
	MainSeg        int    // task main-agent segment
}

func ConversationChatScope(conversationID int64) ChatScope {
	return ChatScope{Key: fmt.Sprintf("conv:%d", conversationID), ConversationID: conversationID}
}

func TaskChatScope(taskID int64, mainSeg int) ChatScope {
	return ChatScope{Key: fmt.Sprintf("task:%d:%d", taskID, mainSeg), TaskID: taskID, MainSeg: mainSeg}
}

// ParseChatScope rebuilds a scope from a scope_key produced above.
func ParseChatScope(key string) (ChatScope, bool) {
	var s ChatScope
	var id int64
	var seg int
	if n, err := fmt.Sscanf(key, "conv:%d", &id); err == nil && n == 1 {
		return ConversationChatScope(id), true
	}
	if n, err := fmt.Sscanf(key, "task:%d:%d", &id, &seg); err == nil && n == 2 {
		return TaskChatScope(id, seg), true
	}
	return s, false
}

// ChatInput is one accepted message plus its queue state.
type ChatInput struct {
	ID              string
	ScopeKey        string
	ConversationID  int64
	TaskID          int64
	MainSeg         int
	ClientRequestID string
	Kind            string // turn | steer
	TargetRunID     string
	Status          string
	Message         string
	Attachments     json.RawMessage
	Ordinal         int64
	Revision        int64
	Error           string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// ChatControl is the per-scope cursor the UI polls. revision is monotonic and bumps on
// every accepted mutation, which lets the client detect a stale draft.
type ChatControl struct {
	ScopeKey        string
	Revision        int64
	Paused          bool
	LatestRunID     string
	LatestRunStatus string
	UpdatedAt       time.Time
}

func (d *DB) EnsureChatControl(scope ChatScope) (*ChatControl, error) {
	var conv any
	if scope.ConversationID > 0 {
		conv = scope.ConversationID
	}
	if _, err := d.Exec(`INSERT INTO chat_control(scope_key, conversation_id, task_id, main_seg)
VALUES($1, $2, $3, $4)
ON CONFLICT (scope_key) DO NOTHING`, scope.Key, conv, scope.TaskID, scope.MainSeg); err != nil {
		return nil, err
	}
	return d.GetChatControl(scope)
}

func (d *DB) GetChatControl(scope ChatScope) (*ChatControl, error) {
	var c ChatControl
	err := d.QueryRow(`SELECT scope_key, revision, paused, COALESCE(latest_run_id,''), COALESCE(latest_run_status,''), updated_at
FROM chat_control WHERE scope_key=$1`, scope.Key).
		Scan(&c.ScopeKey, &c.Revision, &c.Paused, &c.LatestRunID, &c.LatestRunStatus, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// BumpChatControl increments revision and optionally flips pause / records the latest
// run. A nil paused leaves the switch untouched.
func (d *DB) BumpChatControl(scope ChatScope, paused *bool, latestRunID, latestStatus string) (*ChatControl, error) {
	var c ChatControl
	err := d.QueryRow(`UPDATE chat_control SET
	revision = revision + 1,
	paused = COALESCE($2, paused),
	latest_run_id = CASE WHEN $3::text <> '' THEN $3 ELSE latest_run_id END,
	latest_run_status = CASE WHEN $4::text <> '' THEN $4 ELSE latest_run_status END,
	updated_at = now()
WHERE scope_key=$1
RETURNING scope_key, revision, paused, COALESCE(latest_run_id,''), COALESCE(latest_run_status,''), updated_at`,
		scope.Key, paused, latestRunID, latestStatus).
		Scan(&c.ScopeKey, &c.Revision, &c.Paused, &c.LatestRunID, &c.LatestRunStatus, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func scanChatInput(sc interface{ Scan(...any) error }) (*ChatInput, error) {
	var in ChatInput
	var att []byte
	var conv sql.NullInt64
	if err := sc.Scan(&in.ID, &in.ScopeKey, &conv, &in.TaskID, &in.MainSeg, &in.ClientRequestID,
		&in.Kind, &in.TargetRunID, &in.Status, &in.Message, &att, &in.Ordinal, &in.Revision, &in.Error,
		&in.CreatedAt, &in.UpdatedAt); err != nil {
		return nil, err
	}
	if conv.Valid {
		in.ConversationID = conv.Int64
	}
	in.Attachments = json.RawMessage(att)
	return &in, nil
}

const chatInputCols = `id, scope_key, conversation_id, task_id, main_seg, COALESCE(client_request_id,''),
 COALESCE(kind,'turn'), COALESCE(target_run_id,''), status, COALESCE(message,''), COALESCE(attachments,'[]'::jsonb),
 ordinal, revision, COALESCE(error,''), created_at, updated_at`

// CreateChatInput appends an input at the tail of the queue. The client_request_id
// makes the call idempotent: a retried POST returns the row that already exists
// instead of queueing the same message twice.
func (d *DB) CreateChatInput(scope ChatScope, id, clientRequestID, kind, targetRunID, message string, attachments json.RawMessage) (*ChatInput, bool, error) {
	if len(attachments) == 0 {
		attachments = json.RawMessage(`[]`)
	}
	var conv any
	if scope.ConversationID > 0 {
		conv = scope.ConversationID
	}
	row := d.QueryRow(`WITH next AS (
    SELECT COALESCE(MAX(ordinal),0)+1 AS ord FROM chat_inputs WHERE scope_key=$2
), ins AS (
    INSERT INTO chat_inputs(id, scope_key, conversation_id, task_id, main_seg, client_request_id, kind, target_run_id, status, message, attachments, ordinal)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10::jsonb, (SELECT ord FROM next))
    ON CONFLICT (scope_key, client_request_id) WHERE client_request_id <> '' DO NOTHING
    RETURNING `+chatInputCols+`
)
SELECT * FROM ins`, id, scope.Key, conv, scope.TaskID, scope.MainSeg, clientRequestID, kind, targetRunID, message, string(attachments))
	in, err := scanChatInput(row)
	if err == nil {
		return in, true, nil
	}
	if err != sql.ErrNoRows {
		return nil, false, err
	}
	// Conflict on client_request_id: return the row that won so the caller sees the
	// same admission for a retried request.
	existing, err := scanChatInput(d.QueryRow(`SELECT `+chatInputCols+` FROM chat_inputs
WHERE scope_key=$1 AND client_request_id=$2`, scope.Key, clientRequestID))
	if err != nil {
		return nil, false, err
	}
	return existing, false, nil
}

// ListChatInputs returns the queue in execution order, newest statuses included so the
// panel can show what just finished.
func (d *DB) ListChatInputs(scope ChatScope, limit int) ([]*ChatInput, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := d.Query(`SELECT `+chatInputCols+` FROM chat_inputs
WHERE scope_key=$1 AND status IN ('queued','claimed','delivered','undelivered','failed')
ORDER BY ordinal ASC LIMIT $2`, scope.Key, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ChatInput
	for rows.Next() {
		in, err := scanChatInput(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, in)
	}
	return out, rows.Err()
}

func (d *DB) GetChatInput(id string) (*ChatInput, error) {
	in, err := scanChatInput(d.QueryRow(`SELECT `+chatInputCols+` FROM chat_inputs WHERE id=$1`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return in, err
}

// ClaimNextChatInput atomically takes the head of the queue. FOR UPDATE SKIP LOCKED
// makes it safe to run several workers without double-dispatch.
func (d *DB) ClaimNextChatInput(scope ChatScope) (*ChatInput, error) {
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	in, err := scanChatInput(tx.QueryRow(`SELECT `+chatInputCols+` FROM chat_inputs
WHERE scope_key=$1 AND status='queued'
ORDER BY ordinal ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, scope.Key))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`UPDATE chat_inputs SET status='claimed', revision=revision+1, updated_at=now() WHERE id=$1`, in.ID); err != nil {
		return nil, err
	}
	in.Status = ChatInputClaimed
	in.Revision++
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return in, nil
}

func (d *DB) SetChatInputStatus(id, status, errMsg string) error {
	_, err := d.Exec(`UPDATE chat_inputs SET status=$2, error=$3, revision=revision+1, updated_at=now() WHERE id=$1`, id, status, errMsg)
	return err
}

// UpdateChatInputMessage rewrites a still-queued input. expected > 0 enforces the
// revision the editor saw, so a stale draft fails instead of clobbering a newer edit.
func (d *DB) UpdateChatInputMessage(id string, expected int64, message string, attachments json.RawMessage) (*ChatInput, error) {
	if len(attachments) == 0 {
		attachments = json.RawMessage(`[]`)
	}
	row := d.QueryRow(`UPDATE chat_inputs SET message=$3, attachments=$4::jsonb, revision=revision+1, updated_at=now()
WHERE id=$1 AND status='queued' AND ($2 <= 0 OR revision=$2)
RETURNING `+chatInputCols, id, expected, message, string(attachments))
	in, err := scanChatInput(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return in, err
}

// DeleteChatInput removes a queued input. Claimed/delivered rows are left alone (they
// are already in the transcript); the caller cancels those through the run instead.
func (d *DB) DeleteChatInput(id string) (bool, error) {
	res, err := d.Exec(`DELETE FROM chat_inputs WHERE id=$1 AND status='queued'`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, err
}

// ReorderChatInputs rewrites ordinals to the given order, then pushes everything that
// was not listed behind the reordered block while preserving its relative order.
func (d *DB) ReorderChatInputs(scope ChatScope, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var maxOrd int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(ordinal),0) FROM chat_inputs WHERE scope_key=$1`, scope.Key).Scan(&maxOrd); err != nil {
		return err
	}
	for i, id := range ids {
		if _, err := tx.Exec(`UPDATE chat_inputs SET ordinal=$2, revision=revision+1, updated_at=now()
WHERE id=$1 AND scope_key=$3 AND status='queued'`, id, int64(i+1), scope.Key); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE chat_inputs SET ordinal = ordinal + $2
WHERE scope_key=$1 AND status='queued' AND ordinal <= $3 AND id <> ALL($4::text[])`,
		scope.Key, int64(len(ids)), maxOrd, ids); err != nil {
		return err
	}
	return tx.Commit()
}

// FailInterruptedChatInputs marks inputs that a previous process claimed but never
// delivered, so the panel does not show them as running forever after a restart.
func (d *DB) FailInterruptedChatInputs() (int64, error) {
	res, err := d.Exec(`UPDATE chat_inputs SET status='undelivered', error='server restarted before delivery', revision=revision+1, updated_at=now()
WHERE status='claimed'`)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ScopesWithQueuedInputs lists chat scopes that have work waiting, so the dispatcher can
// skip the idle ones.
func (d *DB) ScopesWithQueuedInputs() ([]ChatScope, error) {
	rows, err := d.Query(`SELECT DISTINCT scope_key FROM chat_inputs WHERE status='queued'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatScope
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		if scope, ok := ParseChatScope(key); ok {
			out = append(out, scope)
		}
	}
	return out, rows.Err()
}

// DeleteChatInputsForConversation clears a conversation's queue (task deletion and the
// conversation delete path both rely on ON DELETE CASCADE, this is for in-place resets).
func (d *DB) DeleteChatInputsForScope(scope ChatScope) error {
	_, err := d.Exec(`DELETE FROM chat_inputs WHERE scope_key=$1`, scope.Key)
	return err
}
