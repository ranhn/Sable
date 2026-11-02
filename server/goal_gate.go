package server

import (
	"errors"
	"regexp"
	"strings"
)

// Ambiguity gate (ouroboros take, #99): a task goal must name a concrete target
// and be long enough to carry a testable objective before any token is spent.
// The live failure this guards against: a benchmark task whose goal named no
// target URL passed creation silently and the planner sent every worker to an
// unrelated asset. A goal that is deliberately target-less (pure analysis over
// provided material) can opt out with the literal marker [targetless].
var (
	goalMinLen = 80

	goalTargetlessRE = regexp.MustCompile(`\[targetless\]`)
	goalURLRE        = regexp.MustCompile(`(?i)\bhttps?://\S+`)
	goalDomainRE     = regexp.MustCompile(`(?i)\b[a-z0-9][a-z0-9-]{1,61}\.[a-z]{2,}(:[0-9]+)?(/\S*)?\b`)
	goalIPv4RE       = regexp.MustCompile(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b`)
	goalLocalhostRE  = regexp.MustCompile(`(?i)\blocalhost:[0-9]+\b`)
	goalPathRE       = regexp.MustCompile(`(?i)(^|\s)/[a-z0-9_-]+(/[a-z0-9_.-]+)+`)
)

// goalGateCheck returns a descriptive error when the goal is too ambiguous to
// dispatch workers against. Order: explicit opt-out, length floor, structured
// target (linked company scope / source tasks), literal target presence.
//
// hasTargets means the caller already pinned the assets through structured fields
// (company_ids / source_task_ids). Without it, a task that links a company scope was
// still rejected for "naming no target" whenever the goal text omitted a URL — the
// only way out was the [targetless] marker, which then told the planner the opposite
// of the truth.
func goalGateCheck(goal string, hasTargets bool) error {
	g := strings.TrimSpace(goal)
	if goalTargetlessRE.MatchString(g) {
		return nil
	}
	if len(g) < goalMinLen {
		// len() counts bytes, so the floor is ~27 Chinese characters; the message says
		// so instead of pretending it is 80 characters of any script.
		return errors.New("目标太短（至少 80 个字符，中文约 27 字）：请写明测试目标以及「什么算成功」；仅当任务确实没有测试对象（纯资料分析）时才加标记 [targetless]")
	}
	if hasTargets {
		return nil
	}
	if goalURLRE.MatchString(g) || goalDomainRE.MatchString(g) ||
		goalIPv4RE.MatchString(g) || goalLocalhostRE.MatchString(g) || goalPathRE.MatchString(g) {
		return nil
	}
	return errors.New("目标里没有指明测试对象：请写上被判定的 URL/主机/IP/路径，或通过「关联企业资产范围」「关联任务」选定目标；确实没有测试对象（纯资料分析）时请加标记 [targetless]")
}
