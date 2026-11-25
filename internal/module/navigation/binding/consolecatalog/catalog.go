// Package consolecatalog 适配 console-web 生成的真实菜单目录。
package consolecatalog

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/reina0721/clouddrive/internal/module/navigation/model"
	"github.com/reina0721/clouddrive/internal/module/navigation/service"
)

//go:embed catalog.json
var source []byte

// 该对目录版本只改变菜单图标、API 工作台的默认父级和默认顺序。
// 保留旧策略版本写入兼容，回滚时旧二进制仍能读取此版本写入的策略。
const (
	previousPolicyRevision = "71b1e8f16b4b55c335ded8adf0de79c1c6e846d2d81db5b78e7b702711158ee6"
	presentationRevision   = "ac4588884d725df00a5c5ea47cdd30861d7a1dd4d89ac12e5def214a58c7f773"
)

type Catalog struct{ snapshot service.CatalogSnapshot }

func New() (*Catalog, error) {
	var definitions []model.Definition
	if err := json.Unmarshal(source, &definitions); err != nil {
		return nil, err
	}
	hash := sha256.Sum256(source)
	snapshot := service.CatalogSnapshot{Revision: hex.EncodeToString(hash[:]), Definitions: definitions}
	if snapshot.Revision == presentationRevision {
		snapshot.PolicyRevision = previousPolicyRevision
	}
	return &Catalog{snapshot: snapshot}, nil
}
func (c *Catalog) Snapshot() service.CatalogSnapshot {
	snapshot := c.snapshot
	snapshot.Definitions = append([]model.Definition(nil), snapshot.Definitions...)
	return snapshot
}
func (c *Catalog) Validate(snapshot service.CatalogSnapshot, policies []model.Policy) (string, error) {
	if snapshot.Revision != c.snapshot.Revision {
		return "", model.ErrCatalogChanged
	}
	parents := map[string]string{}
	for _, definition := range snapshot.Definitions {
		parents[definition.ID] = definition.DefaultParentID
	}
	for _, policy := range policies {
		if _, ok := parents[policy.NavigationID]; !ok {
			return "", model.ErrUnknown
		}
		if err := model.ValidatePolicy(policy); err != nil {
			return "", err
		}
		if policy.ParentOverride != nil {
			parents[policy.NavigationID] = *policy.ParentOverride
		}
	}
	branches := map[string]bool{}
	for _, definition := range snapshot.Definitions {
		if definition.DefaultParentID != "" && !strings.HasPrefix(definition.DefaultParentID, "group:") {
			branches[definition.DefaultParentID] = true
		}
	}
	for id, parent := range parents {
		if strings.HasPrefix(id, "group:") {
			if parent != "" {
				return "", model.ErrInvalidParent
			}
		} else if parent == "" || (!strings.HasPrefix(parent, "group:") && (!branches[parent] || branches[id])) {
			return "", model.ErrInvalidParent
		}
	}
	for id := range parents {
		seen := map[string]bool{}
		current := id
		depth := 0
		for current != "" {
			if seen[current] {
				return "", model.ErrCycle
			}
			seen[current] = true
			parent, exists := parents[current]
			if !exists {
				return "", model.ErrInvalidParent
			}
			depth++
			if depth > 3 {
				return "", model.ErrInvalidParent
			}
			current = parent
		}
	}
	stable := append([]model.Policy(nil), policies...)
	sort.Slice(stable, func(i, j int) bool { return stable[i].NavigationID < stable[j].NavigationID })
	bytes, err := json.Marshal(stable)
	if err != nil {
		return "", fmt.Errorf("encode navigation policies: %w", err)
	}
	hash := sha256.Sum256(append([]byte(snapshot.Revision), bytes...))
	return hex.EncodeToString(hash[:]), nil
}
