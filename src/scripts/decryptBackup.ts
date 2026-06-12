import fs from "fs";
import crypto from "crypto";
import path from "path";

function decryptBackup() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: bun run src/scripts/decryptBackup.ts <password> <path_to_backup_file>");
    process.exit(1);
  }

  const password = args[0] as string;
  const filePath = path.resolve(args[1] as string);

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    const parts = fileContent.split(":");
    
    if (parts.length !== 3) {
      console.error("Invalid encrypted backup format. Expected 'salt:iv:encrypted_data'.");
      process.exit(1);
    }

    const [saltHex, ivHex, encryptedHex] = parts;
    const salt = Buffer.from(saltHex as string, "hex");
    const iv = Buffer.from(ivHex as string, "hex");
    
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    
    let decrypted: string = decipher.update(encryptedHex as string, "hex", "utf8");
    decrypted += decipher.final("utf8");

    const outPath = filePath.replace(".enc", "");
    fs.writeFileSync(outPath, decrypted, "utf8");

    console.log(`✅ Successfully decrypted backup! Saved to:\n${outPath}`);
  } catch (error: any) {
    console.error("❌ Decryption failed. Incorrect password or corrupted file.");
    console.error(error.message);
    process.exit(1);
  }
}

decryptBackup();
