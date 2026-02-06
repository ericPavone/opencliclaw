import { runExec } from "../process/exec.js";

export type ExecFn = typeof runExec;

export type WindowsAclEntry = {
  principal: string;
  rights: string[];
  rawRights: string;
  canRead: boolean;
  canWrite: boolean;
};

export type WindowsAclSummary = {
  ok: boolean;
  entries: WindowsAclEntry[];
  untrustedWorld: WindowsAclEntry[];
  untrustedGroup: WindowsAclEntry[];
  trusted: WindowsAclEntry[];
  error?: string;
};

// Stubs — Windows ACL code removed (Linux/Mac only fork).
// These functions are only called behind `platform === "win32"` guards.

export function resolveWindowsUserPrincipal(_env?: NodeJS.ProcessEnv): string | null {
  return null;
}

export function parseIcaclsOutput(_output: string, _targetPath: string): WindowsAclEntry[] {
  return [];
}

export function summarizeWindowsAcl(
  _entries: WindowsAclEntry[],
  _env?: NodeJS.ProcessEnv,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
  return { trusted: [], untrustedWorld: [], untrustedGroup: [] };
}

export async function inspectWindowsAcl(
  _targetPath: string,
  _opts?: { env?: NodeJS.ProcessEnv; exec?: ExecFn },
): Promise<WindowsAclSummary> {
  return {
    ok: false,
    entries: [],
    trusted: [],
    untrustedWorld: [],
    untrustedGroup: [],
    error: "Windows ACL not supported",
  };
}

export function formatWindowsAclSummary(_summary: WindowsAclSummary): string {
  return "unknown";
}

export function formatIcaclsResetCommand(
  _targetPath: string,
  _opts: { isDir: boolean; env?: NodeJS.ProcessEnv },
): string {
  return "";
}

export function createIcaclsResetCommand(
  _targetPath: string,
  _opts: { isDir: boolean; env?: NodeJS.ProcessEnv },
): { command: string; args: string[]; display: string } | null {
  return null;
}
