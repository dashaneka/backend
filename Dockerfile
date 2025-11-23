FROM node:18-slim

# Update package lists and install dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    wget \
    curl \
    ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp using pip
RUN pip3 install --no-cache-dir yt-dlp --break-system-packages

# Verify installations
RUN yt-dlp --version && ffmpeg -version

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy source code
COPY . .

# Create temp directory
RUN mkdir -p temp

# Expose port
EXPOSE 3001

# Start the server
CMD ["npm", "start"]
