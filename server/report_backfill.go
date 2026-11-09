package server

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// Missing-report backfill.
//
// A finding gets its report from a reporter run that fires after report_finding.
// That run can be lost for reasons outside the agent's control: the backend was
// restarting, the LLM call failed, the process was killed mid-write. The finding then
// sits there with an empty report forever, because nothing ever retries it.
//
// This loop closes that hole: shortly after start-up (and hourly thereafter) it looks
// for findings that are old enough that a normal reporter run would have finished, yet
// still have no report, and fires one more reporter run for each.

const (
	reportBackfillDelay    = 90 * time.Second
	reportBackfillInterval = time.Hour
	// A reporter needs a couple of minutes; only act on findings older than this so a
	// backfill never races the normal trigger.
	reportBackfillMinAge = 10 * time.Minute
	reportBackfillLimit  = 5
)

func (s *Server) reportBackfillLoop() {
	select {
	case <-s.ctx.Done():
		return
	case <-time.After(reportBackfillDelay):
	}
	s.backfillMissingReports()

	ticker := time.NewTicker(reportBackfillInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.backfillMissingReports()
		}
	}
}

// triedOnce keeps the loop from re-firing the same finding every hour when the
// reporter keeps failing for it (for example an agent that cannot read its evidence).
var reportBackfillTried sync.Map

func (s *Server) backfillMissingReports() {
	if s.m.pg == nil || s.chatAgentRef() == nil {
		return
	}
	rows, err := s.m.pg.Query(`
		SELECT f.id, f.node_id, f.task_id, COALESCE(f.name,''), COALESCE(f.vulnclass,'')
		FROM findings f
		WHERE length(COALESCE(f.report,'')) < 500
		  AND f.created_at < now() - $1::interval
		ORDER BY f.created_at ASC
		LIMIT $2`, reportBackfillMinAge.String(), reportBackfillLimit)
	if err != nil {
		log.Printf("[report-backfill] query: %v", err)
		return
	}
	defer rows.Close()

	type target struct {
		id, nodeID, taskID int64
		name, vulnclass    string
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.nodeID, &t.taskID, &t.name, &t.vulnclass); err != nil {
			continue
		}
		if _, seen := reportBackfillTried.Load(t.id); seen {
			continue
		}
		targets = append(targets, t)
	}
	if len(targets) == 0 {
		return
	}

	for _, t := range targets {
		reportBackfillTried.Store(t.id, true)
		// Spell out all three identifiers: the agent previously read the finding id as a
		// task id and called get_task_node_detail(40), which returned "task not found".
		msg := fmt.Sprintf(
			"Backfill: vulnerability #%d has no detailed report — its reporter run was interrupted.\n\n"+
				"Identifiers (do not mix them up):\n"+
				"- task_id          = %d   (use this for get_task_node_detail / get_task_worker_trace)\n"+
				"- finding node id  = %d   (the exploration node holding evidence; same task)\n"+
				"- finding record id= %d   (the standalone finding)\n\n"+
				"Vulnerability: %s / %s.\n\n"+
				"Write the complete report now in the same nine-section Chinese template as any other finding. "+
				"Read the node %d, the stored evidence, and any bound traffic first, then save with "+
				"update_finding_report(finding_id=%d).",
			t.id, t.taskID, t.nodeID, t.id, t.name, t.vulnclass, t.nodeID, t.nodeID)
		s.StartTriggeredRun("reporter",
			fmt.Sprintf("Backfill · finding#%d", t.id), msg, t.taskID, false, "", "")
		log.Printf("[report-backfill] queued reporter run for finding %d (task %d, %d chars of evidence)",
			t.id, t.taskID, len(t.name))
	}
}
