FROM node:22.20.0-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
ARG VITE_SUPABASE_URL=http://localhost:54321
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
COPY . .
RUN pnpm build

FROM node:22.20.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4317
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps ./apps
COPY --from=build /app/api ./api
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
EXPOSE 4317
CMD ["./node_modules/.bin/tsx", "apps/server/index.ts"]
