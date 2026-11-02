package server

import (
	"log"
	"time"
)

// Post-task traffic pruning.
//
// Recorded traffic is stored per host, not per task (the index has no task column),
// so "delete this task's traffic" can only be expressed as "delete the hosts this task
// touched". That is only safe when the task left nothing to reference: if any of its
// findings has a traffic binding, every byte of that host's log may be evidence, so we
// keep it and let the normal retention handle it.
//
// Runs on a timer instead of a status-change hook: the writer, the archive path and the
// manual delete path would all need the same call, and a finished task cannot produce
// new traffic anyway. A grace period covers a reporter that is still writing its report
// (binding happens at the very end of that run).

const (
	trafficPruneInterval = 10 * time.Minute
	trafficPruneGrace    = 15 * time.Minute
)

func (s *Server) trafficPruneLoop() {
	// Once at boot so a restart cleans up whatever the previous process left behind.
	s.pruneFinishedTaskTraffic()
	ticker := time.NewTicker(trafficPruneInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.pruneFinishedTaskTraffic()
		}
	}
}

type pruneCandidate struct {
	id   int64
	name string
}

// pruneFinishedTaskTraffic removes recorded exchanges for tasks that are finished, have
// no bound traffic, and have been quiet for the grace period.
func (s *Server) pruneFinishedTaskTraffic() {
	if s.m.traffic == nil || !s.m.TrafficEnabled() {
		return
	}
	rows, err := s.m.pg.Query(`
		SELECT t.id, COALESCE(t.name,'')
		FROM tasks t
		WHERE t.deleted_at IS NULL
		  AND t.status IN ('done','failed','timeout')
		  AND t.completed_at IS NOT NULL
		  AND t.completed_at < now() - $1::interval
		  AND NOT EXISTS (SELECT 1 FROM finding_traffic_bindings b
		                  JOIN findings f ON f.id = b.finding_id
		                  WHERE f.task_id = t.id)
		ORDER BY t.completed_at ASC
		LIMIT 5`, trafficPruneGrace.String())
	if err != nil {
		log.Printf("[traffic-prune] list tasks: %v", err)
		return
	}
	defer rows.Close()

	var candidates []pruneCandidate
	for rows.Next() {
		var c pruneCandidate
		if err := rows.Scan(&c.id, &c.name); err != nil {
			continue
		}
		candidates = append(candidates, c)
	}
	if len(candidates) == 0 {
		return
	}

	for _, c := range candidates {
		hosts, err := s.taskTrafficHosts(c.id)
		if err != nil || len(hosts) == 0 {
			continue
		}
		deleted, err := s.m.traffic.DeleteHostsExact(hosts)
		if err != nil {
			log.Printf("[traffic-prune] task %d delete %d host(s): %v", c.id, len(hosts), err)
			continue
		}
		log.Printf("[traffic-prune] task %d (%s): removed %d exchange(s) across %d host(s); no finding referenced them",
			c.id, c.name, deleted, len(hosts))
	}
}

// taskTrafficHosts lists the concrete hostnames a task worked on. Sub-domains, not root
// domains: the recorder keys exchanges by the exact host that was contacted.
func (s *Server) taskTrafficHosts(taskID int64) ([]string, error) {
	rows, err := s.m.pg.Query(`
		SELECT DISTINCT lower(a.domain)
		FROM assets a
		JOIN task_asset_links l ON l.asset_id = a.id
		WHERE l.task_id = $1
		  AND a.domain IS NOT NULL AND a.domain <> ''
		  AND a.type IN ('subdomain','service','root_domain')`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hosts []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err == nil && h != "" {
			hosts = append(hosts, h)
		}
	}
	return hosts, rows.Err()
}
