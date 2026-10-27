# Build stage
FROM valkama.saunalahti.fi/image/node:24-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src/ ./src/

# Build the project
RUN npm run build

# Runtime stage
FROM valkama.saunalahti.fi/image/node:24-alpine AS runner
RUN apk update && apk upgrade && apk add sqlite
WORKDIR /app
# Copy built files from builder stage
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules

# Environment variables
ENV TRANSPORT_TYPE=HTTP
ENV HOST=0.0.0.0
ENV PORT=3838

# Set the entrypoint
ENTRYPOINT ["node", "build/index.js"]
