export function compatibleEnv(name, current, legacy) {
  if (current !== undefined && legacy !== undefined && current !== legacy)
    throw new Error(`${name} conflicts with its legacy environment variable.`);
  return current ?? legacy;
}

export function readNeoCloudEnv(suffix, environment = process.env) {
  const name = `NEOCLOUD_${suffix}`;
  return compatibleEnv(name, environment[name], environment[`CLOUDDRIVE_${suffix}`]);
}
