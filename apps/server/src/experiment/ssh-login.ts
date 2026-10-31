import { z } from "zod";
import { experimentError } from "@trash/storage";
import { sshProfileInputSchema } from "@trash/protocol";

export const sshLoginInputSchema = z.object({ name: z.string().trim().max(500).default(""), command: z.string().trim().min(1).max(2048), password: z.string().min(1).max(10000) }).strict();

// Parse only connection parameters. Never execute or forward the supplied command.
export function parseSshLogin(command: string) {
  if (Array.from(command).some(char => char.charCodeAt(0) < 32 && char !== "\t")) experimentError("SSH_LOGIN_COMMAND_INVALID");
  const tokens = command.trim().split(/\s+/);
  if (tokens.shift() !== "ssh") experimentError("SSH_LOGIN_COMMAND_INVALID");
  let port = 22, portSeen = false, destination = "";
  while (tokens.length) {
    const token = tokens.shift()!;
    if (token === "-p" || /^-p\d+$/.test(token)) {
      if (portSeen) experimentError("SSH_LOGIN_COMMAND_INVALID");
      const value = token === "-p" ? tokens.shift() : token.slice(2);
      if (!value || !/^\d+$/.test(value)) experimentError("SSH_LOGIN_COMMAND_INVALID");
      port = Number(value); portSeen = true;
    } else {
      if (destination || !/^[A-Za-z0-9_.-]+@(?:[A-Za-z0-9.:-]+|\[[A-Fa-f0-9:]+\])$/.test(token)) experimentError("SSH_LOGIN_COMMAND_INVALID");
      destination = token;
    }
  }
  if (!destination || !Number.isInteger(port) || port < 1 || port > 65535) experimentError("SSH_LOGIN_COMMAND_INVALID");
  const [username, rawHost] = destination.split("@");
  const host = rawHost.replace(/^\[|\]$/g, "");
  return sshProfileInputSchema.parse({ name: `AutoDL · ${host}:${port}`, host, port, username, auth: "password", remote_root: username === "root" ? "/root/autodl-tmp/trash" : `/home/${username}/autodl-tmp/trash` });
}
