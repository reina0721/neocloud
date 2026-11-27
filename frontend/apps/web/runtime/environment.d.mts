export function compatibleEnv(
  name: string,
  current: string | undefined,
  legacy: string | undefined,
): string | undefined;

export function readNeoCloudEnv(
  suffix: string,
  environment?: Readonly<Record<string, string | undefined>>,
): string | undefined;
