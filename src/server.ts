import app from "./app";
import dotenv from "dotenv";
import { logger } from "./lib/logger";

dotenv.config();

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info(`Server started successfully on port ${PORT}`, "STARTUP");
});
