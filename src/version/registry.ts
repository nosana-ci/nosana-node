/** The package's dist-tags (`latest`, `next`, ...) as the npm registry has them. */
export async function fetchDistTags(
  name: string,
): Promise<Record<string, string> | undefined> {
  const response = await fetch(`https://registry.npmjs.com/${name}`);
  const json = await response.json();
  return json['dist-tags'];
}
