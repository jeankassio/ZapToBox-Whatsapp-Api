/** Components are shared by URLs, database keys and session paths. */
export function validateIdentity(value: unknown, label = 'identity'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || value.trim() !== value
      || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..'
      || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function instanceKey(owner: string, instanceName: string): string {
  return `${validateIdentity(owner, 'owner')}/${validateIdentity(instanceName, 'instanceName')}`;
}

export function splitInstanceKey(key: string): { owner: string; instanceName: string } {
  const parts = key.split('/');
  if (parts.length !== 2) throw new Error('Invalid instance key');
  return { owner: validateIdentity(parts[0], 'owner'), instanceName: validateIdentity(parts[1], 'instanceName') };
}
