package files

import (
	"context"
	"fmt"

	filesconfig "github.com/reina0721/clouddrive/internal/module/files/binding/config"
	"github.com/reina0721/clouddrive/internal/module/files/handler"
	"github.com/reina0721/clouddrive/internal/module/files/repo"
	"github.com/reina0721/clouddrive/internal/module/files/service"
	"github.com/reina0721/clouddrive/pkg/clock"
	"github.com/reina0721/clouddrive/pkg/database"
	"github.com/reina0721/clouddrive/pkg/idgen"
	"github.com/reina0721/clouddrive/pkg/logger"
	"github.com/reina0721/clouddrive/pkg/schedule"
)

type RuntimeContent interface {
	service.Content
	service.BlobObjectProbe
	service.TransferContent
}

type RuntimeAuthority interface {
	service.ArchiveAccountAuthority
	service.DownloadAccountAuthority
	service.ShareAccountAuthority
	service.ConnectionAuthorizer
	handler.BlobReclamationAuthority
	handler.FilesystemSettingsAuthority
	handler.StoragePolicyAuthority
	handler.AdminShareAuthority
	handler.AdminTaskAuthority
}

// RuntimeDependencies 是文件运行装配需要的外部端口及实例资源。
type RuntimeDependencies struct {
	Database        repo.Access
	StorageIdentity string
	StorageBackend  service.StorageBackend
	Content         RuntimeContent
	Authority       RuntimeAuthority
	Authentication  handler.PublicAuthenticator
	Actors          handler.ActorAccess
	Passwords       service.PasscodeHasher
	Clock           clock.Clock
	IDs             idgen.Generator
	Logger          logger.Logger
	PublicOrigins   []string
	TaskEnabled     func(schedule.TaskID) (bool, error)
}

// CheckManagedPaths 在候选发布前确认内容路径及暂存身份，不写入实例数据。
func CheckManagedPaths(ctx context.Context, client database.Client, identity, stagingPath string) (bool, error) {
	staging, err := stagingIdentity(stagingPath)
	if err != nil {
		return false, err
	}
	return repo.CheckManagedPaths(ctx, client, identity, staging)
}

// PrepareRuntime 读取本代文件设置并装配协议服务。启动时准备持久资源，
// 热重载时只读取已经就绪的实例资源。
func PrepareRuntime(ctx context.Context, cfg filesconfig.Config, deps RuntimeDependencies, startup bool) (Module, error) {
	if deps.TaskEnabled == nil {
		return Module{}, fmt.Errorf("files task configuration is missing")
	}
	if startup {
		if err := ValidateStorage(ctx, deps.Database, deps.StorageIdentity, deps.Clock); err != nil {
			return Module{}, err
		}
	}
	transfer := cfg.TransferPolicy()
	storagePolicy, limits, err := PrepareStoragePolicy(ctx, deps.Database, deps.StorageIdentity, deps.Clock,
		deps.StorageBackend, service.StorageLimits{MaxFileBytes: cfg.MaxFileBytes, ChunkBytes: transfer.ChunkBytes})
	if err != nil {
		return Module{}, err
	}
	transfer.ChunkBytes = limits.ChunkBytes
	trash, err := deps.TaskEnabled(service.TrashExpiryTaskID)
	if err != nil {
		return Module{}, err
	}
	blob, err := deps.TaskEnabled(service.BlobReclamationTaskID)
	if err != nil {
		return Module{}, err
	}
	policy := cfg.Policy()
	policy.MaxFileBytes = limits.MaxFileBytes
	nameRules, nameAdmission, err := PrepareStorageNameRules(ctx, deps.Database, deps.StorageIdentity, deps.Clock)
	if err != nil {
		return Module{}, err
	}
	policy.NameAdmission = nameAdmission
	filesystemSettings, active, err := PrepareFilesystemSettings(ctx, deps.Database, deps.StorageIdentity, deps.Clock, service.FilesystemRuntime{
		Policy: policy, Blob: cfg.BlobReclamation, TrashInterval: service.TrashExpiryInterval, TrashScheduled: trash, BlobScheduled: blob,
	})
	if err != nil {
		return Module{}, err
	}
	if startup {
		if err := PrepareTransfers(ctx, deps.Database, deps.StorageIdentity, cfg.Transfers.StagingPath, deps.Clock); err != nil {
			return Module{}, err
		}
		if err := PrepareTorrentNodes(ctx, TorrentPreparation{
			Database: deps.Database, StorageIdentity: deps.StorageIdentity, StagingPath: cfg.Transfers.StagingPath,
			MetadataEntries: policy.SearchTreeEntries, Clock: deps.Clock, Nodes: cfg.Offline.TorrentNodes,
		}); err != nil {
			return Module{}, err
		}
	}
	offline, err := deps.TaskEnabled(service.DownloadDispatchTaskID)
	if err != nil {
		return Module{}, err
	}
	torrent, err := deps.TaskEnabled(service.TorrentDispatchTaskID)
	if err != nil {
		return Module{}, err
	}
	archive, err := deps.TaskEnabled(service.ArchiveDispatchTaskID)
	if err != nil {
		return Module{}, err
	}
	processor, err := NewArchiveProcessor(cfg.Archive, deps.Logger)
	if err != nil {
		return Module{}, err
	}
	active.Blob.Automatic = active.Blob.Automatic && active.BlobScheduled
	return New(Dependencies{
		PublicAuthentication: deps.Authentication, ArchiveProcessor: processor, ArchiveAuthority: deps.Authority, ArchiveDispatcherEnabled: archive,
		ShareAuthority: deps.Authority, SharePolicy: cfg.SharePolicy(), Passwords: deps.Passwords,
		OfflinePolicy: cfg.Offline, OfflineDispatcherEnabled: offline, TorrentDispatcherEnabled: torrent, OfflineAuthority: deps.Authority,
		NavigationPolicy: cfg.NavigationPolicy(), ConnectionOrigin: cfg.Connections.PublicOrigin,
		ConnectionPolicy: cfg.ConnectionPolicy(), ConnectionAuthority: deps.Authority, PublicOrigins: deps.PublicOrigins,
		StorageIdentity: deps.StorageIdentity, Database: deps.Database, Content: deps.Content, BlobProbe: deps.Content,
		TransferContent: deps.Content, TransferPolicy: transfer, StagingPath: cfg.Transfers.StagingPath,
		BlobReclamationPolicy: active.Blob, BlobReclamationAccess: deps.Authority, TrashScanInterval: active.TrashInterval,
		TrashSchedulerEnabled: active.TrashScheduled,
		FilesystemSettings:    filesystemSettings, FilesystemSettingsAccess: deps.Authority,
		StoragePolicy: storagePolicy, StoragePolicyAccess: deps.Authority, StorageNameRules: nameRules,
		AdminShareAccess: deps.Authority, AdminTaskAccess: deps.Authority,
		Clock: deps.Clock, IDs: deps.IDs, Actors: deps.Actors, Logger: deps.Logger, Policy: active.Policy,
	})
}
