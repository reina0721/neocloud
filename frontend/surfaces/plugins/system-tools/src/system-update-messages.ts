export const systemUpdateMessages = {
  'zh-CN': {
    translation: {
      systemUpdate: {
        title: '系统更新',
        description: '查看当前服务版本和此实例的更新方式。',
        version: '当前版本',
        versionUnavailable: '无法读取当前运行的服务版本。',
        operations: '实例维护',
        accessHint: '需要系统管理的查看权限才能读取版本与更新状态。',
        disabled: '实例维护操作已禁用',
        statusUnavailable: '维护状态读取失败，请重试。',
        status: {
          'windows-development':
            '当前为 Windows 本地开发环境。Go 和 Web Host 由开发进程启动，尚未接入负责停服、替换、迁移和恢复的维护执行器。',
          development:
            '当前为本地开发环境。Go 和 Web Host 由开发进程启动，尚未接入负责停服、替换、迁移和恢复的维护执行器。',
          'gateway-unavailable':
            '此实例未接入网页更新执行器。原生整包由 Go 宿主启动后，可在此页升级和回退。',
          'owner-required': '升级和回退需要系统所有者权限。',
          'owner-verified': '系统所有者可在维护页升级、回退和恢复。',
        },
        open: '打开维护页',
        upgrade: '升级',
        rollback: '回退',
        restore: '恢复',
        native: {
          versions: 'Go {{go}} · Web {{web}}',
          cancel: '取消更新',
          dismiss: '返回',
          noRollback: '当前没有可用的兼容整包回退版本。',
          noUpdate: '没有较新的兼容整包',
          submitFailed: '请求未确认。请先查看当前任务，再决定是否重试。',
          confirm: {
            apply: '下载并验签兼容的正式整包，再一起切换 Go 和 Web。交接期间部分请求可能短暂等待。',
            rollback: '将 Go 和 Web 一起切换到上一兼容版本，保留文件和已提交的数据。',
            cancel: '请求取消尚未进入交接阶段的更新任务。',
          },
          phases: {
            preparing: '正在下载和验证整包',
            migrating: '正在备份并执行兼容迁移',
            handoff: '正在交接服务',
            committed: '新版已登记，正在确认服务',
            succeeded: '更新任务已完成',
            canceled: '任务已取消',
            failed: '任务失败，可查看本机更新状态',
            interrupted: '任务中断，可重试',
          },
        },
        release: {
          title: 'GitHub 正式版',
          check: '检查 GitHub 正式版',
          open: '在 GitHub 查看发布页',
          loading: '正在查询 GitHub 正式版…',
          latest: '最新正式版 {{version}}',
          notes: '发布说明',
          noNotes: '此版本没有发布说明。',
          assets: '下载附件',
          noAssets: '此版本没有可列出的发布附件。',
          windowsBackend: '仅 Go 后端，不含 Web Host',
          managedFull: '原生 Go 与 Web 整包',
          errors: {
            unavailable: '暂时无法查询 GitHub 正式版，请重试。',
            'rate-limited': 'GitHub 查询次数暂时受限，请稍后重试。',
            'no-release': 'GitHub 未返回已发布的正式版。',
            timeout: 'GitHub 正式版查询超时，请重试。',
            unauthenticated: '登录已失效，请重新登录后再查询。',
            forbidden: '当前账号没有查询正式版所需的系统管理查看权限。',
          },
        },
      },
    },
  },
  en: {
    translation: {
      systemUpdate: {
        title: 'System Update',
        description: 'View the running service version and update options for this instance.',
        version: 'Current version',
        versionUnavailable: 'Could not read the version of the running service.',
        operations: 'Instance maintenance',
        accessHint:
          'View access to system management is required to read the version and update status.',
        disabled: 'Instance maintenance actions are disabled',
        statusUnavailable: 'Could not read maintenance status. Try again.',
        status: {
          'windows-development':
            'This instance is running in a local Windows development environment. The Go and Web Host development processes have no maintenance runner to stop services, replace builds, migrate data, or restore backups.',
          development:
            'This instance is running in a local development environment. The Go and Web Host development processes have no maintenance runner to stop services, replace builds, migrate data, or restore backups.',
          'gateway-unavailable':
            'This instance has no web update runner. Start the native release with its Go host to upgrade or roll back here.',
          'owner-required': 'Upgrading and rolling back require system owner permissions.',
          'owner-verified':
            'The system owner can upgrade, roll back, and restore from the maintenance page.',
        },
        open: 'Open maintenance page',
        upgrade: 'Upgrade',
        rollback: 'Roll back',
        restore: 'Restore',
        native: {
          versions: 'Go {{go}} · Web {{web}}',
          cancel: 'Cancel update',
          dismiss: 'Go back',
          noRollback: 'No compatible complete release is available for rollback.',
          noUpdate: 'No newer compatible release',
          submitFailed: 'The request was not confirmed. Check the current task before retrying.',
          confirm: {
            apply:
              'Download and verify a compatible release, then switch Go and Web together. Some requests may wait briefly during handoff.',
            rollback:
              'Switch Go and Web to the previous compatible release, keeping files and committed data.',
            cancel: 'Request cancellation before handoff begins.',
          },
          phases: {
            preparing: 'Downloading and verifying the release',
            migrating: 'Creating a backup and applying compatible migrations',
            handoff: 'Switching services',
            committed: 'Version committed, confirming service',
            succeeded: 'Update task completed',
            canceled: 'Update canceled',
            failed: 'Update failed, check local status for details',
            interrupted: 'Update interrupted, retry available',
          },
        },
        release: {
          title: 'GitHub releases',
          check: 'Check GitHub releases',
          open: 'View release on GitHub',
          loading: 'Checking GitHub releases…',
          latest: 'Latest stable release {{version}}',
          notes: 'Release notes',
          noNotes: 'This release has no notes.',
          assets: 'Downloads',
          noAssets: 'This release has no available attachments to list.',
          windowsBackend: 'Go backend only, Web Host not included',
          managedFull: 'Native Go and Web release',
          errors: {
            unavailable: 'Could not check GitHub releases. Try again.',
            'rate-limited': 'GitHub has temporarily rate-limited release checks. Try again later.',
            'no-release': 'GitHub did not return a published stable release.',
            timeout: 'The GitHub release check timed out. Try again.',
            unauthenticated: 'Your session has expired. Sign in to check again.',
            forbidden: 'You need view access to system management to check releases.',
          },
        },
      },
    },
  },
} as const;
