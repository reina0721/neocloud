package composition

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/gofrs/flock"
	pkgdatabase "github.com/reina0721/clouddrive/pkg/database"
)

type managedLease struct {
	check func(context.Context) error
	close func() error
}

func acquireManagedLease(ctx context.Context, cfg pkgdatabase.Config) (*managedLease, error) {
	if cfg.Driver == pkgdatabase.DriverSQLite {
		path, err := pkgdatabase.ExistingSQLitePath(cfg)
		if err != nil {
			return nil, err
		}
		lock := flock.New(path+".clouddrive-workload.lock", flock.SetPermissions(0o600))
		locked, err := lock.TryLockContext(ctx, 25*time.Millisecond)
		if err != nil || !locked {
			return nil, errors.Join(fmt.Errorf("SQLite business ownership is unavailable"), err, lock.Close())
		}
		return &managedLease{close: lock.Close}, nil
	}
	var driver, acquire, hasOwnership string
	switch cfg.Driver {
	case pkgdatabase.DriverPostgres:
		driver = "pgx"
		acquire = `SELECT pg_try_advisory_lock(2081618212, 240099890)`
		hasOwnership = `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=2081618212 AND objid=240099890 AND objsubid=2 AND granted)`
	case pkgdatabase.DriverMySQL:
		driver = "mysql"
		acquire = `SELECT COALESCE(GET_LOCK(CONCAT('clouddrive-runtime:', MD5(DATABASE())), 0), 0) = 1`
		hasOwnership = `SELECT COALESCE(IS_USED_LOCK(CONCAT('clouddrive-runtime:', MD5(DATABASE()))) = CONNECTION_ID(), 0)`
	default:
		return nil, fmt.Errorf("managed business ownership requires a persistent database")
	}
	db, err := sql.Open(driver, cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("open business ownership connection")
	}
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("connect business ownership connection"), ctx.Err(), db.Close())
	}
	closeConnection := func() error { return errors.Join(conn.Close(), db.Close()) }
	var locked bool
	if err := conn.QueryRowContext(ctx, acquire).Scan(&locked); err != nil || !locked {
		return nil, errors.Join(fmt.Errorf("database business ownership is unavailable"), ctx.Err(), closeConnection())
	}
	return &managedLease{
		close: closeConnection,
		check: func(ctx context.Context) error {
			var held bool
			if err := conn.QueryRowContext(ctx, hasOwnership).Scan(&held); err != nil || !held {
				return fmt.Errorf("database business ownership was lost")
			}
			return nil
		},
	}, nil
}
