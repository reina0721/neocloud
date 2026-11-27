package nativeupgrade

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"time"

	_ "github.com/glebarez/sqlite" // 注册项目正在使用的纯 Go SQLite driver。
)

type Job struct {
	ID        string     `json:"id"`
	Action    string     `json:"action"`
	Target    string     `json:"target"`
	Phase     string     `json:"phase"`
	Result    string     `json:"result,omitempty"`
	Backup    string     `json:"backup,omitempty"`
	StartedAt time.Time  `json:"startedAt"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
}

type State struct {
	Current    string    `json:"current"`
	Driver     string    `json:"driver,omitempty"`
	Addresses  [2]string `json:"addresses"`
	Previous   string    `json:"previous,omitempty"`
	Transition string    `json:"transition,omitempty"` // 已授权、可能已开始在线迁移的目标。
	Checkpoint string    `json:"checkpoint,omitempty"`
	Job        *Job      `json:"job,omitempty"`
	Profile    string    `json:"profile,omitempty"`
	WebAddress string    `json:"webAddress,omitempty"`
}

type journal struct{ db *sql.DB }

// A full instance uses a versioned envelope. Legacy hosts cannot read it as
// a Go-only selection and accidentally start the former backend.
type fullState struct {
	Format int   `json:"format"`
	State  State `json:"state"`
}

func openJournal(ctx context.Context, path string) (*journal, State, error) {
	path = filepath.ToSlash(path)
	if volume := filepath.VolumeName(path); volume != "" {
		path = "/" + path
	}
	dsn := url.URL{Scheme: "file", Path: path, RawQuery: "_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, State{}, err
	}
	db.SetMaxOpenConns(1)
	j := &journal{db: db}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS native_state (
		id INTEGER PRIMARY KEY CHECK (id = 1), body BLOB NOT NULL
	)`); err != nil {
		return nil, State{}, errors.Join(err, db.Close())
	}
	state, err := j.load(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return j, State{}, nil
		}
		return nil, State{}, errors.Join(err, db.Close())
	}
	return j, state, nil
}

func (j *journal) load(ctx context.Context) (State, error) {
	var data []byte
	if err := j.db.QueryRowContext(ctx, "SELECT body FROM native_state WHERE id = 1").Scan(&data); err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, fmt.Errorf("无效的原生升级记录: %w", err)
	}
	if state.Current == "" {
		var full fullState
		if err := json.Unmarshal(data, &full); err != nil {
			return State{}, fmt.Errorf("无效的原生整包记录: %w", err)
		}
		if full.Format != 2 || full.State.Profile != fullProfile {
			return State{}, errors.New("无法识别原生整包升级记录格式")
		}
		state = full.State
	} else if state.Profile != "" {
		return State{}, errors.New("原生升级记录使用了不兼容的交付类型")
	}
	if state.Current == "" {
		return State{}, errors.New("原生升级记录缺少当前版本")
	}
	return state, nil
}

func (j *journal) save(ctx context.Context, state State) error {
	var value any = state
	if state.Profile == fullProfile {
		value = fullState{Format: 2, State: state}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = j.db.ExecContext(ctx, `INSERT INTO native_state (id, body) VALUES (1, ?)
		ON CONFLICT (id) DO UPDATE SET body = excluded.body`, data)
	return err
}
