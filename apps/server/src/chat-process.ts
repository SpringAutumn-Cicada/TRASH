import { readFileSync, readdirSync } from "node:fs";

export type ChatProcess = { boot: string; group: number };

function bootId() {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function processGroup(pid: number | string) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

export function chatProcess(pid?: number): ChatProcess | undefined {
  if (process.platform !== "linux" || !pid || pid < 2) return undefined;
  try { return { boot: bootId(), group: pid }; }
  catch { return undefined; }
}

export function chatProcessesExited(processes: (ChatProcess | null)[]): boolean {
  if (process.platform !== "linux" || !processes.length || processes.some(process => !process)) return false;
  try {
    const boot = bootId();
    const groups = new Set(processes.flatMap(process => process?.boot === boot ? [process.group] : []));
    if (!groups.size) return true;
    for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
      try { if (groups.has(processGroup(pid))) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    return true;
  } catch { return false; }
}
