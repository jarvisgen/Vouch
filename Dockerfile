# Backend image for Render. Installs pnpm inside a writable image layer, so Render never
# runs its own corepack against the read-only /usr/bin (the source of the EROFS error).
FROM node:20-slim
WORKDIR /app
ENV CI=true

# pnpm via npm (writable global prefix in the image)
RUN npm install -g pnpm@9

# install only the agents package + its deps (web package.json is present for workspace resolution)
COPY . .
RUN pnpm install --no-frozen-lockfile --filter "@vouch/agents..."

EXPOSE 8787
# server binds process.env.PORT (Render injects it) or 8787
CMD ["pnpm", "--filter", "@vouch/agents", "serve"]
