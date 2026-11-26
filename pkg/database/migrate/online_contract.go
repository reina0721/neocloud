package migrate

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/reina0721/clouddrive/pkg/database"
)

const (
	OnlineCreateTable = "create-table"
	OnlineAddColumn   = "add-column"
)

var (
	// ErrOnlineBusy 表示在线迁移暂未取得同一个数据库的执行权。
	ErrOnlineBusy = errors.New("在线迁移锁暂不可用")
	// ErrOnlineState 表示实际数据库不属于已确认的在线升级前缀。
	ErrOnlineState = errors.New("数据库不属于已确认的在线迁移状态")
	onlineName     = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)
	onlineSHA256   = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// OnlineColumn 是首期无需扫描既有数据的列定义。
type OnlineColumn struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primaryKey,omitempty"`
}

// OnlineOperation 只描述独立新表或在既有表末尾添加可空列。
type OnlineOperation struct {
	Kind    string         `json:"kind"`
	Table   string         `json:"table"`
	Columns []OnlineColumn `json:"columns"`
}

// OnlineSQL 使用方言生成受限的单条 DDL；与候选程序内嵌的迁移 SQL 必须完全一致。
func OnlineSQL(driver database.Driver, operation OnlineOperation) (string, error) {
	switch driver {
	case database.DriverSQLite, database.DriverPostgres, database.DriverMySQL:
	default:
		return "", fmt.Errorf("当前数据库没有在线迁移适配")
	}
	if !onlineName.MatchString(operation.Table) || strings.HasPrefix(operation.Table, "sqlite_") || strings.HasPrefix(operation.Table, "clouddrive_online_") {
		return "", fmt.Errorf("在线迁移表名无效")
	}
	if len(operation.Columns) == 0 || len(operation.Columns) > 32 {
		return "", fmt.Errorf("在线迁移列数量无效")
	}
	table := quotedTable(driver, operation.Table)
	switch operation.Kind {
	case OnlineAddColumn:
		if len(operation.Columns) != 1 || !operation.Columns[0].Nullable || operation.Columns[0].PrimaryKey {
			return "", fmt.Errorf("在线添加列必须是一个无约束的可空列")
		}
		column, err := onlineColumnSQL(driver, operation.Columns[0])
		if err != nil {
			return "", err
		}
		suffix := ""
		if driver == database.DriverMySQL {
			suffix = ", ALGORITHM=INSTANT"
		}
		return "ALTER TABLE " + table + " ADD COLUMN " + column + suffix + ";", nil
	case OnlineCreateTable:
		definitions := make([]string, 0, len(operation.Columns))
		seen := make(map[string]bool, len(operation.Columns))
		var hasPrimaryKey bool
		for _, column := range operation.Columns {
			if seen[column.Name] || (column.PrimaryKey && (hasPrimaryKey || column.Nullable || column.Type == "text")) {
				return "", fmt.Errorf("在线建表列或主键定义冲突")
			}
			seen[column.Name] = true
			hasPrimaryKey = hasPrimaryKey || column.PrimaryKey
			definition, err := onlineColumnSQL(driver, column)
			if err != nil {
				return "", err
			}
			definitions = append(definitions, definition)
		}
		suffix := ""
		if driver == database.DriverMySQL {
			suffix = " ENGINE=InnoDB"
		}
		return "CREATE TABLE " + table + " (" + strings.Join(definitions, ", ") + ")" + suffix + ";", nil
	default:
		return "", fmt.Errorf("在线迁移操作类型不受支持")
	}
}

func onlineColumnSQL(driver database.Driver, column OnlineColumn) (string, error) {
	if !onlineName.MatchString(column.Name) {
		return "", fmt.Errorf("在线迁移列名无效")
	}
	switch column.Type {
	case "integer", "bigint", "boolean", "text":
	default:
		return "", fmt.Errorf("在线迁移列类型不受支持")
	}
	sql := quotedTable(driver, column.Name) + " " + strings.ToUpper(column.Type)
	if !column.Nullable {
		sql += " NOT NULL"
	}
	if column.PrimaryKey {
		sql += " PRIMARY KEY"
	}
	return sql, nil
}

// VerifyOnlineStep 校验待执行的 SQL 同时受签名清单、候选嵌入文件和在线操作白名单约束。
func VerifyOnlineStep(driver database.Driver, set Set, from, to uint, digest string, operation OnlineOperation) (resultErr error) {
	if from == 0 || to <= from || to > set.CurrentVersion || to > 1_000_000_000 || !onlineSHA256.MatchString(digest) {
		return fmt.Errorf("在线迁移版本或摘要无效")
	}
	if err := validateSet(set, driver); err != nil {
		return err
	}
	expected, err := OnlineSQL(driver, operation)
	if err != nil {
		return err
	}
	source, err := iofs.New(set.FS, set.DriverPaths[driver])
	if err != nil {
		return fmt.Errorf("打开在线迁移文件: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, source.Close()) }()
	next, err := source.Next(from)
	if err != nil || next != to {
		return fmt.Errorf("在线迁移没有匹配的连续步骤")
	}
	up, _, err := source.ReadUp(to)
	if err != nil {
		return fmt.Errorf("读取在线迁移文件: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, up.Close()) }()
	payload, err := io.ReadAll(io.LimitReader(up, 16*1024+1))
	if err != nil || len(payload) > 16*1024 {
		return fmt.Errorf("在线迁移 SQL 无法读取或超出上限")
	}
	if fmt.Sprintf("%x", sha256.Sum256(payload)) != digest || strings.TrimSpace(string(payload)) != expected {
		return fmt.Errorf("在线迁移 SQL 与签名摘要或允许的操作不一致")
	}
	return nil
}
