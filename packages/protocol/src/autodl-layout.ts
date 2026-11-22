export const autoDLDirectories = {
  data: "data",
  code: "code",
  paperCode: "code/papers",
  reproductionCode: "code/reproductions",
  outputs: "outputs",
  paperOutputs: "outputs/papers",
  reproductionOutputs: "outputs/reproductions"
} as const;

export function autoDLPath(root: string, ...parts: string[]): string {
  return [root.replace(/\/+$/, ""), ...parts].join("/");
}

export function remoteDirectoryLabel(name: string): string {
  const value = name.normalize("NFKC").replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^[._-]+|[._-]+$/g, "");
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const char of value) {
    bytes += encoder.encode(char).length;
    if (bytes > 180) break;
    result += char;
  }
  return result || "project";
}

export function autoDLPaperDirectory(repository: { path: string; repository_id: string }): string {
  const path = repository.path.replace(/\/+$/, "");
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (/(?:^|\/)code\/papers\/[^/]+$/.test(path) &&
      basename !== "." && basename !== ".." &&
      !basename.includes("\\") && Array.from(basename).every(char => char.charCodeAt(0) >= 32) &&
      new TextEncoder().encode(basename).length <= 180) return basename;
  return `${remoteDirectoryLabel(basename)}--${repository.repository_id}`;
}

export function autoDLReproductionDirectory(name: string, id: string): string {
  return `${remoteDirectoryLabel(name)}--${id}`;
}
