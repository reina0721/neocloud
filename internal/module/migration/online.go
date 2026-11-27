package migration

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/reina0721/neocloud/pkg/database"
	dbmigrate "github.com/reina0721/neocloud/pkg/database/migrate"
)

// OnlinePlan 描述已由宿主验证的签名升级计划在一个数据库方言中的迁移顺序。
type OnlinePlan struct {
	Driver database.Driver `json:"driver"`
	Steps  []OnlineStep    `json:"steps"`
}

// OnlineStep 将确切的源/目标 schema 版本与候选嵌入的一个加法变更绑定。
type OnlineStep struct {
	ModuleID  string                    `json:"moduleId"`
	From      uint                      `json:"from"`
	To        uint                      `json:"to"`
	SHA256    string                    `json:"sha256"`
	Operation dbmigrate.OnlineOperation `json:"operation"`
}

var onlineStepDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Validate 校验签名数据的结构和单模块连续性；批准签名和执行身份仍由宿主负责。
func (p OnlinePlan) Validate() error {
	switch p.Driver {
	case database.DriverSQLite, database.DriverPostgres, database.DriverMySQL:
	default:
		return fmt.Errorf("在线迁移计划数据库类型无效")
	}
	if len(p.Steps) > 128 {
		return fmt.Errorf("在线迁移计划步骤过多")
	}
	last := make(map[string]uint, len(p.Steps))
	for _, step := range p.Steps {
		if step.ModuleID == "" || step.From == 0 || step.To <= step.From || step.To > 1_000_000_000 || !onlineStepDigest.MatchString(step.SHA256) {
			return fmt.Errorf("在线迁移步骤身份、版本或摘要无效")
		}
		if version, ok := last[step.ModuleID]; ok && version != step.From {
			return fmt.Errorf("在线迁移模块 %q 步骤不连续", step.ModuleID)
		}
		if _, err := dbmigrate.OnlineSQL(p.Driver, step.Operation); err != nil {
			return fmt.Errorf("检查在线迁移模块 %q: %w", step.ModuleID, err)
		}
		last[step.ModuleID] = step.To
	}
	return nil
}

// CompatibleWithOnlinePlan 只允许当前程序作为旧版，在签名计划已批准的前缀上启动。
func (s *Service) CompatibleWithOnlinePlan(ctx context.Context, plan OnlinePlan) error {
	_, err := s.inspectOnline(ctx, plan, false)
	return err
}

// CheckOnlineCandidate 只读检查候选的内嵌迁移与当前数据库前缀，允许旧版仍在服务。
func (s *Service) CheckOnlineCandidate(ctx context.Context, plan OnlinePlan) error {
	_, err := s.inspectOnline(ctx, plan, true)
	return err
}

// CheckOnlineBaseline 只读检查托管实例确切匹配当前程序。
func (s *Service) CheckOnlineBaseline(ctx context.Context) error {
	_, err := s.inspectOnline(ctx, OnlinePlan{Driver: s.database.Driver}, true)
	return err
}

// UpSerialized 为应用 CLI 的显式离线迁移持有与在线迁移一致的锁。
func (s *Service) UpSerialized(ctx context.Context) (Status, error) {
	return s.withTimeout(ctx, func(operationCtx context.Context) (Status, error) {
		if err := s.preflight(operationCtx, s.database, s.catalog); err != nil {
			return Status{}, err
		}
		var status Status
		err := dbmigrate.WithMigrationLock(operationCtx, s.database, func() (err error) {
			status, err = s.Up(operationCtx)
			return err
		})
		return status, err
	})
}

// ApplyOnline 按签名顺序继续下一合法步骤。已经提交的安全扩展不会逆转。
func (s *Service) ApplyOnline(ctx context.Context, plan OnlinePlan) (resultErr error) {
	if ctx == nil {
		return fmt.Errorf("在线迁移 context 无效")
	}
	ctx, cancel := context.WithTimeout(ctx, s.config.OperationTimeout)
	defer cancel()
	start, err := s.inspectOnline(ctx, plan, true)
	if err != nil || start == len(plan.Steps) {
		return err
	}
	session, err := dbmigrate.OpenOnlineSession(ctx, s.database)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, session.Close()) }()
	start, err = s.inspectOnline(ctx, plan, true)
	if err != nil {
		return err
	}
	byID := make(map[string]Registration, len(s.catalog.registrations))
	for _, registration := range s.catalog.registrations {
		byID[string(registration.ModuleID)] = registration
	}
	for _, step := range plan.Steps[start:] {
		set := byID[step.ModuleID].Set
		if err := session.ApplyStep(ctx, set, step.From, step.To, step.SHA256, step.Operation); err != nil {
			return fmt.Errorf("在线迁移模块 %q 至版本 %d: %w", step.ModuleID, step.To, err)
		}
	}
	return s.CheckOnlineBaseline(ctx)
}

func (s *Service) inspectOnline(ctx context.Context, plan OnlinePlan, candidate bool) (int, error) {
	if ctx == nil {
		return 0, fmt.Errorf("在线迁移 context 无效")
	}
	ctx, cancel := context.WithTimeout(ctx, s.config.OperationTimeout)
	defer cancel()
	if err := plan.Validate(); err != nil {
		return 0, err
	}
	if plan.Driver != s.database.Driver {
		return 0, fmt.Errorf("在线迁移计划数据库类型与实例不同")
	}
	byID := make(map[string]Registration, len(s.catalog.registrations))
	protected := map[string]bool{"schema_migrations": true}
	var retired []string
	for _, registration := range s.catalog.registrations {
		byID[string(registration.ModuleID)] = registration
		protected[registration.Set.MigrationsTable] = true
		for _, table := range registration.RetiredTables {
			protected[table] = true
			retired = append(retired, table)
		}
	}
	first, last := make(map[string]uint), make(map[string]uint)
	for _, step := range plan.Steps {
		registration, exists := byID[step.ModuleID]
		if !exists || registration.Completion != nil || protected[step.Operation.Table] {
			return 0, fmt.Errorf("在线迁移步骤涉及不允许的模块或表")
		}
		if _, exists := first[step.ModuleID]; !exists {
			first[step.ModuleID] = step.From
		}
		last[step.ModuleID] = step.To
		if candidate {
			if err := dbmigrate.VerifyOnlineStep(plan.Driver, registration.Set, step.From, step.To, step.SHA256, step.Operation); err != nil {
				return 0, fmt.Errorf("校验模块 %q 的候选迁移: %w", step.ModuleID, err)
			}
		}
	}
	if len(retired) > 0 {
		presence, err := dbmigrate.ReadOnlineTablePresence(ctx, s.database, retired)
		if err != nil {
			return 0, err
		}
		for _, table := range retired {
			if presence[table] {
				return 0, ErrPreReleaseBaselineResetRequired
			}
		}
	}
	expected := make(map[string]uint, len(byID))
	actual := make(map[string]uint, len(byID))
	for _, registration := range s.catalog.registrations {
		id := string(registration.ModuleID)
		compiled := registration.Set.CurrentVersion
		expected[id] = compiled
		if from, exists := first[id]; exists {
			if (!candidate && compiled != from) || (candidate && compiled != last[id]) {
				return 0, fmt.Errorf("在线迁移计划与模块 %q 的构建版本不同", id)
			}
			expected[id] = from
		}
		status, err := dbmigrate.ReadOnlineStatus(ctx, s.database, registration.Set)
		if err != nil {
			return 0, fmt.Errorf("读取模块 %q 的在线状态: %w", id, err)
		}
		if status.Empty || status.Dirty {
			return 0, fmt.Errorf("模块 %q 迁移状态无效: %w", id, dbmigrate.ErrOnlineState)
		}
		if registration.Completion != nil && status.Version == compiled {
			if err := registration.Completion.Verify(ctx); err != nil {
				return 0, fmt.Errorf("检查模块 %q 迁移完成: %w", id, err)
			}
		}
		actual[id] = status.Version
	}
	if versionsMatch(expected, actual) {
		return 0, nil
	}
	for index, step := range plan.Steps {
		expected[step.ModuleID] = step.To
		if versionsMatch(expected, actual) {
			return index + 1, nil
		}
	}
	return 0, dbmigrate.ErrOnlineState
}

func versionsMatch(expected, actual map[string]uint) bool {
	for id, version := range expected {
		if actual[id] != version {
			return false
		}
	}
	return true
}
