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
    console.log(borderTop);
    console.log(`${colors.fgGreen}│${colors.reset}  ${message}`);
    console.log(`${colors.fgGreen}└${"─".repeat(boxWidth - 1)}${colors.reset}`);
  },

  warn(message: string, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ WARN ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgYellow}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;
    console.log(borderTop);
    console.log(`${colors.fgYellow}│${colors.reset}  ${message}`);
    console.log(`${colors.fgYellow}└${"─".repeat(boxWidth - 1)}${colors.reset}`);
  },

  error(message: string, error?: any, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ ERROR ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgRed}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;
    console.log(borderTop);
    console.log(`${colors.fgRed}│${colors.reset}  ${colors.bright}${message}${colors.reset}`);
    if (error) {
      const errStr = error.stack || String(error);
      const lines = errStr.split("\n");
      for (const line of lines) {
        console.log(`${colors.fgRed}│${colors.reset}  ${colors.fgGray}${line}${colors.reset}`);
      }
    }
    console.log(`${colors.fgRed}└${"─".repeat(boxWidth - 1)}${colors.reset}`);
  },

  debug(message: string, context = "APP") {
    const timestamp = getTimestamp();
    const header = `[ ${timestamp} ] [ ${context} ] [ DEBUG ]`;
    const boxWidth = 85;
    const borderTop = `${colors.fgBlue}┌── ${header} ${"─".repeat(Math.max(0, boxWidth - header.length - 5))}${colors.reset}`;
    console.log(borderTop);
    console.log(`${colors.fgBlue}│${colors.reset}  ${message}`);
    console.log(`${colors.fgBlue}└${"─".repeat(boxWidth - 1)}${colors.reset}`);
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

    console.log(borderTop);
    console.log(`${color}│${colors.reset}  ${colors.bright}Method:${colors.reset} ${data.method}`);
    console.log(`${color}│${colors.reset}  ${colors.bright}Request:${colors.reset} ${data.url}`);
    
    let statusColor = colors.fgGreen;
    if (isError) statusColor = colors.fgRed;
    else if (isWarn) statusColor = colors.fgYellow;

    console.log(
      `${color}│${colors.reset}  ${colors.bright}Status:${colors.reset} ${statusColor}${data.status}${colors.reset}  |  ${colors.bright}Duration:${colors.reset} ${data.duration}ms`
    );

    if (data.error) {
      const errStr = data.error.stack || String(data.error);
      const lines = errStr.split("\n");
      for (const line of lines) {
        console.log(`${color}│${colors.reset}  ${colors.fgGray}${line}${colors.reset}`);
      }
    }

    console.log(`${color}└${"─".repeat(boxWidth - 1)}${color}${colors.reset}`);
  },
};
