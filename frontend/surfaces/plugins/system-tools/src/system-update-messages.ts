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
            '此实例未启用网页维护网关。Linux + Docker 正式发布实例可在宿主机启用网页运维。',
          'owner-required': '此实例已启用网页维护。升级、回退和恢复需要系统所有者权限。',
          'owner-verified': '系统所有者可在维护页升级、回退和恢复。',
        },
        open: '打开维护页',
        upgrade: '升级',
        rollback: '回退',
        restore: '恢复',
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
            'The web maintenance gateway is disabled for this instance. Web maintenance can be enabled on the host of a Linux + Docker release deployment.',
          'owner-required':
            'Web maintenance is enabled. Upgrading, rolling back, and restoring require system owner permissions.',
          'owner-verified':
            'The system owner can upgrade, roll back, and restore from the maintenance page.',
        },
        open: 'Open maintenance page',
        upgrade: 'Upgrade',
        rollback: 'Roll back',
        restore: 'Restore',
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
