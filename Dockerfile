FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy the built package (npm pack name for a scoped package is
# "<scope-without-@>-code-agent-<version>.tgz", e.g. zhouronghua-code-agent-0.3.36.tgz)
COPY *code-agent-*.tgz /tmp/

# Install globally from the tarball
RUN npm install -g /tmp/*code-agent-*.tgz && \
    rm /tmp/*code-agent-*.tgz

# Verify installation
RUN which code-agent && code-agent --help || true

ENTRYPOINT ["code-agent"]
