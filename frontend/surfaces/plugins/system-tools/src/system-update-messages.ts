export const systemUpdateMessages = {
  'zh-CN': {
    translation: {
      systemUpdate: {
        title: '系统更新',
        description: '查看当前服务版本和此实例的更新方式。',
        version: '当前版本',
        versionUnavailable: '无法读取当前运行的服务版本。',
        operations: '更新与恢复',
        accessHint: '需要系统管理的查看权限才能读取版本与更新状态。',
        disabled: '更新操作已禁用',
        statusUnavailable: '维护状态读取失败，请重试。',
        status: {
          'windows-development':
            '当前为 Windows 本地开发环境。网页更新依赖 Linux + Docker 正式发布实例的宿主维护服务，当前环境无法执行。',
          development:
            '当前为本地开发环境。网页更新需要启用宿主维护服务的 Linux + Docker 正式发布实例。',
          'gateway-unavailable':
            '此实例未启用网页维护网关。Linux + Docker 正式发布实例可在宿主机启用网页运维。',
          'owner-required':
            '此实例已启用网页维护。检查正式版、升级、回退和恢复需要系统所有者权限。',
          'owner-verified': '系统所有者可在维护页检查正式版、升级、回退和恢复。',
        },
        open: '打开维护页',
        check: '检查更新',
        upgrade: '升级',
        rollback: '回退',
        restore: '恢复',
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
        operations: 'Updates and recovery',
        accessHint:
          'View access to system management is required to read the version and update status.',
        disabled: 'Update actions are disabled',
        statusUnavailable: 'Could not read maintenance status. Try again.',
        status: {
          'windows-development':
            'This instance is running in a local Windows development environment. Web updates require the host maintenance service of a Linux + Docker release deployment.',
          development:
            'This instance is running in a local development environment. Web updates require a Linux + Docker release deployment with host maintenance enabled.',
          'gateway-unavailable':
            'The web maintenance gateway is disabled for this instance. Web maintenance can be enabled on the host of a Linux + Docker release deployment.',
          'owner-required':
            'Web maintenance is enabled. Checking releases, upgrading, rolling back, and restoring require system owner permissions.',
          'owner-verified':
            'The system owner can check releases, upgrade, roll back, and restore from the maintenance page.',
        },
        open: 'Open maintenance page',
        check: 'Check for updates',
        upgrade: 'Upgrade',
        rollback: 'Roll back',
        restore: 'Restore',
      },
    },
  },
} as const;
