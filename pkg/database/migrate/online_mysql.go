package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/reina0721/neocloud/pkg/database"
)

// MySQL DDL 隐式提交。先持久记录意图，连接中断后按同一签名步骤回读实际结构。
func (s *OnlineSession) applyMySQLStep(ctx context.Context, versionTable string, from, to uint, digest string, operation OnlineOperation, ddl string) error {
	status, err := readOnlineVersion(ctx, s.conn, s.driver, versionTable)
	if err != nil {
		return err
	}
	if status.Empty || status.Dirty || status.Version != from {
		return ErrOnlineState
	}
	if _, err := s.conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS clouddrive_online_migration_steps (
		version_table VARCHAR(63) NOT NULL, target_version BIGINT NOT NULL,
		source_version BIGINT NOT NULL, digest CHAR(64) NOT NULL, completed BOOLEAN NOT NULL,
		PRIMARY KEY (version_table, target_version)
	) ENGINE=InnoDB`); err != nil {
		return onlineDatabaseError(ctx, "准备 MySQL 迁移步骤记录", err)
	}
	var sourceVersion uint
	var recordedDigest string
	var completed bool
	err = s.conn.QueryRowContext(ctx, `SELECT source_version, digest, completed FROM clouddrive_online_migration_steps
		WHERE version_table = ? AND target_version = ?`, versionTable, to).Scan(&sourceVersion, &recordedDigest, &completed)
	recorded := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return onlineDatabaseError(ctx, "读取 MySQL 迁移步骤记录", err)
	}
	if recorded && (sourceVersion != from || recordedDigest != digest || completed) {
		return ErrOnlineState
	}
	present, err := s.mysqlOperationPresent(ctx, operation)
	if err != nil {
		return err
	}
	if !recorded {
		if present {
			return fmt.Errorf("MySQL 迁移目标已存在且缺少步骤记录: %w", ErrOnlineState)
		}
		if _, err := s.conn.ExecContext(ctx, `INSERT INTO clouddrive_online_migration_steps
			(version_table, target_version, source_version, digest, completed) VALUES (?, ?, ?, ?, FALSE)`, versionTable, to, from, digest); err != nil {
			return onlineDatabaseError(ctx, "记录 MySQL 迁移意图", err)
		}
	}
	if !present {
		// #nosec G202 -- 由已验证的结构定义和标识符生成，添加列显式要求 INSTANT。
		if _, err := s.conn.ExecContext(ctx, ddl); err != nil {
			return onlineDatabaseError(ctx, "执行 MySQL 在线 DDL，重试时回读结构", err)
		}
		present, err = s.mysqlOperationPresent(ctx, operation)
		if err != nil {
			return err
		}
		if !present {
			return ErrOnlineState
		}
	}
	return s.finishMySQLStep(ctx, versionTable, from, to, digest)
}

func (s *OnlineSession) finishMySQLStep(ctx context.Context, versionTable string, from, to uint, digest string) error {
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return onlineDatabaseError(ctx, "开始 MySQL 版本记录事务", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := updateOnlineVersion(ctx, tx, database.DriverMySQL, versionTable, from, to); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE clouddrive_online_migration_steps SET completed = TRUE
		WHERE version_table = ? AND target_version = ? AND source_version = ? AND digest = ? AND completed = FALSE`, versionTable, to, from, digest)
	if err != nil {
		return onlineDatabaseError(ctx, "记录 MySQL 迁移完成", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return onlineDatabaseError(ctx, "检查 MySQL 迁移完成记录", err)
	}
	if rows != 1 {
		return ErrOnlineState
	}
	return onlineDatabaseError(ctx, "提交 MySQL 迁移版本", tx.Commit())
}

func (s *OnlineSession) mysqlOperationPresent(ctx context.Context, operation OnlineOperation) (bool, error) {
	var engine sql.NullString
	err := s.conn.QueryRowContext(ctx, `SELECT ENGINE FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_name = ?`, operation.Table).Scan(&engine)
	if errors.Is(err, sql.ErrNoRows) && operation.Kind == OnlineCreateTable {
		return false, nil
	}
	if err != nil {
		return false, onlineDatabaseError(ctx, "检查 MySQL 迁移目标表", err)
	}
	if !engine.Valid || !strings.EqualFold(engine.String, "InnoDB") {
		return false, fmt.Errorf("MySQL 在线迁移需要 InnoDB 基表")
	}
	return s.mysqlColumnsMatch(ctx, operation)
}

func (s *OnlineSession) mysqlColumnsMatch(ctx context.Context, operation OnlineOperation) (present bool, resultErr error) {
	statement := `SELECT column_name, column_type, is_nullable, column_key, column_default, extra
		FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`
	args := []any{operation.Table}
	if operation.Kind == OnlineAddColumn {
		statement += " AND column_name = ?"
		args = append(args, operation.Columns[0].Name)
	}
	rows, err := s.conn.QueryContext(ctx, statement+" ORDER BY ordinal_position", args...)
	if err != nil {
		return false, onlineDatabaseError(ctx, "检查 MySQL 迁移目标列", err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, onlineDatabaseError(ctx, "关闭 MySQL 目标列读取", rows.Close()))
	}()
	index := 0
	for rows.Next() {
		if index >= len(operation.Columns) {
			return false, ErrOnlineState
		}
		var name, dataType, nullable, key, extra string
		var defaultValue sql.NullString
		if err := rows.Scan(&name, &dataType, &nullable, &key, &defaultValue, &extra); err != nil {
			return false, onlineDatabaseError(ctx, "解析 MySQL 迁移目标列", err)
		}
		expected := operation.Columns[index]
		if name != expected.Name || !mysqlColumnTypeMatches(expected.Type, dataType) ||
			(nullable == "YES") != expected.Nullable || (key == "PRI") != expected.PrimaryKey ||
			(key != "" && key != "PRI") || defaultValue.Valid || extra != "" {
			return false, ErrOnlineState
		}
		index++
	}
	if err := rows.Err(); err != nil {
		return false, onlineDatabaseError(ctx, "读取 MySQL 迁移目标列", err)
	}
	if index == 0 && operation.Kind == OnlineAddColumn {
		return false, nil
	}
	if index != len(operation.Columns) {
		return false, ErrOnlineState
	}
	return true, nil
}

func mysqlColumnTypeMatches(expected, actual string) bool {
	switch expected {
	case "integer":
		return actual == "int"
	case "boolean":
		return actual == "tinyint(1)"
	default:
		return expected == actual
	}
}
