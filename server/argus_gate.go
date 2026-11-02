package server

import (
	"strconv"
	"strings"
	"time"

	pgdb "github.com/Autumn-27/artex/db"
	"github.com/Autumn-27/artex/internal/gate"
	"github.com/Autumn-27/artex/internal/scope"
)

// taskScopeRules 把 ARTEX 的 task_scope 行翻译成 ARGUS 的范围规则。
//
// 映射关系：
//
//	root_domain → domain_suffix （含所有子域）
//	subdomain   → exact_domain  （只这一个主机）
//	ip          → exact_ip
//	cidr        → cidr
//
// company / icp / keyword 是"资产归类"而不是可直接判定的主机边界，这里不展开
// （展开需要额外的资产表联查，留到后续步骤）。
func taskScopeRules(rows []pgdb.TaskScope) []scope.Rule {
	out := make([]scope.Rule, 0, len(rows))
	for _, r := range rows {
		switch strings.ToLower(strings.TrimSpace(r.Kind)) {
		case "root_domain":
			if d := strings.TrimSpace(r.Domain); d != "" {
				out = append(out, scope.Rule{Kind: scope.KindDomainSuffix, Value: d})
			}
		case "subdomain":
			if d := strings.TrimSpace(r.Domain); d != "" {
				out = append(out, scope.Rule{Kind: scope.KindExactDomain, Value: d})
			}
		case "ip":
			if v := firstNonEmpty(r.Value, r.Net, r.Domain); v != "" {
				out = append(out, scope.Rule{Kind: scope.KindExactIP, Value: v})
			}
		case "cidr":
			if n := firstNonEmpty(r.Net, r.Value); n != "" {
				out = append(out, scope.Rule{Kind: scope.KindCIDR, Value: n})
			}
		}
	}
	return out
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// newArgusGate 构造按需刷新的范围闸门（30s 重新读一次 task_scope）。
func newArgusGate(as *pgdb.AssetStore, taskID int64) *gate.DynamicGate {
	return &gate.DynamicGate{
		TaskID: taskID,
		TTL:    30 * time.Second,
		Build: func() (*gate.Gate, error) {
			rows, err := as.ListTaskScope(taskID)
			if err != nil {
				return nil, err
			}
			rules := taskScopeRules(rows)
			if len(rules) == 0 {
				// 范围为空：交由 DynamicGate 按"兼容模式"放行，
				// 不在这里造一个空 Scope（空 Scope 的语义是"全拒"）。
				return nil, nil
			}
			sc, err := scope.New(rules)
			if err != nil {
				return nil, err
			}
			return gate.New(sc, nil, nil), nil
		},
	}
}

// attachArgusGate 给任务绑定范围闸门。创建与加载任务时都会走到这里。
func (m *Manager) attachArgusGate(t *Task) {
	// 暂时停用：exec 层的目标抽取把任何带点号的字符串（servlet.shepherd、
	// app.5802fa4f.js、类名、文件名）当成域名，判定"不在授权范围"后直接 block。
	// 实测三个任务里 Bash 被误拦 792 次、Write 被误拦 373 次，worker 只能换通道
	// 反复重试，token 因此暴涨。范围约束回到只靠任务目标文本 + 企业范围（无护栏），
	// 待抽取器修好（只认显式 URL / host:port）后再启用。
	if true {
		return
	}
	if t == nil || t.Guard == nil || m.assets == nil {
		return
	}
	id, err := strconv.ParseInt(t.ID, 10, 64)
	if err != nil || id <= 0 {
		return
	}
	t.Guard.SetArgusGate(newArgusGate(m.assets, id))
}
