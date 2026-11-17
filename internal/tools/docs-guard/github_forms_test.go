package main

import "testing"

func TestIssueFormRejectsInvalidInputs(t *testing.T) {
	valid := "name: 缺陷\ndescription: 复现\nbody:\n  - type: input\n    id: version\n    attributes:\n      label: 版本\n    validations:\n      required: true\n"
	if err := validateIssueForm([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, data := range []string{
		"name: [",
		"name: 缺陷\ndescription: 复现\nbody: []\n",
		valid + "unknown: true\n",
		valid + "---\nname: 第二个文档\n",
		valid + "  - type: input\n    id: version\n    attributes:\n      label: 重复\n",
		"name: 缺陷\ndescription: 复现\nbody:\n  - type: input\n    id: version\n",
		"name: 缺陷\ndescription: 复现\nbody:\n  - type: markdown\n    attributes:\n      value: 仅有说明\n",
	} {
		if err := validateIssueForm([]byte(data)); err == nil {
			t.Errorf("无效表单被接受: %s", data)
		}
	}
}

func TestIssueConfigRejectsBrokenContactLinks(t *testing.T) {
	valid := "blank_issues_enabled: false\ncontact_links:\n  - name: 安全报告\n    url: https://github.com/reina0721/neocloud/security/advisories/new\n    about: 私密报告\n"
	if err := validateIssueConfig([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{
		"blank_issues_enabled: false\n",
		valid + "---\ninvalid: true\n",
		"blank_issues_enabled: false\ncontact_links:\n  - name: 安全\n    url: javascript:alert(1)\n    about: 错误入口\n",
	} {
		if err := validateIssueConfig([]byte(input)); err == nil {
			t.Fatalf("接受了无效配置: %s", input)
		}
	}
}
