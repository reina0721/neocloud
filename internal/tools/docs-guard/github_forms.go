package main

import (
	"bytes"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

// 只校验本项目使用的 input/textarea/markdown 表单子集，不替代 GitHub 完整 schema。
type issueForm struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Title       string `yaml:"title"`
	Body        []struct {
		Type       string `yaml:"type"`
		ID         string `yaml:"id"`
		Attributes struct {
			Label       string `yaml:"label"`
			Description string `yaml:"description"`
			Value       string `yaml:"value"`
		} `yaml:"attributes"`
		Validations struct {
			Required bool `yaml:"required"`
		} `yaml:"validations"`
	} `yaml:"body"`
}

var formID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func validateIssueForm(data []byte) error {
	var form issueForm
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&form); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("表单必须只有一个 YAML document")
	}
	if strings.TrimSpace(form.Name) == "" || strings.TrimSpace(form.Description) == "" || len(form.Body) == 0 {
		return fmt.Errorf("表单缺少 name、description 或 body")
	}
	ids := map[string]bool{}
	inputs := 0
	for _, field := range form.Body {
		switch field.Type {
		case "markdown":
			if strings.TrimSpace(field.Attributes.Value) == "" {
				return fmt.Errorf("markdown 缺少 value")
			}
		case "input", "textarea":
			inputs++
			if !formID.MatchString(field.ID) || ids[field.ID] || strings.TrimSpace(field.Attributes.Label) == "" {
				return fmt.Errorf("输入项 id 无效或重复，或缺少 label: %q", field.ID)
			}
			ids[field.ID] = true
		default:
			return fmt.Errorf("未校验的表单类型: %q", field.Type)
		}
	}
	if inputs == 0 {
		return fmt.Errorf("表单没有输入项")
	}
	return nil
}

func githubFormIssues(root string) []string {
	var issues []string
	for _, name := range []string{"bug", "feature", "question"} {
		path := filepath.Join(".github", "ISSUE_TEMPLATE", name+".yml")
		// #nosec G304 -- 开发工具仅读取固定仓库相对路径，无远程输入。
		data, err := os.ReadFile(filepath.Join(root, path))
		if err == nil {
			err = validateIssueForm(data)
		}
		if err != nil {
			issues = append(issues, fmt.Sprintf("GitHub 表单 %s: %v", path, err))
		}
	}
	configPath := filepath.Join(".github", "ISSUE_TEMPLATE", "config.yml")
	// #nosec G304 -- 开发工具仅读取固定仓库相对路径，无远程输入。
	data, err := os.ReadFile(filepath.Join(root, configPath))
	if err == nil {
		err = validateIssueConfig(data)
	}
	if err != nil {
		issues = append(issues, fmt.Sprintf("GitHub 表单配置 %s: %v", configPath, err))
	}
	return issues
}

func validateIssueConfig(data []byte) error {
	var cfg struct {
		BlankIssues *bool `yaml:"blank_issues_enabled"`
		Links       []struct {
			Name  string `yaml:"name"`
			URL   string `yaml:"url"`
			About string `yaml:"about"`
		} `yaml:"contact_links"`
	}
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("配置必须只有一个 YAML document")
	}
	if cfg.BlankIssues == nil || len(cfg.Links) == 0 {
		return fmt.Errorf("必须显式配置 blank_issues_enabled 和联系入口")
	}
	for _, item := range cfg.Links {
		parsed, err := url.ParseRequestURI(item.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || strings.TrimSpace(item.Name) == "" || strings.TrimSpace(item.About) == "" {
			return fmt.Errorf("联系入口名称、说明或 HTTPS URL 无效")
		}
	}
	return nil
}
