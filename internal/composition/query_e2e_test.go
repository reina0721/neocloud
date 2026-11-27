package composition

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/reina0721/neocloud/pkg/database"
	"github.com/reina0721/neocloud/pkg/idgen"
	"gorm.io/gorm"

	"github.com/reina0721/neocloud/pkg/testkit"
)

func TestAdvancedQueryHTTPOptionalBoundsOwnershipAndDatabaseBudget(t *testing.T) {
	directory := testkit.PrivateTempDir(t)
	dbPath := filepath.Join(directory, "query.db")
	configPath := filepath.Join(directory, "config.yaml")
	setup, err := idgen.UUID().New()
	if err != nil {
		t.Fatal(err)
	}
	password, err := idgen.UUID().New()
	if err != nil {
		t.Fatal(err)
	}
	payload := "iam:\n  local:\n    setupToken: " + setup + "\n" + strings.Replace(generationConfig(directory, 120, 32<<20, dbPath), "mode: development-anonymous", "mode: session", 1)
	payload = strings.Replace(payload, "files:\n", "files:\n  search:\n    treeEntries: 12\n", 1)
	writeGenerationConfig(t, configPath, payload)
	coordinator, _ := newGenerationTestCoordinator(t, configPath)
	if err := coordinator.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := coordinator.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	owner := &consoleTestClient{base: "http://" + coordinator.Diagnostics().BoundAddress, cookies: map[string]string{}}
	owner.request(t, "GET", "/auth/csrf", nil, 200)
	owner.request(t, "POST", "/auth/setup", map[string]string{"setupToken": setup, "email": "query-owner@clouddrive.test", "name": "查询验收", "password": password}, 200)
	folder := owner.request(t, "POST", "/native/files/folders", map[string]string{"name": "查询根目录", "parentId": ""}, 200)["id"].(string)
	nested := owner.request(t, "POST", "/native/files/folders", map[string]string{"name": "后代目录", "parentId": folder}, 200)["id"].(string)
	alpha := owner.request(t, "POST", "/native/files/text", map[string]string{"name": "Alpha-report,final.TXT", "parentId": folder, "text": "abcdefghij", "key": "advanced-query-alpha-key"}, 200)["id"].(string)
	beta := owner.request(t, "POST", "/native/files/text", map[string]string{"name": "beta-report.md", "parentId": nested, "text": "", "key": "advanced-query-beta-key"}, 200)["id"].(string)
	get := func(query string) map[string]any { return owner.request(t, "GET", "/native/files?"+query, nil, 200) }
	requireIDs := func(query string, want ...string) {
		t.Helper()
		result := get(query)
		entries := result["items"].([]any)
		if len(entries) != len(want) {
			t.Fatalf("查询返回%d项，预期%d", len(entries), len(want))
		}
		expected := map[string]bool{}
		for _, id := range want {
			expected[id] = true
		}
		for _, value := range entries {
			if !expected[value.(map[string]any)["id"].(string)] {
				t.Fatal("查询返回范围外条目")
			}
		}
		if result["usedBytes"] != float64(10) {
			t.Fatal("过滤改变了逻辑占用")
		}
	}
	requireIDs("scope=all&keywords="+url.QueryEscape("report,final"), alpha)
	requireIDs("scope=all&keywords=ALPHA&keywords=report&match=all", alpha)
	requireIDs("scope=all&keywords=Alpha&keywords=beta&match=any", alpha, beta)
	requireIDs("scope=all&keywords=alpha&caseSensitive=true")
	requireIDs("scope=folder&parent="+folder+"&keywords=report", alpha)
	requireIDs("scope=tree&parent="+folder+"&keywords=report", alpha, beta)
	requireIDs("scope=all&extensions=TXT&extensions=.md", alpha, beta)
	requireIDs("scope=all&kinds=file&minBytes=0&maxBytes=0", beta)
	requireIDs("scope=all&minBytes=10&maxBytes=10", alpha)
	// 只推进隔离库的日期字段，验证参数缺失与整日边界，不等待墙钟。
	config := database.DefaultConfig()
	config.Driver = database.DriverSQLite
	config.DSN = dbPath
	resource, err := database.NewGORM(t.Context(), &config)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	updateErr := database.UseGORM(t.Context(), resource.Client(), func(db *gorm.DB) error {
		if err := db.Table("files_entries").Where("id = ?", alpha).Updates(map[string]any{"created_at": base.Add(23 * time.Hour), "updated_at": base.Add(48 * time.Hour)}).Error; err != nil {
			return err
		}
		return db.Table("files_entries").Where("id = ?", beta).Updates(map[string]any{"created_at": base.Add(24 * time.Hour), "updated_at": base.Add(72 * time.Hour)}).Error
	})
	if err := errors.Join(updateErr, resource.Close()); err != nil {
		t.Fatal(err)
	}
	requireIDs("scope=all&kinds=file&createdFrom=2026-11-03T00%3A00%3A00Z&createdTo=2026-11-04T00%3A00%3A00Z", alpha)
	requireIDs("scope=all&kinds=file&modifiedFrom=2026-11-05T00%3A00%3A00Z&modifiedTo=2026-11-06T00%3A00%3A00Z", alpha)
	for _, scenario := range []struct {
		query  string
		status int
	}{{"minBytes=2&maxBytes=1", 422}, {"keywords=&keywords=Alpha", 400}, {"extensions=", 400}, {"minBytes=", 400}, {"createdFrom=not-a-time", 400}, {"createdFrom=2026-11-04T00%3A00%3A00Z&createdTo=2026-11-03T00%3A00%3A00Z", 422}, {"scope=public", 400}, {"match=regexp", 400}, {"pageSize=201", 400}, {"page=2&pageSize=0", 422}} {
		owner.request(t, "GET", "/native/files?"+scenario.query, nil, scenario.status)
	}
	page := get("scope=tree&parent=" + folder + "&pageSize=1&foldersFirst=true&desc=true")
	if page["total"] != float64(3) || page["page"] != float64(1) || page["items"].([]any)[0].(map[string]any)["kind"] != "folder" {
		t.Fatal("真实分页或目录优先错误")
	}
	requireIDs("scope=tree&parent=" + folder + "&pageSize=1&page=99")
	role := owner.request(t, "POST", "/roles", map[string]any{"name": "检索成员", "permissions": []string{"account.update"}}, 200)["role"].(map[string]any)
	roleID := role["id"].(string)
	owner.request(t, "PUT", "/native/iam/roles/"+roleID+"/permissions", map[string]any{"expectedRoleVersion": 1, "permissionKeys": []string{"files:read", "files:write"}}, 200)
	owner.request(t, "POST", "/users", map[string]any{"email": "query-member@clouddrive.test", "name": "检索成员", "password": password, "roleIds": []string{roleID}, "status": "active"}, 200)
	member := &consoleTestClient{base: owner.base, cookies: map[string]string{}}
	member.request(t, "GET", "/auth/csrf", nil, 200)
	member.request(t, "POST", "/auth/login", map[string]string{"email": "query-member@clouddrive.test", "password": password}, 200)
	if len(member.request(t, "GET", "/native/files?scope=all&keywords=report", nil, 200)["items"].([]any)) != 0 {
		t.Fatal("查询跨owner")
	}
	member.request(t, "GET", "/native/files?scope=tree&parent="+folder, nil, 404)
	member.request(t, "GET", "/native/files?parent="+folder+"&pageSize=1", nil, 404)
	owner.request(t, "POST", "/native/files/"+folder+"/trash", nil, 200)
	requireIDs("scope=all&keywords=report")
	owner.request(t, "POST", "/native/files/"+folder+"/restore", map[string]string{}, 200)
	requireIDs("scope=tree&parent="+folder+"&keywords=report", alpha, beta)
	owner.request(t, "PUT", "/native/iam/roles/"+roleID+"/permissions", map[string]any{"expectedRoleVersion": 2, "permissionKeys": []string{}}, 200)
	member.request(t, "GET", "/native/files?scope=all", nil, 401)
	var extra []string
	for index := 0; index < 11; index++ {
		created := owner.request(t, "POST", "/native/files/folders", map[string]string{"parentId": "", "name": fmt.Sprintf("预算%02d", index)}, 200)
		extra = append(extra, created["id"].(string))
	}
	owner.request(t, "GET", "/native/files?scope=all&keywords=report&pageSize=1", nil, 413)
	last := get("page=12&pageSize=1")
	if last["total"] != float64(12) || last["usedBytes"] != float64(10) ||
		last["items"].([]any)[0].(map[string]any)["id"] != extra[10] {
		t.Fatal("账号检索超限时编号分页丢失条目或账号占用")
	}
	first := get("scope=folder&pagination=auto&sort=size&desc=true&foldersFirst=true&parent=" + folder + "&pageSize=1")
	if first["items"].([]any)[0].(map[string]any)["id"] != nested ||
		first["breadcrumbs"].([]any)[0].(map[string]any)["id"] != folder {
		t.Fatal("账号检索超限时目录排序或面包屑错误")
	}
	cursor := first["cursorPage"].(map[string]any)["next"].(string)
	rest := get("scope=folder&pagination=auto&sort=size&desc=true&foldersFirst=true&parent=" + folder + "&pageSize=1&cursor=" + url.QueryEscape(cursor))
	if rest["items"].([]any)[0].(map[string]any)["id"] != alpha || rest["total"] != float64(2) {
		t.Fatal("账号检索超限时游标无法继续浏览")
	}
	for _, id := range []string{extra[0], extra[1], extra[2], folder} {
		owner.request(t, "POST", "/native/files/"+id+"/trash", nil, 200)
	}
	if trash := get("trash=true&pageSize=1"); trash["total"] != float64(4) || trash["usedBytes"] != float64(10) {
		t.Fatal("账号检索超限时回收站分页范围或配额错误")
	}
	const purgePath = "/native/files/trash/purge"
	preview := func(ids ...string) map[string]any {
		return owner.request(t, "POST", purgePath+"-preview", map[string]any{"scope": "selection", "ids": ids}, 200)
	}
	confirm := func(stamp any, status int, ids ...string) {
		owner.request(t, "POST", purgePath, map[string]any{"scope": "selection", "ids": ids, "snapshot": stamp}, status)
	}
	single := preview(extra[0])
	confirm(single["snapshot"], 200, extra[0])
	batch := preview(extra[1], extra[2])
	if batch["entryCount"] != float64(2) {
		t.Fatal("批量清理范围不正确")
	}
	confirm(batch["snapshot"], 200, extra[1], extra[2])
	folderPreview := preview(folder)
	if folderPreview["entryCount"] != float64(4) || folderPreview["bytes"] != float64(10) {
		t.Fatal("清理预览未包含已回收目录的完整子树")
	}
	owner.request(t, "POST", "/native/files/"+folder+"/restore", map[string]string{}, 200)
	confirm(folderPreview["snapshot"], 409, folder)
	requireIDs("scope=tree&parent="+folder+"&keywords=report", alpha, beta)

	owner.request(t, "POST", "/native/files/folders", map[string]string{"parentId": "", "name": "保留的独立目录"}, 200)
	owner.request(t, "GET", "/native/files?scope=all&keywords=report&pageSize=1", nil, 413)
	owner.request(t, "PUT", "/native/files/"+alpha+"/text", map[string]any{"expectedRevision": 1, "text": "new"}, 200)
	if result := get("pageSize=1"); result["usedBytes"] != float64(13) {
		t.Fatal("目录分页的逻辑占用未计算旧版本")
	}
	owner.request(t, "POST", "/native/files/"+folder+"/trash", nil, 200)
	owner.request(t, "GET", "/native/files/inventory/"+beta, nil, 200)
	folderPreview = preview(folder)
	if folderPreview["entryCount"] != float64(4) || folderPreview["bytes"] != float64(13) {
		t.Fatal("重新回收后的确认范围未包含后代与旧版本")
	}
	confirm(folderPreview["snapshot"], 200, folder)
	for _, id := range []string{folder, nested, alpha, beta} {
		owner.request(t, "GET", "/native/files/inventory/"+id, nil, 404)
	}
	if result := get("pageSize=1"); result["usedBytes"] != float64(0) || result["total"] != float64(9) {
		t.Fatal("目录永久删除未释放完整逻辑占用或影响了无关目录")
	}
}
