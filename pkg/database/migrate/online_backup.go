package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/reina0721/clouddrive/pkg/database"
)

// BackupOnline 创建已存在数据库的一致快照，不关闭业务连接，不自动恢复旧数据。
func BackupOnline(ctx context.Context, cfg database.Config, directory string) (path string, resultErr error) {
	if ctx == nil || !filepath.IsAbs(directory) {
		return "", fmt.Errorf("数据库恢复点需要受控的绝对目录")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("数据库恢复点目录不可用")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	file, err := os.CreateTemp(directory, "database-*."+string(cfg.Driver)+".partial")
	if err != nil {
		return "", fmt.Errorf("创建数据库恢复点文件失败")
	}
	temporary := file.Name()
	defer func() {
		if resultErr != nil {
			if err := os.Remove(temporary); err != nil && !errors.Is(err, os.ErrNotExist) {
				resultErr = errors.Join(resultErr, fmt.Errorf("清理不完整数据库恢复点失败"))
			}
		}
	}()
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("关闭恢复点暂存文件失败")
	}
	backup := func() error {
		switch cfg.Driver {
		case database.DriverSQLite:
			return backupSQLite(ctx, cfg, temporary)
		case database.DriverPostgres:
			return backupPostgres(ctx, cfg, temporary)
		case database.DriverMySQL:
			return backupMySQL(ctx, cfg, temporary)
		default:
			return fmt.Errorf("当前数据库没有在线恢复点适配")
		}
	}
	if err := WithMigrationLock(ctx, cfg, backup); err != nil {
		return "", err
	}
	ready := strings.TrimSuffix(temporary, ".partial")
	if err := finalizeBackup(temporary, ready); err != nil {
		return "", err
	}
	return ready, nil
}

func finalizeBackup(temporary, ready string) error {
	// #nosec G304 -- temporary 由受控备份目录内的 os.CreateTemp 分配，名称未经过用户输入。
	file, err := os.OpenFile(temporary, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("读取已生成的数据库恢复点失败")
	}
	info, infoErr := file.Stat()
	closeErr := errors.Join(file.Sync(), file.Close())
	if infoErr != nil || info.Size() == 0 || closeErr != nil {
		return fmt.Errorf("数据库恢复点为空或未成功持久化")
	}
	if err := publishOnlineBackup(temporary, ready); err != nil {
		return fmt.Errorf("发布已验证的数据库恢复点失败")
	}
	return nil
}

func backupSQLite(ctx context.Context, cfg database.Config, destination string) (resultErr error) {
	db, _, err := openOnlineDatabase(cfg, true)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, sanitize(db.Close())) }()
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", destination); err != nil {
		return onlineDatabaseError(ctx, "创建 SQLite 在线快照", err)
	}
	cfg.DSN = destination
	verify, _, err := openOnlineDatabase(cfg, true)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, sanitize(verify.Close())) }()
	var integrity string
	if err := verify.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
		return onlineDatabaseError(ctx, "验证 SQLite 快照", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("SQLite 在线快照完整性检查失败")
	}
	return nil
}

func backupPostgres(ctx context.Context, cfg database.Config, destination string) error {
	environment, err := postgresBackupEnv(cfg.DSN)
	if err != nil {
		return err
	}
	// #nosec G204 -- 官方客户端名和参数固定，目标为受控临时文件，凭据只在子进程环境中。
	dump := exec.CommandContext(ctx, "pg_dump", "--format=custom", "--no-password", "--file="+destination)
	dump.Env = environment
	if err := dump.Run(); err != nil {
		return onlineDatabaseError(ctx, "运行 PostgreSQL pg_dump 在线备份", err)
	}
	// #nosec G204 -- 只列出已生成恢复点的目录，不连接服务器。
	verify := exec.CommandContext(ctx, "pg_restore", "--list", destination)
	return onlineDatabaseError(ctx, "验证 PostgreSQL 恢复点目录", verify.Run())
}

func postgresBackupEnv(dsn string) ([]string, error) {
	address, err := url.Parse(dsn)
	if err != nil || (address.Scheme != "postgres" && address.Scheme != "postgresql") || address.Hostname() == "" || strings.Contains(address.Host, ",") {
		return nil, fmt.Errorf("PostgreSQL 在线备份需要单端点 PostgreSQL URI")
	}
	parsed, err := pgconn.ParseConfig(dsn)
	if err != nil || parsed.Database == "" || parsed.User == "" || parsed.Host != address.Hostname() {
		return nil, fmt.Errorf("PostgreSQL 在线备份无法匹配应用连接端点")
	}
	options := map[string]string{
		"host": "PGHOST", "port": "PGPORT", "user": "PGUSER", "dbname": "PGDATABASE", "password": "PGPASSWORD",
		"sslmode": "PGSSLMODE", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY", "sslrootcert": "PGSSLROOTCERT",
		"sslcrl": "PGSSLCRL", "sslsni": "PGSSLSNI", "connect_timeout": "PGCONNECT_TIMEOUT", "application_name": "PGAPPNAME",
	}
	values := map[string]string{
		"PGHOST": parsed.Host, "PGPORT": strconv.Itoa(int(parsed.Port)), "PGUSER": parsed.User,
		"PGDATABASE": parsed.Database, "PGPASSWORD": parsed.Password,
	}
	for key, items := range address.Query() {
		environmentKey, permitted := options[key]
		if !permitted || len(items) != 1 {
			return nil, fmt.Errorf("PostgreSQL 在线备份无法无损传递 URI 连接选项")
		}
		if _, resolved := values[environmentKey]; !resolved {
			values[environmentKey] = items[0]
		}
	}
	for _, rejected := range []string{"PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGREQUIRESSL", "PGSSLCERTMODE"} {
		if os.Getenv(rejected) != "" {
			return nil, fmt.Errorf("PostgreSQL 在线备份无法确认当前环境的连接语义")
		}
	}
	return withOnlineBackupEnv(values), nil
}

func withOnlineBackupEnv(values map[string]string) []string {
	var result []string
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if _, override := values[strings.ToUpper(name)]; !override {
			result = append(result, entry)
		}
	}
	for name, value := range values {
		result = append(result, name+"="+value)
	}
	return result
}

func backupMySQL(ctx context.Context, cfg database.Config, destination string) (resultErr error) {
	parsed, err := mysql.ParseDSN(cfg.DSN)
	if err != nil || parsed.DBName == "" || parsed.User == "" || parsed.Net != "tcp" {
		return fmt.Errorf("MySQL 在线备份需要具名数据库和 TCP 端点")
	}
	if parsed.ServerPubKey != "" {
		return fmt.Errorf("MySQL 在线备份未能匹配应用的固定认证公钥")
	}
	host, port, err := net.SplitHostPort(parsed.Addr)
	if err != nil {
		return fmt.Errorf("MySQL 在线备份端点无效")
	}
	sslMode := "DISABLED"
	switch parsed.TLSConfig {
	case "", "false":
	case "true":
		sslMode = "VERIFY_IDENTITY"
	case "preferred":
		sslMode = "PREFERRED"
	case "skip-verify":
		sslMode = "REQUIRED"
	default:
		return fmt.Errorf("MySQL 在线备份未能匹配应用的 TLS 配置")
	}
	if err := checkMySQLBackupTables(ctx, cfg); err != nil {
		return err
	}
	options, err := os.CreateTemp(filepath.Dir(destination), ".mysql-client-*")
	if err != nil {
		return fmt.Errorf("创建 MySQL 专用客户端配置失败")
	}
	defer func() {
		if err := os.Remove(options.Name()); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("清理 MySQL 客户端临时凭据失败"))
		}
	}()
	_, writeErr := fmt.Fprintf(options, "[client]\nprotocol=TCP\nhost=%s\nport=%s\nuser=%s\npassword=%s\nssl-mode=%s\n",
		mysqlOption(host), mysqlOption(port), mysqlOption(parsed.User), mysqlOption(parsed.Passwd), mysqlOption(sslMode))
	if err := errors.Join(writeErr, options.Close()); err != nil {
		return fmt.Errorf("写入 MySQL 专用客户端配置失败")
	}
	args := []string{"--defaults-file=" + options.Name(), "--no-login-paths", "--single-transaction",
		"--skip-lock-tables", "--no-tablespaces", "--set-gtid-purged=OFF", "--result-file=" + destination}
	if sslMode == "DISABLED" || sslMode == "PREFERRED" {
		// 无 TLS 且未指定固定 RSA 公钥时，Go 驱动会向服务器请求认证公钥。
		args = append(args, "--get-server-public-key")
	}
	args = append(args, "--", parsed.DBName)
	// #nosec G204 -- 官方客户端和选项固定，应用连接设置通过专用配置传递，数据库名是位置参数。
	dump := exec.CommandContext(ctx, "mysqldump", args...)
	return onlineDatabaseError(ctx, "运行 MySQL mysqldump 在线备份", dump.Run())
}

func mysqlOption(value string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`).Replace(value)
	return `"` + escaped + `"`
}

func checkMySQLBackupTables(ctx context.Context, cfg database.Config) (resultErr error) {
	db, _, err := openDatabase(cfg)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, sanitize(db.Close())) }()
	var found sql.NullBool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE()
		AND TABLE_TYPE = 'BASE TABLE' AND (ENGINE IS NULL OR ENGINE <> 'InnoDB'))`).Scan(&found); err != nil {
		return onlineDatabaseError(ctx, "检查 MySQL 一致性快照前提", err)
	}
	if !found.Valid || found.Bool {
		return fmt.Errorf("MySQL 在线备份只接受 InnoDB 基表")
	}
	return nil
}
