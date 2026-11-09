package evidence

import (
	"context"
	"log"
	"regexp"
	"strings"

	"github.com/Autumn-27/artex/db"
)

// autoBindLimit caps how many exchanges get attached automatically. A report usually
// needs the request that proved the issue plus one or two baselines, not the whole log.
const autoBindLimit = 5

var urlHostRe = regexp.MustCompile(`https?://([a-zA-Z0-9][a-zA-Z0-9._\-]*)`)

// autoRefs picks traffic for a finding that was filed without explicit refs.
//
// The agent is told traffic binding is optional, so in practice most findings arrive
// with an empty refs slice and the capture log never gets referenced. Rather than
// leave every finding evidence-less, fall back to the hosts the finding touches:
// its linked assets first, then any URL that appears in the evidence text. Only
// exchanges captured for exactly those hosts are considered, and the note says the
// match was automatic so a reviewer knows it was not hand-picked.
func (s *Store) autoRefs(ctx context.Context, in db.RecordFindingInput) []db.TrafficRef {
	if s.Traffic == nil || len(in.AssetIDs) == 0 && strings.TrimSpace(in.Evidence) == "" {
		return nil
	}

	hosts := map[string]struct{}{}

	// 1. hosts of the assets the finding claims to be about
	if len(in.AssetIDs) > 0 {
		rows, err := s.DB.Query(`
			SELECT DISTINCT lower(domain) FROM assets
			WHERE id = ANY($1) AND domain IS NOT NULL AND domain <> ''`, in.AssetIDs)
		if err == nil {
			for rows.Next() {
				var h string
				if rows.Scan(&h) == nil && h != "" {
					hosts[h] = struct{}{}
				}
			}
			rows.Close()
		}
	}

	// 2. hosts mentioned in the evidence body (workers paste the PoC URL there)
	for _, m := range urlHostRe.FindAllStringSubmatch(in.Evidence, -1) {
		if len(m) > 1 {
			hosts[strings.ToLower(m[1])] = struct{}{}
		}
	}

	if len(hosts) == 0 {
		return nil
	}

	var refs []db.TrafficRef
	for h := range hosts {
		metas, err := s.Traffic.Search(h, 0, autoBindLimit)
		if err != nil {
			continue
		}
		for _, m := range metas {
			// A 404 from a path brute-force or a 301 redirect carries no evidence;
			// attaching it makes the report look padded. Only a 200 with a body is
			// worth binding automatically - anything else the agent must choose by hand.
			if m.Status != 200 || m.RespLen <= 0 {
				continue
			}
			refs = append(refs, db.TrafficRef{
				TrafficID: m.ID,
				Role:      "proof",
				Note:      "auto-matched: same host, HTTP 200 with a response body",
			})
			if len(refs) >= autoBindLimit {
				return refs
			}
		}
	}
	return refs
}

// autoBind is called from Record when the caller supplied no refs.
func (s *Store) autoBind(ctx context.Context, in db.RecordFindingInput) []db.TrafficRef {
	refs := s.autoRefs(ctx, in)
	if len(refs) > 0 {
		log.Printf("[evidence] finding on %s auto-bound %d exchange(s)", firstHost(in), len(refs))
	}
	return refs
}

func firstHost(in db.RecordFindingInput) string {
	for _, m := range urlHostRe.FindAllStringSubmatch(in.Evidence, -1) {
		if len(m) > 1 {
			return m[1]
		}
	}
	return "(evidence hosts)"
}
