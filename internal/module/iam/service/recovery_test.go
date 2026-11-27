package service_test

import (
	"errors"
	"reflect"
	"testing"

	"github.com/reina0721/neocloud/internal/module/iam/model"
	"github.com/reina0721/neocloud/internal/module/iam/service"
)

func TestOwnerRecoveryRechecksTheSelectedAccountInsideThePasswordTransaction(t *testing.T) {
	iam, resource := newService(t)
	defer resource.Close()
	ctx := t.Context()
	if owners, err := iam.RecoverableOwners(ctx); err != nil || len(owners) != 0 {
		t.Fatalf("empty IAM state did not return an empty candidate list: %v", err)
	}
	owner, err := iam.Setup(ctx, "setup-secret", "first-owner", "First owner", "original-first-password")
	if err != nil {
		t.Fatal(err)
	}
	detail, err := iam.AccountDetail(ctx, owner.Identity.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := iam.CreateAccount(ctx, "second-owner", "Second owner", "original-second-password")
	if err != nil {
		t.Fatal(err)
	}
	assigned, err := iam.ReplaceAccountRoles(ctx, second.ID, second.Version, []string{detail.Roles[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	owners, err := iam.RecoverableOwners(ctx)
	if err != nil || !reflect.DeepEqual(owners, []model.RecoveryOwner{
		{ID: owner.Identity.AccountID, Username: "first-owner"},
		{ID: second.ID, Username: "second-owner"},
	}) {
		t.Fatalf("active owner selection is incorrect: %v", err)
	}
	if err := iam.SetAccountStatusVersion(ctx, second.ID, model.AccountDisabled, assigned.EntityVersion); err != nil {
		t.Fatal(err)
	}
	if candidates, err := iam.RecoverableOwners(ctx); err != nil || !reflect.DeepEqual(candidates, owners[:1]) {
		t.Fatalf("disabled owner appeared in the recovery candidates: %v", err)
	}
	if err := iam.SetAccountStatus(ctx, second.ID, model.AccountActive); err != nil {
		t.Fatal(err)
	}
	current, err := iam.AccountDetail(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := iam.ReplaceAccountRoles(ctx, second.ID, current.Account.Version, nil); err != nil {
		t.Fatal(err)
	}
	if err := iam.RecoverOwnerPassword(ctx, owners[1].ID, "replacement-password"); !errors.Is(err, service.ErrOwnerRecoveryUnavailable) {
		t.Fatalf("stale owner recovery returned %v", err)
	}
	if _, err := iam.Login(ctx, "second-owner", "original-second-password"); err != nil {
		t.Fatalf("rejected recovery changed the previous credential: %v", err)
	}
	current, err = iam.AccountDetail(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	assigned, err = iam.ReplaceAccountRoles(ctx, second.ID, current.Account.Version, []string{detail.Roles[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if err := iam.ArchiveAccount(ctx, second.ID, assigned.EntityVersion); err != nil {
		t.Fatal(err)
	}
	if candidates, err := iam.RecoverableOwners(ctx); err != nil || !reflect.DeepEqual(candidates, owners[:1]) {
		t.Fatalf("archived owner appeared in the recovery candidates: %v", err)
	}
}
