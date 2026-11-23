package httpbinding

import (
	"net/http"
	"reflect"
	"strconv"

	"github.com/danielgtaylor/huma/v2"
)

const passwordPolicyPath = "/system/password-policy"

type PasswordPolicy struct {
	MinLength         int    `json:"minLength" minimum:"1" maximum:"128"`
	MaxLength         int    `json:"maxLength" minimum:"1" maximum:"128"`
	RequireComplexity bool   `json:"requireComplexity"`
	Overridden        bool   `json:"overridden"`
	Version           uint64 `json:"version" minimum:"1"`
}

type PasswordPolicyInput struct {
	MinLength         *int   `json:"minLength" required:"true" minimum:"1" maximum:"128"`
	MaxLength         *int   `json:"maxLength" required:"true" minimum:"1" maximum:"128"`
	RequireComplexity *bool  `json:"requireComplexity" required:"true"`
	Version           uint64 `json:"version" minimum:"1"`
}

type passwordPolicyReset struct {
	Version uint64 `json:"version" minimum:"1"`
}

type passwordPolicyOperation struct {
	method, id string
	input      any
}

var passwordPolicyOperations = []passwordPolicyOperation{
	{method: http.MethodGet, id: "console.get.system.password-policy"},
	{method: http.MethodPut, id: "console.put.system.password-policy", input: PasswordPolicyInput{}},
	{method: http.MethodDelete, id: "console.delete.system.password-policy", input: passwordPolicyReset{}},
}

// PasswordPolicyOpenAPIPaths 发布与 Console 路由绑定相同的请求、响应和访问契约。
func PasswordPolicyOpenAPIPaths() map[string]*huma.PathItem {
	registry := huma.NewMapRegistry("#/components/schemas/", huma.DefaultSchemaNamer)
	content := func(value any) map[string]*huma.MediaType {
		return map[string]*huma.MediaType{
			"application/json": {Schema: huma.SchemaFromType(registry, reflect.TypeOf(value))},
		}
	}
	response := content(PasswordPolicy{})
	problem := map[string]*huma.MediaType{"application/json": {Schema: &huma.Schema{
		Type: "object", Required: []string{"error"},
		Properties: map[string]*huma.Schema{"error": {
			Type: "object", Required: []string{"code"},
			Properties: map[string]*huma.Schema{"code": {Type: "string"}, "reason": {Type: "string"}},
		}},
	}}}
	var path huma.PathItem
	for _, definition := range passwordPolicyOperations {
		operation := &huma.Operation{
			OperationID: definition.id,
			Security:    []map[string][]string{{"ConsoleCookie": {}}},
			Extensions:  map[string]any{"x-required-permission": "system owner"},
			Responses:   map[string]*huma.Response{"200": {Description: "Success", Content: response}},
		}
		for _, status := range []int{401, 403, 409, 422, 500} {
			operation.Responses[strconv.Itoa(status)] = &huma.Response{Description: http.StatusText(status), Content: problem}
		}
		if definition.input != nil {
			operation.RequestBody = &huma.RequestBody{Required: true, Content: content(definition.input)}
			for _, name := range []string{"Origin", "X-CSRF-Token"} {
				operation.Parameters = append(operation.Parameters, &huma.Param{
					Name: name, In: "header", Required: true, Schema: &huma.Schema{Type: "string"},
				})
			}
		}
		switch definition.method {
		case http.MethodGet:
			path.Get = operation
		case http.MethodPut:
			path.Put = operation
		case http.MethodDelete:
			path.Delete = operation
		}
	}
	return map[string]*huma.PathItem{Prefix + passwordPolicyPath: &path}
}

func (h *Handler) passwordPolicyRoutes() {
	for _, operation := range passwordPolicyOperations {
		h.mux.HandleFunc(operation.method+" "+Prefix+passwordPolicyPath, h.passwordPolicy)
	}
}

func (h *Handler) passwordPolicy(w http.ResponseWriter, r *http.Request) {
	account := current(r).Identity.AccountID
	if !h.requireDeploymentOwner(w, r, account) {
		return
	}
	var value PasswordPolicy
	var err error
	switch r.Method {
	case http.MethodPut:
		var input PasswordPolicyInput
		if !decode(w, r, &input) {
			return
		}
		if input.MinLength == nil || input.MaxLength == nil || input.RequireComplexity == nil || input.Version == 0 {
			failure(w, http.StatusUnprocessableEntity, "validation", "")
			return
		}
		value, err = h.iam.UpdatePasswordPolicy(r.Context(), input.Version, &input)
	case http.MethodDelete:
		var input passwordPolicyReset
		if !decode(w, r, &input) {
			return
		}
		if input.Version == 0 {
			failure(w, http.StatusUnprocessableEntity, "validation", "")
			return
		}
		value, err = h.iam.UpdatePasswordPolicy(r.Context(), input.Version, nil)
	default:
		value, err = h.iam.PasswordPolicy(r.Context())
	}
	if err != nil {
		problem(w, err)
		return
	}
	reply(w, value)
}
