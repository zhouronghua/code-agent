FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy the built package
COPY code-agent-*.tgz /tmp/

# Install globally from the tarball
RUN npm install -g /tmp/code-agent-*.tgz && \
    rm /tmp/code-agent-*.tgz

# Verify installation
RUN which code-agent && code-agent --help || true

ENTRYPOINT ["code-agent"]
