export type RuntimeEnvReader = (name: string) => string | undefined;

export function readRequiredEnv(
  name: string,
  read: RuntimeEnvReader,
): string {
  const value = read(name)?.trim();
  if (!value) {
    throw new Error(`missing_env:${name}`);
  }
  return value;
}
