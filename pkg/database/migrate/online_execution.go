package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/gofrs/flock"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/reina0721/clouddrive/pkg/database"
)

const (
	onlineStepTimeout = 3 * time.Second
	onlineSchemaLock  = "clouddrive/online-migration/1"
)

// OnlineSession 持有一次数据库迁移的锁和固定连接，不复用业务连接池。
type OnlineSession struct {
	driver database.Driver
	db     *sql.DB
	conn   *sql.Conn
	lock   *flock.Flock
}

// OpenOnlineSession 在业务持续服务期间获取独立、不可并行的迁移权。
func OpenOnlineSession(ctx context.Context, cfg database.Config) (*OnlineSession, error) {
	return openMigrationSession(ctx, cfg, true)
}

// WithMigrationLock 保证普通迁移不会越过原生在线升级的数据库迁移锁。
func WithMigrationLock(ctx context.Context, cfg database.Config, run func() error) (resultErr error) {
	if cfg.Driver == database.DriverSQLite && (cfg.DSN == ":memory:" || strings.HasPrefix(cfg.DSN, "file::memory:")) {
		return run()
	}
	s, err := openMigrationSession(ctx, cfg, false)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, s.Close()) }()
	if cfg.Driver == database.DriverMySQL {
		present, err := migrationTableExists(ctx, s.conn, cfg.Driver, "clouddrive_online_migration_steps")
		if err != nil {
			return onlineDatabaseError(ctx, "检查在线迁移步骤记录", err)
		}
		if present {
			var pending bool
			if err := s.conn.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM clouddrive_online_migration_steps WHERE completed = FALSE)").Scan(&pending); err != nil {
				return onlineDatabaseError(ctx, "检查未完成的在线迁移", err)
			}
			if pending {
				return fmt.Errorf("需要先重试已签名的 MySQL 在线升级以协调实际结构: %w", ErrOnlineState)
			}
		}
	}
	return run()
}

func openMigrationSession(ctx context.Context, cfg database.Config, online bool) (result *OnlineSession, resultErr error) {
	if ctx == nil {
		return nil, fmt.Errorf("在线迁移 context 无效")
	}
	setup, cancel := context.WithTimeout(ctx, onlineStepTimeout)
	defer cancel()
	db, path, err := openOnlineDatabase(cfg, false)
	if err != nil {
		return nil, err
	}
	s := &OnlineSession{driver: cfg.Driver, db: db}
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, s.Close())
		}
	}()
	if cfg.Driver == database.DriverSQLite {
		s.lock = flock.New(path + ".online-migration.lock")
		locked, err := s.lock.TryLock()
		if err != nil {
			return nil, onlineDatabaseError(setup, "获取 SQLite 迁移锁", err)
		}
		if !locked {
			return nil, ErrOnlineBusy
		}
	}
	s.conn, err = db.Conn(setup)
	if err != nil {
		return nil, onlineDatabaseError(setup, "打开迁移连接", err)
	}
	if err := s.lockDatabase(setup, online); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *OnlineSession) lockDatabase(ctx context.Context, online bool) error {
	switch s.driver {
	case database.DriverSQLite:
		if !online {
			return nil
		}
		var journal string
		if err := s.conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal); err != nil {
			return onlineDatabaseError(ctx, "检查 SQLite 日志模式", err)
		}
		if journal != "wal" {
			return fmt.Errorf("在线 SQLite 迁移要求实例已经启用 WAL")
		}
	case database.DriverPostgres:
		if online {
			var version int
			if err := s.conn.QueryRowContext(ctx, "SELECT current_setting('server_version_num')::integer").Scan(&version); err != nil {
				return onlineDatabaseError(ctx, "检查 PostgreSQL 在线迁移版本", err)
			}
			if version < 180000 || version >= 190000 {
				return fmt.Errorf("在线迁移需要 PostgreSQL 18")
			}
		}
		var locked bool
		if err := s.conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(hashtextextended(current_database() || current_schema() || $1, 0))", onlineSchemaLock).Scan(&locked); err != nil {
			return onlineDatabaseError(ctx, "获取 PostgreSQL 迁移锁", err)
		}
		if !locked {
			return ErrOnlineBusy
		}
	case database.DriverMySQL:
		if online {
			var version string
			if err := s.conn.QueryRowContext(ctx, "SELECT VERSION()").Scan(&version); err != nil {
				return onlineDatabaseError(ctx, "检查 MySQL 在线迁移版本", err)
			}
			if !strings.HasPrefix(version, "8.4.") || strings.Contains(strings.ToLower(version), "mariadb") {
				return fmt.Errorf("在线迁移需要 MySQL 8.4")
			}
		}
		var locked sql.NullInt64
		if err := s.conn.QueryRowContext(ctx, "SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ?), 256), 0)", onlineSchemaLock).Scan(&locked); err != nil {
			return onlineDatabaseError(ctx, "获取 MySQL 迁移锁", err)
		}
		if !locked.Valid || locked.Int64 != 1 {
			return ErrOnlineBusy
		}
		if _, err := s.conn.ExecContext(ctx, "SET SESSION lock_wait_timeout = 1"); err != nil {
			return onlineDatabaseError(ctx, "设置 MySQL 迁移锁等待预算", err)
		}
	}
	return nil
}

// Close 关闭专用连接池，释放会话锁和本地文件锁。
func (s *OnlineSession) Close() error {
	var err error
	if s.conn != nil {
		err = sanitize(s.conn.Close())
	}
	err = errors.Join(err, sanitize(s.db.Close()))
	if s.lock != nil {
		err = errors.Join(err, sanitize(s.lock.Close()))
	}
	return err
}

// ApplyStep 验证版本与源码后执行单步；SQL 外部不参与生成。
func (s *OnlineSession) ApplyStep(ctx context.Context, set Set, from, to uint, digest string, operation OnlineOperation) error {
	if err := VerifyOnlineStep(s.driver, set, from, to, digest, operation); err != nil {
		return err
	}
	table, err := onlineVersionTable(set)
	if err != nil {
		return err
	}
	if operation.Table == table {
		return fmt.Errorf("在线迁移不得更改迁移版本表结构")
	}
	ddl, err := OnlineSQL(s.driver, operation)
	if err != nil {
		return err
	}
	step, cancel := context.WithTimeout(ctx, onlineStepTimeout)
	defer cancel()
	if s.driver == database.DriverMySQL {
		return s.applyMySQLStep(step, table, from, to, digest, operation, ddl)
	}
	return s.applyTransactionalStep(step, table, from, to, ddl)
}

func (s *OnlineSession) applyTransactionalStep(ctx context.Context, table string, from, to uint, ddl string) error {
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return onlineDatabaseError(ctx, "开始在线迁移事务", err)
	}
	defer func() { _ = tx.Rollback() }()
	if s.driver == database.DriverPostgres {
		if _, err := tx.ExecContext(ctx, "SET LOCAL lock_timeout = '200ms'"); err != nil {
			return onlineDatabaseError(ctx, "设置 PostgreSQL 迁移预算", err)
		}
		if _, err := tx.ExecContext(ctx, "SET LOCAL statement_timeout = '2s'"); err != nil {
			return onlineDatabaseError(ctx, "设置 PostgreSQL 迁移预算", err)
		}
	}
	status, err := readOnlineVersion(ctx, tx, s.driver, table)
	if err != nil {
		return err
	}
	if status.Empty || status.Dirty || status.Version != from {
		return ErrOnlineState
	}
	// #nosec G202 -- ddl 由窄操作契约和受验证的标识符生成，并与嵌入 SQL 对照。
	if _, err := tx.ExecContext(ctx, ddl); err != nil {
		return onlineDatabaseError(ctx, "执行在线迁移 DDL", err)
	}
	if err := updateOnlineVersion(ctx, tx, s.driver, table, from, to); err != nil {
		return err
	}
	return onlineDatabaseError(ctx, "提交在线迁移", tx.Commit())
}

type onlineQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readOnlineVersion(ctx context.Context, conn onlineQueryer, driver database.Driver, table string) (status Status, resultErr error) {
	// #nosec G202 -- table 来自规范化迁移拥有者定义，不等于用户可传入 SQL。
	rows, err := conn.QueryContext(ctx, "SELECT version, dirty FROM "+quotedTable(driver, table)+" LIMIT 2")
	if err != nil {
		return Status{}, onlineDatabaseError(ctx, "读取迁移版本", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, onlineDatabaseError(ctx, "关闭迁移版本读取", rows.Close()))
	}()
	if !rows.Next() {
		return Status{Empty: true}, onlineDatabaseError(ctx, "读取迁移版本", rows.Err())
	}
	if err := rows.Scan(&status.Version, &status.Dirty); err != nil {
		return Status{}, onlineDatabaseError(ctx, "解析迁移版本", err)
	}
	if rows.Next() {
		return Status{}, ErrOnlineState
	}
	return status, onlineDatabaseError(ctx, "读取迁移版本", rows.Err())
}

func updateOnlineVersion(ctx context.Context, tx *sql.Tx, driver database.Driver, table string, from, to uint) error {
	set, expected := "?", "?"
	if driver == database.DriverPostgres {
		set, expected = "$1", "$2"
	}
	// #nosec G202 -- table 已通过 owner schema 校验，其他值作为参数传递。
	changed, err := tx.ExecContext(ctx, "UPDATE "+quotedTable(driver, table)+" SET version = "+set+" WHERE version = "+expected+" AND dirty = FALSE", to, from)
	if err != nil {
		return onlineDatabaseError(ctx, "记录已完成迁移版本", err)
	}
	rows, err := changed.RowsAffected()
	if err != nil {
		return onlineDatabaseError(ctx, "检查迁移版本更新结果", err)
	}
	if rows != 1 {
		return ErrOnlineState
	}
	return nil
}

func onlineVersionTable(set Set) (string, error) {
	name := set.MigrationsTable
	if name == "" {
		name = defaultMigrationTable
	}
	if !onlineName.MatchString(name) {
		return "", fmt.Errorf("迁移版本表名无效")
	}
	return name, nil
}

// ReadOnlineStatus 使用已存在的数据库进行只读查询，避免候选启动创建数据库文件。
func ReadOnlineStatus(ctx context.Context, cfg database.Config, set Set) (Status, error) {
	table, err := onlineVersionTable(set)
	if err != nil {
		return Status{}, err
	}
	db, _, err := openOnlineDatabase(cfg, true)
	if err != nil {
		return Status{}, err
	}
	status, err := readOnlineVersion(ctx, db, cfg.Driver, table)
	return status, errors.Join(err, sanitize(db.Close()))
}

// ReadOnlineTablePresence 不允许 SQLite 在候选探测过程中创建数据库。
func ReadOnlineTablePresence(ctx context.Context, cfg database.Config, tables []string) (result map[string]bool, resultErr error) {
	db, _, err := openOnlineDatabase(cfg, true)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, sanitize(db.Close())) }()
	result = make(map[string]bool, len(tables))
	for _, table := range tables {
		if !onlineName.MatchString(table) {
			return nil, fmt.Errorf("迁移表名无效")
		}
		present, err := migrationTableExists(ctx, db, cfg.Driver, table)
		if err != nil {
			return nil, onlineDatabaseError(ctx, "检查退休数据库表", err)
		}
		result[table] = present
	}
	return result, nil
}

func openOnlineDatabase(cfg database.Config, readOnly bool) (*sql.DB, string, error) {
	if err := database.ValidateConfig(&cfg); err != nil {
		return nil, "", err
	}
	var path string
	if cfg.Driver == database.DriverSQLite {
		var err error
		path, err = database.ExistingSQLitePath(cfg)
		if err != nil {
			return nil, "", err
		}
		slash := filepath.ToSlash(path)
		if !strings.HasPrefix(slash, "/") {
			slash = "/" + slash
		}
		mode := "rw"
		if readOnly {
			mode = "ro"
		}
		query := url.Values{"mode": {mode}, "_txlock": {"immediate"}, "_pragma": {"busy_timeout(200)", "foreign_keys(1)"}}
		cfg.DSN = (&url.URL{Scheme: "file", Path: slash, RawQuery: query.Encode()}).String()
	}
	connection, _, err := openDatabase(cfg)
	return connection, path, err
}

func onlineDatabaseError(ctx context.Context, operation string, err error) error {
	if err == nil {
		return nil
	}
	if cause := ctx.Err(); cause != nil {
		return fmt.Errorf("%s: %w", operation, cause)
	}
	var sqliteError interface{ Code() int }
	if errors.As(err, &sqliteError) {
		// SQLITE_BUSY 和 SQLITE_LOCKED 的扩展错误保留基础错误码的低八位。
		if code := sqliteError.Code() & 0xff; code == 5 || code == 6 {
			return fmt.Errorf("%s: %w", operation, ErrOnlineBusy)
		}
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && (postgresError.Code == "55P03" || postgresError.Code == "40P01") {
		return fmt.Errorf("%s: %w", operation, ErrOnlineBusy)
	}
	var mysqlError *mysql.MySQLError
	if errors.As(err, &mysqlError) && (mysqlError.Number == 1205 || mysqlError.Number == 1213) {
		return fmt.Errorf("%s: %w", operation, ErrOnlineBusy)
	}
	return fmt.Errorf("%s: %w", operation, sanitize(err))
}
