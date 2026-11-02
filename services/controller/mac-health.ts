// Mac health check (2026-11-01): a local skill that never sends anything off the machine. Code reads the system's
// own status tools (no network calls, nothing written, no admin rights), applies fixed thresholds, and writes the
// summary, table and advice itself (no model involved, so nothing can be misstated).
// Left out on purpose: software updates (softwareupdate contacts Apple's servers) and Time Machine's last backup
// (tmutil latestbackup tries to mount the backup disk).
import { execFile } from "node:child_process";
import { homedir } from "node:os";

const sh = (cmd: string, args: string[], timeout = 8000) => new Promise<string>((res) =>
  execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: "en_US.UTF-8" } },
    (_e, out) => res(String(out ?? ""))));

export interface Check { item: string; value: string; status: "ok" | "note" | "warn"; advice?: string }

export async function collect(): Promise<Check[]> {
  const [ver, boot, load, ncpu, mem, swap, pressure, df, batt, power, therm, fv, fw, sip, gk, top] = await Promise.all([
    sh("/usr/bin/sw_vers", ["-productVersion"]), sh("/usr/sbin/sysctl", ["-n", "kern.boottime"]), sh("/usr/sbin/sysctl", ["-n", "vm.loadavg"]),
    sh("/usr/sbin/sysctl", ["-n", "hw.ncpu"]), sh("/usr/sbin/sysctl", ["-n", "hw.memsize"]), sh("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    sh("/usr/bin/memory_pressure", ["-Q"]), sh("/bin/df", ["-k", "/System/Volumes/Data"]), sh("/usr/bin/pmset", ["-g", "batt"]),
    sh("/usr/sbin/system_profiler", ["SPPowerDataType"], 15000), sh("/usr/bin/pmset", ["-g", "therm"]), sh("/usr/bin/fdesetup", ["status"]),
    sh("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]), sh("/usr/bin/csrutil", ["status"]), sh("/usr/sbin/spctl", ["--status"]),
    sh("/bin/ps", ["-Aceo", "%cpu,rss,comm", "-r"]),
  ]);
  const out: Check[] = [];
  out.push({ item: "macOS", value: ver.trim() || "?", status: "ok" });
  const bootSec = Number(/sec = (\d+)/.exec(boot)?.[1] ?? 0);
  if (bootSec) {
    const days = (Date.now() / 1000 - bootSec) / 86400;
    out.push({ item: "uptime", value: days < 1 ? `${Math.round(days * 24)} h` : `${days.toFixed(1)} days`, status: days > 14 ? "note" : "ok", advice: days > 14 ? "restart" : undefined });
  }
  const cpus = Number(ncpu) || 1;
  const l = (/\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(load) ?? []).slice(1).map(Number);
  if (l.length) out.push({ item: "cpu_load", value: `${l[0].toFixed(2)} / ${l[1].toFixed(2)} / ${l[2].toFixed(2)} (1/5/15 min, ${cpus} cores)`, status: l[1] > cpus ? "warn" : l[1] > cpus * 0.7 ? "note" : "ok", advice: l[1] > cpus * 0.7 ? "busy" : undefined });
  const memGb = Number(mem) / 1024 ** 3;
  const free = Number(/free percentage: (\d+)%/.exec(pressure)?.[1] ?? NaN);
  if (!Number.isNaN(free)) out.push({ item: "memory", value: `${memGb.toFixed(0)} GB, ${free}% free`, status: free < 10 ? "warn" : free < 25 ? "note" : "ok", advice: free < 25 ? "memory" : undefined });
  const swapMb = Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0);
  out.push({ item: "swap", value: `${(swapMb / 1024).toFixed(1)} GB used`, status: swapMb > 4096 ? "warn" : swapMb > 1024 ? "note" : "ok", advice: swapMb > 1024 ? "memory" : undefined });
  const d = df.trim().split("\n").at(-1)?.split(/\s+/) ?? [];
  if (d.length >= 5) {
    const total = Number(d[1]) / 1024 ** 2, avail = Number(d[3]) / 1024 ** 2, pct = Math.round(100 * (1 - avail / total));
    out.push({ item: "disk", value: `${avail.toFixed(0)} GB free of ${total.toFixed(0)} GB (${pct}% used)`, status: avail < 20 || pct > 90 ? "warn" : avail < 50 || pct > 80 ? "note" : "ok", advice: avail < 50 || pct > 80 ? "disk" : undefined });
  }
  const charge = /(\d+)%;\s*([^;]+);/.exec(batt);
  const cycles = Number(/Cycle Count: (\d+)/.exec(power)?.[1] ?? NaN), cond = /Condition: (.+)/.exec(power)?.[1]?.trim(), maxCap = Number(/Maximum Capacity: (\d+)%/.exec(power)?.[1] ?? NaN);
  if (charge || cond) {
    const bad = (cond && cond !== "Normal") || maxCap < 80;
    out.push({ item: "battery", value: [charge ? `${charge[1]}% (${charge[2].trim()})` : "", Number.isNaN(maxCap) ? "" : `capacity ${maxCap}%`, Number.isNaN(cycles) ? "" : `${cycles} cycles`, cond ? `condition ${cond}` : ""].filter(Boolean).join(", "),
      status: bad ? "warn" : maxCap < 85 ? "note" : "ok", advice: bad || maxCap < 85 ? "battery" : undefined });
  }
  const hot = /(CPU_Speed_Limit\s*=\s*(\d+))/.exec(therm);
  out.push({ item: "thermal", value: hot ? `CPU speed limit ${hot[2]}%` : /No thermal warning/.test(therm) ? "no warning" : "unknown", status: hot && Number(hot[2]) < 100 ? "warn" : "ok", advice: hot && Number(hot[2]) < 100 ? "thermal" : undefined });
  out.push({ item: "filevault", value: /On/.test(fv) ? "on" : /Off/.test(fv) ? "off" : "unknown", status: /Off/.test(fv) ? "warn" : "ok", advice: /Off/.test(fv) ? "filevault" : undefined });
  out.push({ item: "firewall", value: /enabled/.test(fw) ? "on" : /disabled/.test(fw) ? "off" : "unknown", status: /disabled/.test(fw) ? "note" : "ok", advice: /disabled/.test(fw) ? "firewall" : undefined });
  out.push({ item: "sip", value: /enabled/.test(sip) ? "on" : /disabled/.test(sip) ? "off" : "unknown", status: /disabled/.test(sip) ? "warn" : "ok", advice: /disabled/.test(sip) ? "sip" : undefined });
  out.push({ item: "gatekeeper", value: /enabled/.test(gk) ? "on" : /disabled/.test(gk) ? "off" : "unknown", status: /disabled/.test(gk) ? "warn" : "ok", advice: /disabled/.test(gk) ? "gatekeeper" : undefined });
  const procs = top.trim().split("\n").slice(1, 4).map((x) => { const m = /^\s*([\d.]+)\s+(\d+)\s+(.+)$/.exec(x); return m ? `${m[3].trim()} ${Number(m[1]).toFixed(0)}% CPU, ${(Number(m[2]) / 1024 ** 2).toFixed(1)} GB` : ""; }).filter(Boolean);
  if (procs.length) out.push({ item: "top_processes", value: procs.join("; "), status: "ok" });
  return out;
}

const LABEL_KO: Record<string, string> = { macOS: "macOS", uptime: "재시동 후 경과", cpu_load: "CPU 부하", memory: "메모리", swap: "스왑", disk: "저장 공간", battery: "배터리", thermal: "발열", filevault: "FileVault 암호화", firewall: "방화벽", sip: "시스템 무결성 보호", gatekeeper: "Gatekeeper", top_processes: "CPU 상위 프로세스" };
const ADVICE: Record<string, [string, string]> = {
  restart: ["2주 넘게 재시동하지 않았어요. 한 번 재시동하면 메모리와 백그라운드 작업이 정리돼요.", "Up for more than two weeks; a restart clears memory and background work."],
  busy: ["CPU가 바빠요. 상위 프로세스를 확인해 보세요 (활성 상태 보기).", "The CPU is busy; check the top processes (Activity Monitor)."],
  memory: ["메모리 여유가 적거나 스왑을 쓰고 있어요. 안 쓰는 앱과 탭을 닫아 보세요.", "Memory is tight or swap is in use; close unused apps and tabs."],
  disk: ["저장 공간 여유가 적어요. 시스템 설정 > 일반 > 저장 공간에서 큰 항목을 확인해 보세요.", "Disk space is low; see System Settings > General > Storage."],
  battery: ["배터리 성능이 떨어졌어요. 시스템 설정 > 배터리 > 배터리 성능 상태를 확인해 보세요.", "Battery health is reduced; see System Settings > Battery > Battery Health."],
  thermal: ["발열로 CPU 속도가 제한되고 있어요. 환기를 확인하고 무거운 작업을 줄여 보세요.", "The CPU is being slowed for heat; check ventilation and heavy work."],
  filevault: ["디스크 암호화(FileVault)가 꺼져 있어요. 시스템 설정 > 개인정보 보호 및 보안에서 켤 수 있어요.", "FileVault is off; turn it on in System Settings > Privacy & Security."],
  firewall: ["방화벽이 꺼져 있어요. 시스템 설정 > 네트워크 > 방화벽에서 켤 수 있어요.", "The firewall is off; turn it on in System Settings > Network > Firewall."],
  sip: ["시스템 무결성 보호(SIP)가 꺼져 있어요. 의도한 게 아니라면 복구 모드에서 다시 켜세요.", "System Integrity Protection is off; re-enable it from Recovery unless intended."],
  gatekeeper: ["Gatekeeper가 꺼져 있어요. 출처를 확인하지 않은 앱이 실행될 수 있어요.", "Gatekeeper is off; unverified apps can run."],
};

/** Table, summary and advice from the checks, all written by code. An AFM summary was tried and dropped: it
 *  turned "79% used" into "79% available", and a number check cannot catch a reversed meaning. */
export async function macHealthAnswer(ko: boolean): Promise<{ answer: string; detail: string }> {
  const checks = await collect();
  const mark = (s: Check["status"]) => (s === "warn" ? "⚠️" : s === "note" ? "△" : "✓");
  const name = (c: Check) => (ko ? LABEL_KO[c.item] ?? c.item : c.item.replace(/_/g, " "));
  const rows = checks.map((c) => `| ${name(c)} | ${c.value.replace(/\|/g, "\\|")} | ${mark(c.status)} |`);
  const advice = [...new Set(checks.map((c) => c.advice).filter((x): x is string => !!x))].map((a) => `- ${ADVICE[a][ko ? 0 : 1]}`);
  const warn = checks.filter((c) => c.status === "warn"), note = checks.filter((c) => c.status === "note");
  const list = (cs: Check[]) => cs.map(name).join(", ");
  const disk = checks.find((c) => c.item === "disk")?.value, batt = /capacity (\d+)%/.exec(checks.find((c) => c.item === "battery")?.value ?? "")?.[1];
  const key = ko ? [disk ? `저장 공간 ${disk.replace(/ GB free of (\d+) GB \((\d+)% used\)/, " GB 남음 (전체 $1 GB 중 $2% 사용)")}` : "", batt ? `배터리 최대 용량 ${batt}%` : ""].filter(Boolean).join(", ")
    : [disk ? `disk ${disk}` : "", batt ? `battery capacity ${batt}%` : ""].filter(Boolean).join(", ");
  const summary = ko
    ? `${warn.length ? `확인이 필요한 항목: ${list(warn)}.` : note.length ? `큰 문제는 없고, 참고할 항목: ${list(note)}.` : "모든 항목이 정상이에요."}${key ? ` ${key}.` : ""}`
    : `${warn.length ? `Needs attention: ${list(warn)}.` : note.length ? `Nothing serious; to note: ${list(note)}.` : "Everything looks normal."}${key ? ` ${key[0].toUpperCase()}${key.slice(1)}.` : ""}`;
  const answer = `${summary}\n\n| ${ko ? "항목 | 값 | 상태" : "Check | Value | Status"} |\n|---|---|---|\n${rows.join("\n")}${advice.length ? `\n\n**${ko ? "권장" : "Suggestions"}**\n${advice.join("\n")}` : ""}\n\n_${ko ? "이 Mac의 시스템 도구로만 확인했고, 외부로 보낸 데이터는 없어요." : "Checked with this Mac's own system tools; nothing was sent off the machine."}_`;
  return { answer, detail: `${warn.length} warn, ${note.length} note` };
}
