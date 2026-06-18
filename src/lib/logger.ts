import fs from "fs";
import path from "path";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  fgRed: "\x1b[31m",
  fgGreen: "\x1b[32m",
  fgYellow: "\x1b[33m",
  fgBlue: "\x1b[34m",
  fgMagenta: "\x1b[35m",
  fgCyan: "\x1b[36m",
  fgGray: "\x1b[90m",
};

const LOGS_DIR = path.join(process.cwd(), "logs");

function stripAnsi(str: string): string {
  return str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}

function writeLog(lines: string[]) {
  // 1. Output to appropriate console stream
  for (const line of lines) {
    if (line.includes("[ERROR]") || line.includes("│  Error:") || line.includes("Unhandled server error")) {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  // 2. Append cleanly to daily log file
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    const dateStr = new Date().toISOString().split("T")[0];
    const logFilePath = path.join(LOGS_DIR, `${dateStr}.log`);
    const cleanContent = lines.map((l) => stripAnsi(l)).join("\n") + "\n\n";
    fs.appendFileSync(logFilePath, cleanContent, "utf8");
  } catch (err) {
    console.error("Failed to write to daily log file:", err);
  }
}

function getTimestamp(): string {
  const now = new Date();
  const date = now.toISOString().split("T")[0] || "";
  const time = now.toTimeString().split(" ")[0] || "";
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `Date: ${date} | Time: ${time}.${ms}`;
}

export const logger = {
  info(message: string, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ INFO ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgGreen}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;

    const lines = [
      borderTop,
      `${colors.fgGreen}│${colors.reset}  ${message}`,
      `${colors.fgGreen}└${"─".repeat(boxWidth - 1)}${colors.reset}`,
    ];
    writeLog(lines);
  },

  warn(message: string, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ WARN ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgYellow}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;

    const lines = [
      borderTop,
      `${colors.fgYellow}│${colors.reset}  ${message}`,
      `${colors.fgYellow}└${"─".repeat(boxWidth - 1)}${colors.reset}`,
    ];
    writeLog(lines);
  },

  error(message: string, error?: any, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ ERROR ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgRed}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;

    const lines = [
      borderTop,
      `${colors.fgRed}│${colors.reset}  ${colors.bright}${message}${colors.reset}`,
    ];

    if (error) {
      const errStr = error.stack || String(error);
      const errLines = errStr.split("\n");
      for (const line of errLines) {
        lines.push(`${colors.fgRed}│${colors.reset}  ${colors.fgGray}${line}${colors.reset}`);
      }
    }

    lines.push(`${colors.fgRed}└${"─".repeat(boxWidth - 1)}${colors.reset}`);
    writeLog(lines);
  },

  debug(message: string, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ DEBUG ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgBlue}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;

    const lines = [
      borderTop,
      `${colors.fgBlue}│${colors.reset}  ${message}`,
      `${colors.fgBlue}└${"─".repeat(boxWidth - 1)}${colors.reset}`,
    ];
    writeLog(lines);
  },

  logRequest(data: {
    type: string;
    method: string;
    url: string;
    status: number;
    duration: number;
    error?: any;
  }) {
    const timestamp = getTimestamp();
    const isError = data.status >= 500;
    const isWarn = data.status >= 400 && data.status < 500;

    let color = colors.fgGreen;
    let title = "SUCCESS";
    if (isError) {
      color = colors.fgRed;
      title = "ERROR";
    } else if (isWarn) {
      color = colors.fgYellow;
      title = "WARNING";
    }

    const boxWidth = 85;
    const header = `[ ${timestamp} ] [ ${data.type} ] [ ${title} ]`;
    const borderTop = `${color}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;

    const lines = [
      borderTop,
      `${color}│${colors.reset}  ${colors.bright}Method:${colors.reset} ${data.method}`,
      `${color}│${colors.reset}  ${colors.bright}Request:${colors.reset} ${data.url}`,
    ];

    let statusColor = colors.fgGreen;
    if (isError) statusColor = colors.fgRed;
    else if (isWarn) statusColor = colors.fgYellow;

    lines.push(
      `${color}│${colors.reset}  ${colors.bright}Status:${colors.reset} ${statusColor}${data.status}${colors.reset}  |  ${colors.bright}Duration:${colors.reset} ${data.duration}ms`
    );

    if (data.error) {
      const errStr = data.error.stack || String(data.error);
      const errLines = errStr.split("\n");
      for (const line of errLines) {
        lines.push(`${color}│${colors.reset}  ${colors.fgGray}${line}${colors.reset}`);
      }
    }

    lines.push(`${color}└${"─".repeat(boxWidth - 1)}${colors.reset}`);
    writeLog(lines);
  },
};
