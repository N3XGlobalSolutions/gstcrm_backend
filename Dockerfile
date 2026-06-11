# Stage 1: Build & Dependencies
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for tsx/typescript execution)
RUN npm install

# Copy the rest of the application files
COPY . .

# Stage 2: Production Runtime
FROM node:20-alpine

WORKDIR /app

# Copy from builder
COPY --from=builder /app /app

# Set production environment variables (can be overridden in docker-compose)
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Run database migrations and then start the backend server
CMD ["sh", "-c", "npm run db:migrate && npm start"]
